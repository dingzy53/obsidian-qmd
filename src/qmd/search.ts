import { App, TFile } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isAbort, QmdResult, QmdSettings, SearchOutcome } from '../types';
import { QmdRunner } from './runner';
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
	private roots: Map<string, string> | null = null;
	private relatedCache = new Map<string, QmdResult[]>();

	constructor(
		private app: App,
		private runner: QmdRunner,
		private server: QmdServer,
		private getSettings: () => QmdSettings,
		private vaultPath: string
	) {}

	/** Forget everything derived from the index or its config. */
	invalidate(): void {
		this.roots = null;
		this.relatedCache.clear();
	}

	/** Keyword + vector search on the warm server (well under a second); keyword-only through the CLI otherwise. */
	async fast(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
		this.assertUsable();
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

	/** Hybrid search with LLM query expansion. Slow (~15 s on CPU), so it runs as its own process. */
	async deep(query: string, opts: SearchOptions = {}): Promise<SearchOutcome> {
		this.assertUsable();
		const limit = opts.limit ?? this.getSettings().maxResults;
		const s = this.getSettings();
		const extra = s.deepRerank ? ['-C', String(s.candidateLimit)] : ['--no-rerank'];
		const timeout = s.deepRerank ? 15 * 60 * 1000 : 3 * 60 * 1000;
		const fetch = opts.folder ? Math.min(200, limit * 8) : limit;
		const raw = await this.cli('query', query.replace(/\s+/g, ' ').trim(), fetch, extra, opts.signal, timeout);
		return { results: this.finish(raw, false, opts.folder, limit), degraded: false };
	}

	/** Notes semantically close to `file`. Needs the server: a CLI vector search takes 10+ s. */
	async related(file: TFile, signal?: AbortSignal): Promise<QmdResult[]> {
		this.assertUsable();
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
		timeoutMs: number
	): Promise<RawResult[]> {
		// `--` keeps a query that starts with "-" from being parsed as a flag.
		const args = [mode, '--format', 'json', '-n', String(limit), ...extra, '--', query];
		return parseJsonArray(await this.runner.exec(args, { signal, timeoutMs }));
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

		const root = this.collectionRoots().get(collection) ?? this.runner.projectDir;
		const absolute = path.resolve(root, inCollection);
		const relative = path.relative(this.vaultPath, absolute).split(path.sep).join('/');
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

	/**
	 * Collection name → absolute root, read from the project's index.yml with a
	 * line scanner (no YAML dependency). qmd resolves a relative `path` against
	 * the folder that contains `.qmd`.
	 */
	private collectionRoots(): Map<string, string> {
		if (this.roots) return this.roots;
		const roots = new Map<string, string>();
		const configPath = this.runner.configPath();
		try {
			const lines = configPath ? fs.readFileSync(configPath, 'utf8').split('\n') : [];
			let inCollections = false;
			let current = '';
			for (const line of lines) {
				if (/^collections:\s*$/.test(line)) {
					inCollections = true;
					continue;
				}
				if (!inCollections) continue;
				if (/^\S/.test(line)) break; // next top-level key
				const name = /^ {2}([^\s:#][^:]*):\s*$/.exec(line);
				if (name) {
					current = name[1].trim().replace(/^["']|["']$/g, '');
					roots.set(current, this.runner.projectDir);
					continue;
				}
				const dir = /^\s+path:\s*(.+)$/.exec(line);
				if (dir && current) {
					const value = dir[1].trim().replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, os.homedir());
					roots.set(current, path.resolve(this.runner.projectDir, value));
				}
			}
		} catch (e) {
			console.warn('[qmd-vault-search] could not read the qmd config:', e);
		}
		return (this.roots = roots);
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
