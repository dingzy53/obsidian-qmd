import { ChildProcess } from 'child_process';
import * as http from 'http';
import { QmdSettings } from '../types';
import { QmdRunner, stripAnsi } from './runner';

export type ServerState = 'stopped' | 'starting' | 'ready' | 'failed';

const PORT_ATTEMPTS = 6;
const LOG_LINES = 50;
const MAX_AUTO_RESTARTS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function alive(child: ChildProcess): boolean {
	return child.exitCode === null && child.signalCode === null;
}

/**
 * Owns one `qmd mcp --http` process for the project index, so the models stay loaded
 * between searches. Only ever talks to a server it started itself.
 */
export class QmdServer {
	state: ServerState = 'stopped';
	port = 0;
	readonly log: string[] = [];

	private child: ChildProcess | null = null;
	private wanted = false;
	private launching: Promise<void> | null = null;
	private autoRestarts = 0;
	private readySince = 0;
	private restartTimer: number | null = null;
	private listeners = new Set<() => void>();

	constructor(private runner: QmdRunner, private getSettings: () => QmdSettings) {}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private setState(state: ServerState): void {
		if (this.state === state) return;
		this.state = state;
		this.listeners.forEach((fn) => fn());
	}

	private note(line: string): void {
		this.log.push(line);
		if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
	}

	async start(): Promise<void> {
		if (!this.getSettings().serverEnabled || this.runner.problem) return;
		this.wanted = true;
		if (this.state === 'ready') return;
		this.launching ??= this.launch().finally(() => {
			this.launching = null;
		});
		return this.launching;
	}

	async stop(): Promise<void> {
		this.wanted = false;
		if (this.restartTimer !== null) window.clearTimeout(this.restartTimer);
		this.restartTimer = null;
		const child = this.child;
		this.child = null;
		if (child && alive(child)) {
			const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
			this.runner.kill(child);
			await Promise.race([exited, sleep(3000)]);
			if (alive(child)) child.kill('SIGKILL');
		}
		await this.launching?.catch(() => undefined);
		// The server closes its database after the launcher has gone; wait until the port
		// is really free, so a restart never overlaps with (or mistakes) the old process.
		for (let i = 0; i < 40 && this.port && (await this.healthy(this.port)); i++) await sleep(125);
		this.setState('stopped');
	}

	async restart(): Promise<void> {
		await this.stop();
		this.autoRestarts = 0;
		await this.start();
	}

	private async launch(): Promise<void> {
		this.setState('starting');
		const base = this.getSettings().serverPort;
		for (let port = base; port < base + PORT_ATTEMPTS && this.wanted; port++) {
			// Never adopt a server we did not start: it may be serving a different index.
			if (await this.healthy(port)) {
				this.note(`port ${port} is taken by another server, trying ${port + 1}`);
				continue;
			}
			const outcome = await this.spawnOn(port);
			if (outcome === 'ready' || outcome === 'stopped') return;
			if (outcome === 'failed') break;
		}
		if (this.wanted) this.setState('failed');
	}

	private async spawnOn(port: number): Promise<'ready' | 'busy' | 'failed' | 'stopped'> {
		let child: ChildProcess;
		try {
			child = await this.runner.spawn(['mcp', '--http', '--port', String(port)], { watchBus: true });
		} catch (e) {
			this.note(e instanceof Error ? e.message : String(e));
			return 'failed';
		}
		this.child = child;
		let portBusy = false;
		// The server logs every request; the pipes must be read or they fill up and block it.
		const drain = (data: Buffer) => {
			for (const line of stripAnsi(data.toString('utf8')).split('\n')) {
				if (!line.trim()) continue;
				if (line.includes('already in use')) portBusy = true;
				this.note(line.trim());
			}
		};
		child.stdout?.on('data', drain);
		child.stderr?.on('data', drain);
		child.on('error', (e) => this.note(`spawn error: ${e.message}`));
		child.on('exit', (code, signal) => this.onExit(child, code, signal));

		const deadline = Date.now() + 30000;
		while (Date.now() < deadline && alive(child) && this.wanted) {
			if (await this.healthy(port)) {
				if (!alive(child)) break; // someone else answered on this port
				this.port = port;
				this.readySince = Date.now();
				this.setState('ready');
				void this.warmUp();
				return 'ready';
			}
			await sleep(250);
		}
		// Also covers stop() racing the spawn above, when it could not see this child yet.
		this.runner.kill(child);
		if (this.child === child) this.child = null;
		if (!this.wanted) return 'stopped';
		return portBusy ? 'busy' : 'failed';
	}

	private onExit(child: ChildProcess, code: number | null, signal: string | null): void {
		if (this.child !== child) return;
		this.child = null;
		if (this.state !== 'ready' || !this.wanted) return;

		this.note(`server exited (${signal ?? code})`);
		if (Date.now() - this.readySince > 5 * 60 * 1000) this.autoRestarts = 0;
		if (this.autoRestarts >= MAX_AUTO_RESTARTS) {
			this.setState('failed');
			return;
		}
		this.setState('starting');
		const delay = 1000 * 2 ** this.autoRestarts++;
		this.restartTimer = window.setTimeout(() => {
			this.restartTimer = null;
			void this.start();
		}, delay);
	}

	private async healthy(port: number): Promise<boolean> {
		try {
			const res = await this.request<{ status?: string }>('GET', '/health', undefined, undefined, 800, port);
			return res.status === 'ok';
		} catch {
			return false;
		}
	}

	/** The embedding model loads on the first vector query (~3 s); pay that before the user searches. */
	private async warmUp(): Promise<void> {
		const body = { searches: [{ type: 'vec', query: 'warm up' }], limit: 1, rerank: false };
		await this.request('POST', '/query', body, undefined, 120000).catch(() => undefined);
	}

	/**
	 * JSON request over Node's http module. Renderer fetch() would add an
	 * `Origin: app://obsidian.md` header, which the server rejects with 403.
	 */
	request<T>(
		method: 'GET' | 'POST',
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		timeoutMs = 30000,
		port = this.port
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const payload = body === undefined ? undefined : JSON.stringify(body);
			const headers: Record<string, string | number> = payload
				? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
				: {};
			const req = http.request({ host: 'localhost', port, path, method, headers, signal, timeout: timeoutMs }, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (chunk: Buffer) => chunks.push(chunk));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					if (res.statusCode !== 200) {
						return reject(new Error(`qmd server ${res.statusCode}: ${text.slice(0, 200)}`));
					}
					try {
						resolve(JSON.parse(text) as T);
					} catch (e) {
						reject(e instanceof Error ? e : new Error(String(e)));
					}
				});
			});
			req.on('timeout', () => req.destroy(new Error('qmd server timed out')));
			req.on('error', reject);
			req.end(payload);
		});
	}
}
