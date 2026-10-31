import { parseYaml } from 'obsidian';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { QmdRunner } from './runner';

export interface QmdCollection {
	name: string;
	root: string; // absolute
	ignore: string[];
}

interface RawConfig {
	collections?: Record<string, { path?: unknown; ignore?: unknown } | null> | null;
}

function rawConfig(text: string): RawConfig {
	return ((parseYaml(text) as RawConfig | null) ?? {});
}

/** Collections of an index.yml. qmd resolves a relative `path` against the folder that contains `.qmd`. */
export function parseCollections(text: string, projectDir: string): QmdCollection[] {
	return Object.entries(rawConfig(text).collections ?? {}).map(([name, raw]) => {
		const dir = typeof raw?.path === 'string' ? raw.path.replace(/^~(?=\/|$)/, os.homedir()) : '';
		const ignore = Array.isArray(raw?.ignore) ? (raw.ignore as unknown[]) : [];
		return {
			name,
			root: path.resolve(projectDir, dir),
			ignore: ignore.filter((rule): rule is string => typeof rule === 'string'),
		};
	});
}

/** The ignore rule for a folder. Unescaped, a name like `Archive (old)` silently matches nothing. */
export function folderPattern(folder: string): string {
	return `${folder.replace(/[\\()*?[\]{}|]|^!|[!+@](?=\()/g, '\\$&')}/**`;
}

/** The folder an ignore rule stands for, or null for any other rule (`*.aux`, `.obsidian/**`, `**\/drafts/**`). */
export function patternFolder(pattern: string): string | null {
	if (!pattern.endsWith('/**')) return null;
	const folder = pattern.slice(0, -3).replace(/\\(.)/g, '$1');
	if (folder.split('/').some((part) => !part || part.startsWith('.'))) return null;
	return folderPattern(folder) === pattern ? folder : null;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => /^\s*(#.*)?$/.test(line);

/**
 * Replace one collection's `ignore:` block, leaving every other line of the file as it
 * is (index.yml may be tracked in git). Comments inside the block are lost. Throws
 * when the file is not laid out as block mappings; editIgnore() checks the result.
 */
export function withIgnore(text: string, collection: string, patterns: string[]): string {
	const lines = text.split('\n');
	const top = lines.findIndex((line) => /^collections:\s*(#.*)?$/.test(line));
	let end = lines.findIndex((line, i) => i > top && !isBlank(line) && indentOf(line) === 0);
	if (end < 0) end = lines.length;
	const first = lines.findIndex((line, i) => i > top && i < end && !isBlank(line));
	if (top < 0 || first < 0) throw new Error('no collections block');

	const keyIndent = indentOf(lines[first]);
	const key = lines.findIndex((line, i) => {
		if (i < first || i >= end || indentOf(line) !== keyIndent || isBlank(line)) return false;
		const name = /^\s*(.+?):\s*(#.*)?$/.exec(line)?.[1];
		return name?.replace(/^["']|["']$/g, '') === collection;
	});
	if (key < 0) throw new Error(`cannot find "${collection}" as a block mapping. Change its ignore list by hand.`);

	let stop = lines.findIndex((line, i) => i > key && i < end && !isBlank(line) && indentOf(line) <= keyIndent);
	if (stop < 0) stop = end;
	const body = lines.findIndex((line, i) => i > key && i < stop && !isBlank(line));
	const indent = body < 0 ? keyIndent + 2 : indentOf(lines[body]);
	const field = (name: string) =>
		lines.findIndex(
			(line, i) => i > key && i < stop && indentOf(line) === indent && new RegExp(`^\\s*["']?${name}["']?\\s*:`).test(line)
		);

	const pad = ' '.repeat(indent);
	const block = patterns.length ? [`${pad}ignore:`, ...patterns.map((rule) => `${pad}  - ${JSON.stringify(rule)}`)] : [];
	const ignore = field('ignore');
	if (ignore < 0) {
		const anchor = Math.max(field('pattern'), field('path'), key);
		lines.splice(anchor + 1, 0, ...block);
		return lines.join('\n');
	}

	// A list may sit at the same indent as its key, and a multi-line flow list closes there.
	let last = ignore;
	for (let i = ignore + 1; i < stop; i++) {
		if (isBlank(lines[i])) continue;
		const inList = indentOf(lines[i]) === indent && /^\s*(-(\s|$)|\])/.test(lines[i]);
		if (indentOf(lines[i]) <= indent && !inList) break;
		last = i;
	}
	lines.splice(ignore, last - ignore + 1, ...block);
	return lines.join('\n');
}

/** Whether `after` holds exactly `patterns` for this collection and differs from `before` in nothing else. */
export function editIsSafe(before: string, after: string, collection: string, patterns: string[]): boolean {
	try {
		const was = rawConfig(before);
		const now = rawConfig(after);
		const ignore = now.collections?.[collection]?.ignore ?? [];
		if (JSON.stringify(ignore) !== JSON.stringify(patterns)) return false;
		delete was.collections?.[collection]?.ignore;
		delete now.collections?.[collection]?.ignore;
		return JSON.stringify(was) === JSON.stringify(now);
	} catch {
		return false;
	}
}

/** withIgnore(), refusing any result that would change more than the ignore list. */
export function editIgnore(text: string, collection: string, patterns: string[]): string {
	const edited = withIgnore(text, collection, patterns);
	if (!editIsSafe(text, edited, collection, patterns)) {
		throw new Error(`cannot edit the ignore list of "${collection}" safely. Change it by hand.`);
	}
	return edited;
}

/**
 * The project's index.yml, which is the only record of excluded folders: `qmd update`
 * run outside Obsidian reads nothing else. Parsed state is kept in memory because
 * setting definitions must not read files; every write starts from the file itself.
 */
export class QmdConfig {
	collections: QmdCollection[] = [];
	/** Excluded folders, vault-relative. */
	folders: string[] = [];
	/** Ignore rules that are not folders in this vault. They are never rewritten. */
	otherPatterns: string[] = [];

	private text = '';
	private listeners = new Set<() => void>();

	constructor(private runner: QmdRunner, private vaultPath: string) {}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Read index.yml again, and tell the listeners if it changed. */
	reload(): void {
		const configPath = this.runner.configPath();
		let text = '';
		try {
			if (configPath) text = fs.readFileSync(configPath, 'utf8');
			this.collections = parseCollections(text, this.runner.projectDir);
		} catch (e) {
			console.warn('[qmd-vault-search] could not read the qmd config:', e);
			this.collections = [];
		}

		const folders = new Set<string>();
		const others = new Set<string>();
		for (const collection of this.collections) {
			for (const rule of collection.ignore) {
				const inRoot = patternFolder(rule);
				const folder = inRoot === null ? null : this.vaultFolder(collection.root, inRoot);
				if (folder === null) others.add(rule);
				else folders.add(folder);
			}
		}
		this.folders = [...folders].sort((a, b) => a.localeCompare(b));
		this.otherPatterns = [...others];

		const changed = text !== this.text;
		this.text = text;
		if (changed) this.listeners.forEach((fn) => fn());
	}

	/** Absolute root of a collection. */
	rootOf(name: string): string {
		return this.collections.find((c) => c.name === name)?.root ?? this.runner.projectDir;
	}

	isExcluded(folder: string): boolean {
		return this.folders.includes(folder);
	}

	/** False for a folder that is already out, or that no ignore rule can reach. */
	canExclude(folder: string): boolean {
		if (this.folders.some((f) => folder === f || folder.startsWith(`${f}/`))) return false;
		return this.collections.some((c) => this.inRoot(folder, c.root) !== null);
	}

	exclude(folder: string): void {
		this.edit((collection) => {
			const inRoot = this.inRoot(folder, collection.root);
			if (inRoot === null) return collection.ignore;
			const rule = folderPattern(inRoot);
			return collection.ignore.includes(rule) ? collection.ignore : [...collection.ignore, rule];
		});
	}

	include(folder: string): void {
		this.edit((collection) => {
			const inRoot = this.inRoot(folder, collection.root);
			return inRoot === null ? collection.ignore : collection.ignore.filter((rule) => rule !== folderPattern(inRoot));
		});
	}

	/** Keep rules pointing at a folder that moved, or its notes would quietly be indexed again. */
	rename(oldFolder: string, newFolder: string): void {
		const moved = (folder: string) => folder === oldFolder || folder.startsWith(`${oldFolder}/`);
		if (!this.folders.some(moved)) return;
		this.edit((collection) =>
			collection.ignore.flatMap((rule) => {
				const inRoot = patternFolder(rule);
				const folder = inRoot === null ? null : this.vaultFolder(collection.root, inRoot);
				if (folder === null || !moved(folder)) return [rule];
				const target = this.inRoot(newFolder + folder.slice(oldFolder.length), collection.root);
				return target === null ? [] : [folderPattern(target)];
			})
		);
	}

	private edit(change: (collection: QmdCollection) => string[]): void {
		const configPath = this.runner.configPath();
		if (!configPath) throw new Error(`no .qmd/index.yml in ${this.runner.projectDir}`);
		const target = fs.realpathSync(configPath);
		const before = fs.readFileSync(target, 'utf8');
		let after = before;
		for (const collection of parseCollections(before, this.runner.projectDir)) {
			const next = change(collection);
			if (JSON.stringify(next) !== JSON.stringify(collection.ignore)) after = editIgnore(after, collection.name, next);
		}
		if (after === before) return;
		// Written beside the file and moved over it, so a qmd job never reads half a config.
		const temp = `${target}.tmp`;
		fs.writeFileSync(temp, after, 'utf8');
		fs.renameSync(temp, target);
		this.reload();
	}

	/** `folder` (vault-relative) as a path strictly inside `root`, or null. */
	private inRoot(folder: string, root: string): string | null {
		const relative = path.relative(root, path.join(this.vaultPath, folder));
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
		return relative.split(path.sep).join('/');
	}

	/** A path inside `root` as a vault-relative folder, or null when it is outside the vault. */
	private vaultFolder(root: string, inRoot: string): string | null {
		const relative = path.relative(this.vaultPath, path.join(root, inRoot));
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
		return relative.split(path.sep).join('/');
	}
}
