import { App, TFile } from 'obsidian';
import * as path from 'path';
import { isAbort, QmdResult, QmdSettings, SearchOutcome } from '../types';
import { QmdConfig, realPath } from './config';
import { QmdModels } from './models';
import { ExecOptions, QmdRunner } from './runner';
import { QmdServer } from './server';

interface RawResult {
	file: string;
	line?: number;
	title?: string;
	score?: number;
	snippet?: string;
}

/** The server fuses the top 20 keyword and top 20 vector hits, so it never returns more than this. */
const REST_MAX = 40;

export const DEFAULT_DEEP_TIMEOUT_MIN = 10;
export const DEFAULT_DEEP_RERANK_TIMEOUT_MIN = 20;
const MAX_DEEP_TIMEOUT_MIN = 1440;
export const SLOW_DEEP_SEARCH_MS = 30 * 1000;

/** Deep-search timeout in ms, or 0 for no limit. */
export function deepSearchTimeoutMs(settings: Pick<QmdSettings, 'deepRerank' | 'deepTimeoutMinutes'>): number {
	const configured = settings.deepTimeoutMinutes;
	if (typeof configured === 'number' && Number.isFinite(configured) && configured >= 0) {
		return configured === 0 ? 0 : Math.min(configured, MAX_DEEP_TIMEOUT_MIN) * 60 * 1000;
	}
	return (settings.deepRerank ? DEFAULT_DEEP_RERANK_TIMEOUT_MIN : DEFAULT_DEEP_TIMEOUT_MIN) * 60 * 1000;
}

/** Status line while a deep search runs: download progress first, then a slow-machine hint after ~30 s. */
export function deepSearchStatus(progress: string | null, elapsedMs: number, waitingMs: number): string {
	const seconds = Math.round(elapsedMs / 1000);
	if (progress) return `${progress}… ${seconds} s`;
	if (waitingMs >= SLOW_DEEP_SEARCH_MS) {
		return `Deep search… ${seconds} s (loading models; slow on low-memory machines)`;
	}
	return `Deep search… ${seconds} s`;
}

export interface SearchOptions {
	folder?: string;
	limit?: number;
	signal?: AbortSignal;
}

/** Keyword (lex) queries must be one line with balanced double quotes. */
export function toLexQuery(text: string): string {
	const single = text.replace(/\s+/g, ' ').trim();
	return (single.match(/"/g) ?? []).length % 2 ? single.replace(/"/g, ' ').trim() : single;
}

/** Vector queries reject lex syntax: drop quoted-phrase marks and whole negated terms. */
export function toVecQuery(text: string): string {
	return text
		.replace(/(^|\s)-"[^"]*"/g, '$1')
		.replace(/(^|\s)-[\w"]\S*/g, '$1')
		.replace(/"/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Note text as a vector query: list dashes and negative numbers must not read as negation. */
export function proseToVecQuery(text: string): string {
	return text
		.replace(/(^|\s)-+(?=[\w"])/g, '$1')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * qmd prefixes snippets with a diff-style header (and line numbers over REST); return
 * the text alone. Leading blank lines are kept so line k of the text is file line start+k.
 */
export function cleanSnippet(raw?: string): { text: string; startLine: number } {
	if (!raw) return { text: '', startLine: 0 };
	let lines = raw.split('\n');
	if (/^\d+: @@ /.test(lines[0])) lines = lines.map((l) => l.replace(/^\d+: /, ''));
	const header = /^@@ -(\d+),\d+ @@/.exec(lines[0]);
	if (header) lines = lines.slice(1);
	return { text: lines.join('\n').replace(/\s+$/, ''), startLine: header ? Number(header[1]) : 0 };
}

function safeDecode(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function parseJsonArray(output: string): RawResult[] {
	const first = output.indexOf('[');
	const last = output.lastIndexOf(']');
	if (first === -1 || last <= first) return [];
	const parsed: unknown = JSON.parse(output.substring(first, last + 1));
	return Array.isArray(parsed) ? (parsed as RawResult[]) : [];
}

export class QmdSearch {
	private relatedCache = new Map<string, QmdResult[]>();

	constructor(
		private app: App,
		private runner: QmdRunner,
		private server: QmdServer,
		private config: QmdConfig,
		private models: QmdModels,
		private getSettings: () => QmdSettings,
		private vaultPath: string
	) {}

	/** Forget everything derived from the index or its config. */
	invalidate(): void {
		this.config.reload();
		this.relatedCache.clear();
	}

	/** Keyword + vector search on the warm server (well under a second); keyword-only through the CLI otherwise. */
	async fast(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
		this.assertUsable();
		if (this.config.reloadIfChanged()) this.relatedCache.clear();
		const limit = opts.limit ?? this.getSettings().maxResults;
		const lex = toLexQuery(query);
		let results: QmdResult[] = [];
		let degraded = this.server.state !== 'ready';
		if (!degraded) {
			try {
				const raw = await this.rest(query, opts.folder ? REST_MAX : limit, opts.signal);
				results = this.finish(raw, true, opts.folder, limit);
			} catch (e) {
				if (isAbort(e)) throw e;
				console.warn('[qmd-vault-search] server search failed, using keyword search:', e);
				degraded = true;
			}
		}
		// qmd cannot filter by path and the server fuses at most REST_MAX candidates, so a
		// folder filter can come up short. The CLI keyword search can go much deeper.
		if (lex && (degraded || (opts.folder && results.length < limit))) {
			try {
				const raw = await this.cli('search', lex, opts.folder ? 200 : limit, [], opts.signal, 15000);
				const seen = new Set(results.map((r) => r.path));
				const extra = this.finish(raw, false, opts.folder, limit).filter((r) => !seen.has(r.path));
				results = [...results, ...extra].slice(0, limit);
			} catch (e) {
				// A failed top-up still leaves the server's results; a failed fallback leaves nothing.
				if (isAbort(e) || degraded) throw e;
			}
		}
		return { results, degraded };
	}

	/**
	 * Hybrid search with LLM query expansion. Slow (seconds to minutes depending on RAM/CPU),
	 * so it runs as its own process. The first one downloads the query model (1.3 GB): the timeout
	 * waits for the download, and a search closed meanwhile keeps running so the download is not lost.
	 */
	async deep(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
		this.assertUsable();
		if (this.config.reloadIfChanged()) this.relatedCache.clear();
		const limit = opts.limit ?? this.getSettings().maxResults;
		const s = this.getSettings();
		const extra = s.deepRerank ? ['-C', String(s.candidateLimit)] : ['--no-rerank'];
		const timeout = deepSearchTimeoutMs(s);
		const fetch = opts.folder ? Math.min(200, limit * 8) : limit;
		const specs = this.models.deepSearchModels();
		const missing = this.models.states(specs).some((state) => !state.present);
		// Two processes must not download the same model file at once.
		if (missing) await this.models.idle(opts.signal);
		const watch = this.models.watch(specs);
		const raw = await this.cli('query', query.replace(/\s+/g, ' ').trim(), fetch, extra, opts.signal, timeout, {
			keepAlive: () => watch.active(),
			onRelease: (child) => this.models.release(child),
		});
		return { results: this.finish(raw, false, opts.folder, limit), degraded: false };
	}

	/** Notes semantically close to `file`. Needs the server: a CLI vector search takes 10+ s. */
	async related(file: TFile, signal?: AbortSignal): Promise<QmdResult[]> {
		this.assertUsable();
		if (this.config.reloadIfChanged()) this.relatedCache.clear();
		if (this.server.state !== 'ready') throw new Error('The qmd server is not running yet.');
		const key = `${file.path}:${file.stat.mtime}`;
		const cached = this.relatedCache.get(key);
		if (cached) return cached;

		const limit = this.getSettings().relatedResults;
		const body = { searches: [{ type: 'vec', query: await this.digest(file) }], limit: limit + 1, rerank: false };
		const res = await this.server.request<{ results: RawResult[] }>('POST', '/query', body, signal);
		const results = res.results
			.map((r) => this.toResult(r, true))
			.filter((r) => r.path !== file.path)
			.slice(0, limit);

		if (this.relatedCache.size >= 50) this.relatedCache.delete(this.relatedCache.keys().next().value as string);
		this.relatedCache.set(key, results);
		return results;
	}

	private assertUsable(): void {
		if (this.runner.problem) throw new Error(this.runner.problem);
	}

	private async rest(query: string, limit: number, signal?: AbortSignal): Promise<RawResult[]> {
		const lex = toLexQuery(query);
		const vec = toVecQuery(query);
		// Order is irrelevant: qmd ranks keyword hits first and gives that list double weight.
		const searches: { type: string; query: string }[] = [];
		if (lex) searches.push({ type: 'lex', query: lex });
		if (vec) searches.push({ type: 'vec', query: vec });
		// rerank must be sent explicitly: it defaults to on, which takes minutes on CPU.
		const body = { searches, limit, rerank: false };
		const res = await this.server.request<{ results: RawResult[] }>('POST', '/query', body, signal);
		return res.results;
	}

	private async cli(
		mode: 'search' | 'query',
		query: string,
		limit: number,
		extra: string[],
		signal: AbortSignal | undefined,
		timeoutMs: number,
		download: Pick<ExecOptions, 'keepAlive' | 'onRelease'> = {}
	): Promise<RawResult[]> {
		// `--` keeps a query that starts with "-" from being parsed as a flag.
		const args = [mode, '--format', 'json', '-n', String(limit), ...extra, '--', query];
		return parseJsonArray(await this.runner.exec(args, { signal, timeoutMs, ...download }));
	}

	private finish(raw: RawResult[], encoded: boolean, folder: string | undefined, limit: number): QmdResult[] {
		let results = raw.map((r) => this.toResult(r, encoded));
		const prefix = folder?.replace(/\/+$/, '');
		if (prefix) results = results.filter((r) => r.path === prefix || r.path.startsWith(prefix + '/'));
		return results.slice(0, limit);
	}

	/** `qmd://collection/path` (URL-encoded when it comes from the server) → a file in this vault. */
	private toResult(raw: RawResult, encoded: boolean): QmdResult {
		let rest = raw.file.replace(/^qmd:\/\//, '');
		if (encoded) rest = rest.split('/').map(safeDecode).join('/');
		const slash = rest.indexOf('/');
		const collection = slash < 0 ? rest : rest.slice(0, slash);
		const inCollection = slash < 0 ? '' : rest.slice(slash + 1);

		const realRoot = realPath(this.config.rootOf(collection));
		const realVault = realPath(this.vaultPath);
		const absolute = path.resolve(realRoot, inCollection);
		const relative = path.relative(realVault, absolute).split(path.sep).join('/');
		const inVault = !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
		const file = inVault ? this.app.vault.getFileByPath(relative) : null;
		const snippet = cleanSnippet(raw.snippet);

		return {
			file,
			path: inVault ? relative : absolute,
			line: raw.line ?? 0,
			title: raw.title ?? '',
			score: raw.score ?? 0,
			snippet: snippet.text,
			snippetLine: snippet.startLine,
		};
	}

	/** Title, headings and opening text of a note, as one vector query. */
	private async digest(file: TFile): Promise<string> {
		const cache = this.app.metadataCache.getFileCache(file);
		const content = await this.app.vault.cachedRead(file);
		const bodyStart = cache?.frontmatterPosition?.end.offset ?? 0;
		const headings = (cache?.headings ?? [])
			.slice(0, 12)
			.map((h) => h.heading)
			.join('. ');
		const text = `${file.basename}. ${headings}. ${content.slice(bodyStart, bodyStart + 1200)}`;
		return proseToVecQuery(text).slice(0, 1600);
	}
}
