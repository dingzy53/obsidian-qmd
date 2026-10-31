import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QmdSettings } from '../types';

export interface QmdStatus {
	indexPath: string;
	docs: number;
	vectors: number;
	pending: number;
	orphaned: number; // vector chunks of notes no longer indexed
	updated: string;
}

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*[A-Za-z]`, 'g');

export function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE, '');
}

function samePath(a: string, b: string): boolean {
	const real = (p: string) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return path.resolve(p);
		}
	};
	return real(a) === real(b);
}

/**
 * Runs the qmd CLI inside the project directory (the folder that contains `.qmd`),
 * which is what makes qmd use the vault's own index instead of the global one.
 */
export class QmdRunner {
	/** Set by verify(): why qmd must not be used right now, or null when all is well. */
	problem: string | null = null;
	/** Why the last verify() could not run `qmd status`, if it could not. */
	checkError: string | null = null;
	private cachedBinary: string | null = null;

	constructor(private getSettings: () => QmdSettings, private vaultPath: string) {}

	get projectDir(): string {
		return this.getSettings().projectDir.trim() || this.vaultPath;
	}

	get indexPath(): string {
		return path.join(this.projectDir, '.qmd', 'index.sqlite');
	}

	/** Path of the project-local qmd config, or null when the project has none. */
	configPath(): string | null {
		for (const name of ['index.yaml', 'index.yml']) {
			const candidate = path.join(this.projectDir, '.qmd', name);
			if (fs.existsSync(candidate)) return candidate;
		}
		return null;
	}

	resetBinary(): void {
		this.cachedBinary = null;
	}

	isFlatpak(): boolean {
		return fs.existsSync('/.flatpak-info') || !!process.env.FLATPAK_ID;
	}

	async resolveBinary(): Promise<string> {
		const configured = this.getSettings().qmdBinaryPath.trim();
		if (configured) return configured;
		if (this.cachedBinary) return this.cachedBinary;

		const isWindows = process.platform === 'win32';
		const homedir = os.homedir();
		const candidates: string[] = [];

		if (isWindows) {
			const appData = process.env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
			const localAppData = process.env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
			candidates.push(
				path.join(appData, 'npm', 'qmd.cmd'),
				path.join(localAppData, 'Programs', 'qmd', 'qmd.exe')
			);
		} else {
			candidates.push(
				path.join(homedir, '.local', 'bin', 'qmd'),
				path.join(homedir, '.cargo', 'bin', 'qmd'),
				path.join(homedir, '.bun', 'bin', 'qmd'),
				'/usr/local/bin/qmd',
				'/opt/homebrew/bin/qmd',
				'/usr/bin/qmd'
			);
		}

		for (const cand of candidates) {
			try {
				if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
					this.cachedBinary = cand;
					return cand;
				}
			} catch {
				// Ignore permission / stat errors
			}
		}

		// Fallback to searching PATH via which / where
		try {
			let lookupBin = isWindows ? 'where.exe' : 'which';
			let lookupArgs = ['qmd'];
			if (this.isFlatpak()) {
				lookupBin = 'flatpak-spawn';
				lookupArgs = ['--host', 'which', 'qmd'];
			}
			const stdout = await new Promise<string>((resolve, reject) => {
				execFile(lookupBin, lookupArgs, { timeout: 3000 }, (error, out) => {
					if (error) reject(new Error(error.message));
					else resolve(out);
				});
			});
			const found = stdout.split(/\r?\n/)[0]?.trim();
			if (found) {
				this.cachedBinary = found;
				return found;
			}
		} catch {
			// lookup failed
		}

		this.cachedBinary = isWindows ? 'qmd.cmd' : 'qmd';
		return this.cachedBinary;
	}

	private async command(args: string[], watchBus = false) {
		if (!this.configPath()) {
			throw new Error(`No .qmd/index.yml in ${this.projectDir}. Run "qmd init" there or fix the index location.`);
		}
		const binary = await this.resolveBinary();
		const dir = this.projectDir;
		// Node starts .cmd/.bat files only through a shell, which would interpret the query text.
		if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
			throw new Error(`Cannot start ${binary}: set "Path to qmd" to a .exe file.`);
		}

		if (this.isFlatpak()) {
			// The sandbox environment is not forwarded to the host, and --directory alone
			// leaves a stale PWD that qmd would read, so both are passed explicitly.
			const argv = ['--host'];
			if (watchBus) argv.push('--watch-bus');
			argv.push(`--directory=${dir}`, `--env=PWD=${dir}`, binary, ...args);
			return { cmd: 'flatpak-spawn', argv, options: {} };
		}

		const homedir = os.homedir();
		const extraPath = [
			path.join(homedir, '.local', 'bin'),
			path.join(homedir, '.cargo', 'bin'),
			path.join(homedir, '.bun', 'bin'),
			'/usr/local/bin',
			'/opt/homebrew/bin',
			'/usr/bin',
			'/bin',
		].join(path.delimiter);
		const env = {
			...process.env,
			PWD: dir,
			PATH: process.env.PATH ? `${extraPath}${path.delimiter}${process.env.PATH}` : extraPath,
		};
		return { cmd: binary, argv: args, options: { cwd: dir, env } };
	}

	/** Run a qmd command to completion and return its stdout. Aborting or timing out stops the process. */
	async exec(args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
		const aborted = () => {
			const e = new Error('qmd command aborted');
			e.name = 'AbortError';
			return e;
		};
		if (opts.signal?.aborted) throw aborted();
		const child = await this.spawn(args);
		return new Promise<string>((resolve, reject) => {
			const out: Buffer[] = [];
			const err: Buffer[] = [];
			let stopped: Error | null = null;
			const stop = (why: Error) => {
				stopped = why;
				this.kill(child);
			};
			const onAbort = () => stop(aborted());
			const timer = window.setTimeout(() => stop(new Error(`qmd ${args[0]} timed out`)), opts.timeoutMs ?? 60000);
			opts.signal?.addEventListener('abort', onAbort, { once: true });
			child.stdout?.on('data', (data: Buffer) => out.push(data));
			child.stderr?.on('data', (data: Buffer) => err.push(data));

			const finish = (code: number | null, spawnError?: Error) => {
				window.clearTimeout(timer);
				opts.signal?.removeEventListener('abort', onAbort);
				if (stopped) return reject(stopped);
				if (spawnError) return reject(spawnError);
				if (code !== 0) {
					const message = stripAnsi(Buffer.concat(err).toString('utf8')).trim();
					return reject(new Error(message || `qmd ${args[0]} exited with code ${code}`));
				}
				resolve(Buffer.concat(out).toString('utf8'));
			};
			child.once('error', (e) => finish(null, e));
			child.once('close', (code) => finish(code));
		});
	}

	/** Start a qmd command and hand back the process. The caller must drain its pipes. */
	async spawn(args: string[], opts: { watchBus?: boolean } = {}): Promise<ChildProcess> {
		const { cmd, argv, options } = await this.command(args, opts.watchBus);
		// Outside Flatpak the process leads its own group, so kill() can reach its children.
		const detached = !this.isFlatpak() && process.platform !== 'win32';
		return spawn(cmd, argv, { ...options, detached, stdio: ['ignore', 'pipe', 'pipe'] });
	}

	/**
	 * Stop a process started by spawn(). `qmd` is a launcher script that runs the real
	 * program as a child, so the whole process group has to be signalled:
	 * flatpak-spawn forwards SIGINT to the host process group (SIGTERM would only
	 * reach the launcher and leave the real process running).
	 */
	kill(child: ChildProcess): void {
		if (child.exitCode !== null || child.signalCode !== null) return;
		if (!this.isFlatpak() && child.pid && process.platform !== 'win32') {
			try {
				process.kill(-child.pid, 'SIGINT');
				return;
			} catch {
				// not a group leader; fall through
			}
		}
		child.kill('SIGINT');
	}

	async status(): Promise<QmdStatus> {
		const out = stripAnsi(await this.exec(['status'], { timeoutMs: 15000 }));
		const num = (re: RegExp) => Number(re.exec(out)?.[1] ?? 0);
		return {
			indexPath: /^Index:\s*(.+)$/m.exec(out)?.[1].trim() ?? '',
			docs: num(/Total:\s+(\d+)/),
			vectors: num(/Vectors:\s+(\d+)/),
			pending: num(/Pending:\s+(\d+)/),
			orphaned: num(/Orphaned:\s+(\d+)/),
			updated: /Updated:\s+(.+)$/m.exec(out)?.[1].trim() ?? '',
		};
	}

	/**
	 * Confirm qmd really resolves to this project's index. Without this check a missing
	 * or misplaced .qmd makes qmd fall back to the global index without saying so.
	 * Only those two findings set `problem`; a failed or slow `qmd status` (say, during
	 * an embed) is reported in `checkError` and does not block searching.
	 */
	async verify(): Promise<QmdStatus | null> {
		this.checkError = null;
		if (!this.configPath()) {
			this.problem = `No .qmd/index.yml in ${this.projectDir}. Run "qmd init" there or fix the index location.`;
			return null;
		}
		try {
			const status = await this.status();
			const matches = !!status.indexPath && samePath(status.indexPath, this.indexPath);
			this.problem = matches ? null : `qmd is using ${status.indexPath || 'an unknown index'}, expected ${this.indexPath}.`;
			return matches ? status : null;
		} catch (e) {
			this.problem = null;
			this.checkError = e instanceof Error ? e.message : String(e);
			return null;
		}
	}
}
