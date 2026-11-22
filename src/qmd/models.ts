import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import { requestUrl } from 'obsidian';
import * as os from 'os';
import * as path from 'path';
import type { QmdSettings } from '../types';
import { QmdRunner, stripAnsi } from './runner';

export type ModelRole = 'embed' | 'generate' | 'rerank';

/** qmd's default models (`@tobilu/qmd` dist/llm.js). */
export const DEFAULT_MODELS: Record<ModelRole, string> = {
	embed: 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf',
	generate: 'hf:tobil/qmd-query-expansion-1.7B-gguf/qmd-query-expansion-1.7B-q4_k_m.gguf',
	rerank: 'hf:ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF/qwen3-reranker-0.6b-q8_0.gguf',
};

/** Sizes of the default model files, for progress against a known total. */
const KNOWN_SIZES: Record<string, number> = {
	'embeddinggemma-300M-Q8_0.gguf': 333590944,
	'qmd-query-expansion-1.7B-q4_k_m.gguf': 1282438912,
	'qwen3-reranker-0.6b-q8_0.gguf': 639153184,
};

const LABELS: Record<ModelRole, string> = {
	embed: 'embedding model',
	generate: 'query model',
	rerank: 'reranker',
};

const ENV_KEYS: Record<ModelRole, string> = {
	embed: 'QMD_EMBED_MODEL',
	generate: 'QMD_GENERATE_MODEL',
	rerank: 'QMD_RERANK_MODEL',
};

/** A download that has not grown for this long counts as stalled. */
const STALL_MS = 2 * 60 * 1000;

export interface ModelSpec {
	role: ModelRole;
	label: string;
	/** File name in the hf: URI. The cached copy is `hf_<user>_<file>`. */
	file: string;
	/** Hugging Face resolve URL that qmd checks with HEAD for the ETag. */
	url: string;
	totalBytes: number | null;
}

export interface ModelState {
	spec: ModelSpec;
	present: boolean;
	/** True while an `.ipull` partial file exists. */
	downloading: boolean;
	/** Bytes written so far, or null when unknown. */
	doneBytes: number | null;
	/** Last change of the partial file, 0 when there is none. */
	changedAt: number;
}

/**
 * qmd's model cache. Inside Flatpak, qmd runs on the host, so the sandbox's own
 * XDG_CACHE_HOME (under ~/.var/app) does not apply.
 */
export function modelCacheDir(env: NodeJS.ProcessEnv, home: string, flatpak: boolean): string {
	const xdg = flatpak ? '' : env.XDG_CACHE_HOME;
	return xdg ? path.join(xdg, 'qmd', 'models') : path.join(home, '.cache', 'qmd', 'models');
}

/** The cache entry for an hf: model URI, or null for a local file, which is never downloaded. */
export function modelSpec(role: ModelRole, uri: string): ModelSpec | null {
	if (!uri.startsWith('hf:')) return null;
	const parts = uri.slice(3).split('/');
	if (parts.length < 3) return null;
	const repo = parts.slice(0, 2).join('/');
	const repoPath = parts.slice(2).join('/');
	const file = parts[parts.length - 1];
	if (!file) return null;
	const url = `https://huggingface.co/${repo}/resolve/main/${repoPath}`;
	return { role, label: LABELS[role], file, url, totalBytes: KNOWN_SIZES[file] ?? null };
}

/** The model a role uses: index.yml `models:` first, then qmd's environment variable, then the default. */
export function resolveModel(role: ModelRole, configured: Partial<Record<ModelRole, string>>, env: NodeJS.ProcessEnv): string {
	return configured[role] || env[ENV_KEYS[role]] || DEFAULT_MODELS[role];
}

/** Whether a model file is cached, and how far its download has got. */
export function modelState(dir: string, spec: ModelSpec): ModelState {
	let names: string[] = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		// no cache yet
	}
	// qmd itself matches cached files by `includes(file)`. The `.etag` sidecars are not models.
	const matching = names.filter((name) => name.includes(spec.file));
	const present = matching.some((name) => name.endsWith('.gguf'));
	const partial = matching.find((name) => name.endsWith('.ipull'));
	let doneBytes: number | null = null;
	let changedAt = 0;
	if (!present && partial) {
		try {
			// ipull writes at offsets into a file sized to the total, so only the allocated blocks show progress.
			const stat = fs.statSync(path.join(dir, partial));
			changedAt = stat.mtimeMs;
			if (stat.blocks) doneBytes = stat.blocks * 512;
			if (doneBytes !== null && spec.totalBytes) doneBytes = Math.min(doneBytes, spec.totalBytes);
		} catch {
			// renamed or removed meanwhile
		}
	}
	return { spec, present, downloading: !present && !!partial, doneBytes, changedAt };
}

/** Bytes in GB (one decimal) or, under 1 GB, in MB. */
export function formatSize(bytes: number, unitOf = bytes): string {
	return unitOf >= 1e9 ? `${(bytes / 1e9).toFixed(1)}` : `${Math.round(bytes / 1e6)}`;
}

function unit(bytes: number): string {
	return bytes >= 1e9 ? 'GB' : 'MB';
}

/** "1.3 GB", "639 MB". */
export function formatBytes(bytes: number): string {
	return `${formatSize(bytes)} ${unit(bytes)}`;
}

/** "Downloading query model (0.4 / 1.3 GB)", or "(~1.3 GB, first run)" before any progress shows. */
export function formatDownload(state: ModelState): string {
	const { label, totalBytes } = state.spec;
	const done = state.doneBytes;
	if (totalBytes && done !== null) {
		return `Downloading ${label} (${formatSize(done, totalBytes)} / ${formatSize(totalBytes)} ${unit(totalBytes)})`;
	}
	if (done !== null) return `Downloading ${label} (${formatSize(done)} ${unit(done)})`;
	if (totalBytes) return `Downloading ${label} (~${formatSize(totalBytes)} ${unit(totalBytes)}, first run)`;
	return `Downloading ${label} (first run)`;
}

/** The download to report: one in progress first, else the first missing model. */
export function activeDownload(states: ModelState[]): ModelState | null {
	const missing = states.filter((state) => !state.present);
	return missing.find((state) => state.downloading) ?? missing[0] ?? null;
}

/** Label for the settings action button, saying what will actually be downloaded. */
export function formatPullButton(states: ModelState[], pulling: boolean): string {
	if (pulling) return 'Downloading…';
	const missing = states.filter((state) => !state.present);
	if (missing.length === 0) return 'Check for updates';
	if (missing.length === 1) {
		const { label, totalBytes } = missing[0].spec;
		return totalBytes ? `Download ${label} (${formatBytes(totalBytes)})` : `Download ${label}`;
	}
	const allKnown = missing.every((state) => state.spec.totalBytes !== null);
	const total = allKnown
		? ` (${formatBytes(missing.reduce((sum, state) => sum + (state.spec.totalBytes ?? 0), 0))})`
		: '';
	return missing.length === states.length
		? `Download all models${total}`
		: `Download ${missing.length} models${total}`;
}

/** Fetch the ETag header qmd compares against `<file>.etag` during `qmd pull`. */
export async function fetchRemoteEtag(url: string): Promise<string | null> {
	try {
		const res = await requestUrl({ url, method: 'HEAD', throw: false });
		if (res.status < 200 || res.status >= 300) return null;
		const entry = Object.entries(res.headers).find(([key]) => key.toLowerCase() === 'etag');
		const etag = entry?.[1]?.trim();
		return etag || null;
	} catch {
		return null;
	}
}

/**
 * Models downloaded lazily by `qmd embed` or `qmd query` have no `<file>.etag` sidecar,
 * so `qmd pull` treats them as stale and re-downloads them. Write the missing sidecars
 * for models already present in `dir` so `qmd pull` keeps them.
 */
export async function seedMissingEtags(
	dir: string,
	specs: ModelSpec[],
	getEtag: (url: string) => Promise<string | null> = fetchRemoteEtag
): Promise<string[]> {
	const seeded: string[] = [];
	await Promise.all(
		specs.map(async (spec) => {
			if (!modelState(dir, spec).present) return;
			const etagPath = path.join(dir, `${spec.file}.etag`);
			if (fs.existsSync(etagPath)) return;
			const etag = await getEtag(spec.url);
			if (!etag) return;
			try {
				fs.writeFileSync(etagPath, `${etag}\n`, 'utf8');
				seeded.push(spec.file);
			} catch {
				// Best effort: if the cache is not writable, `qmd pull` will report it.
			}
		})
	);
	return seeded;
}

/**
 * Whether models are still arriving: some are missing, and the download has grown
 * (or the watch started) within the last two minutes.
 */
export class DownloadWatch {
	private last = '';
	private lastChange: number;

	constructor(private read: () => ModelState[], private now: () => number = Date.now) {
		this.lastChange = now();
	}

	active(): boolean {
		const missing = this.read().filter((state) => !state.present);
		if (missing.length === 0) return false;
		const stamp = missing.map((state) => `${state.doneBytes ?? ''}@${state.changedAt}`).join(' ');
		if (stamp !== this.last) {
			this.last = stamp;
			this.lastChange = this.now();
		}
		return this.now() - this.lastChange < STALL_MS;
	}
}

export type PullState = 'idle' | 'pulling' | 'error';

/**
 * qmd downloads its models into a shared cache on first use. This class reads that
 * cache, runs `qmd pull`, and keeps deep searches left running to finish a download.
 * At most one download runs at a time: two processes writing the same `.ipull` file
 * would spoil it.
 */
export class QmdModels {
	state: PullState = 'idle';
	message = '';

	private pullJob: Promise<void> | null = null;
	private pullChild: ChildProcess | null = null;
	/** Deep searches closed mid-download, left running so the download is not lost. */
	private released = new Map<ChildProcess, Promise<void>>();
	private listeners = new Set<() => void>();

	constructor(
		private runner: QmdRunner,
		private getConfigured: () => Partial<Record<ModelRole, string>>,
		private getSettings: () => QmdSettings
	) {}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private changed(): void {
		this.listeners.forEach((fn) => fn());
	}

	get dir(): string {
		return modelCacheDir(process.env, os.homedir(), this.runner.isFlatpak());
	}

	private specs(roles: ModelRole[]): ModelSpec[] {
		// The sandbox environment is not forwarded to qmd on the host.
		const env = this.runner.isFlatpak() ? {} : process.env;
		const configured = this.getConfigured();
		return roles
			.map((role) => modelSpec(role, resolveModel(role, configured, env)))
			.filter((spec): spec is ModelSpec => spec !== null);
	}

	/** Models `qmd query` loads: query expansion, embedding, and the reranker when it is on. */
	deepSearchModels(): ModelSpec[] {
		return this.specs(this.getSettings().deepRerank ? ['generate', 'rerank', 'embed'] : ['generate', 'embed']);
	}

	/** Models `qmd pull` fetches. */
	allModels(): ModelSpec[] {
		return this.specs(['generate', 'rerank', 'embed']);
	}

	states(specs: ModelSpec[]): ModelState[] {
		const dir = this.dir;
		return specs.map((spec) => modelState(dir, spec));
	}

	/** Progress text for the first model still missing, or null when all are cached. */
	progress(specs: ModelSpec[]): string | null {
		const active = activeDownload(this.states(specs));
		return active ? formatDownload(active) : null;
	}

	watch(specs: ModelSpec[]): DownloadWatch {
		return new DownloadWatch(() => this.states(specs));
	}

	/** True while `qmd pull` or a released deep search runs. */
	get busy(): boolean {
		return this.pullJob !== null || this.released.size > 0;
	}

	/** Wait until no download runs. Aborting stops the wait, not the download. */
	async idle(signal?: AbortSignal, withPull = true): Promise<void> {
		while (this.released.size > 0 || (withPull && this.pullJob)) {
			const running = [...this.released.values()];
			if (withPull && this.pullJob) running.push(this.pullJob);
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					const e = new Error('qmd command aborted');
					e.name = 'AbortError';
					reject(e);
				};
				if (signal?.aborted) return onAbort();
				signal?.addEventListener('abort', onAbort, { once: true });
				void Promise.race(running).then(() => {
					signal?.removeEventListener('abort', onAbort);
					resolve();
				});
			});
		}
	}

	/** Keep a deep search that was closed mid-download running until it exits. */
	release(child: ChildProcess): void {
		const done = new Promise<void>((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) return resolve();
			child.once('close', () => resolve());
			child.once('error', () => resolve());
		}).then(() => {
			this.released.delete(child);
			this.changed();
		});
		this.released.set(child, done);
		this.changed();
	}

	/** Run `qmd pull` with no timeout: the models are about 2.3 GB. One run at a time. */
	pull(): Promise<void> {
		if (!this.pullJob) {
			this.pullJob = this.runPull().finally(() => {
				this.pullJob = null;
				this.changed();
			});
		}
		return this.pullJob;
	}

	private async runPull(): Promise<void> {
		this.state = 'pulling';
		this.message = '';
		this.changed();
		try {
			await this.idle(undefined, false);
			await seedMissingEtags(this.dir, this.allModels());
			const child = await this.runner.spawn(['pull']);
			this.pullChild = child;
			let output = '';
			const take = (data: Buffer) => {
				output = (output + data.toString('utf8')).slice(-4000);
			};
			child.stdout?.on('data', take);
			child.stderr?.on('data', take);
			const code = await new Promise<number | null>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', resolve);
			});
			this.pullChild = null;
			if (code !== 0) {
				const tail = stripAnsi(output).trim().split('\n').slice(-3).join(' ').trim();
				throw new Error(tail || `qmd pull exited with code ${code}`);
			}
			this.state = 'idle';
		} catch (e) {
			this.pullChild = null;
			this.state = 'error';
			this.message = e instanceof Error ? e.message : String(e);
		}
	}

	/** Stop every download (plugin unload). */
	stop(): void {
		if (this.pullChild) this.runner.kill(this.pullChild);
		for (const child of this.released.keys()) this.runner.kill(child);
	}
}
