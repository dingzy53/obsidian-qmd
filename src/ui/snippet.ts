import { App, Component, finishRenderMath, loadMathJax, MarkdownRenderer, TFile } from 'obsidian';
import { QmdResult } from '../types';

export interface Excerpt {
	markdown: string;
	startLine: number; // 0-based file lines covered by the excerpt
	endLine: number;
	matchLine: number; // 0-based matched line, corrected for edits made since indexing
	heading: string; // nearest heading at or above the match
}

const MAX_LINES = 8;
const MAX_CHARS = 500;
const MAX_LINE_CHARS = 600;
const BLOCK_REACH = 14; // how far to stretch an excerpt to keep a $$ or code block whole

type Block = { start: number; end: number; kind: 'math' | 'fence' };

/** For every line inside a `$$ … $$` or fenced block, the block it belongs to. */
function findBlocks(lines: string[]): (Block | undefined)[] {
	const owner = new Array<Block | undefined>(lines.length);
	const close = (start: number, end: number, kind: Block['kind']) => {
		const block = { start, end, kind };
		for (let i = start; i <= end; i++) owner[i] = block;
	};
	let fence: string | null = null;
	let inMath = false;
	let open = 0;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (!inMath) {
			const mark = /^(`{3,}|~{3,})/.exec(trimmed)?.[1];
			if (fence === null && mark) {
				fence = mark;
				open = i;
				continue;
			}
			if (fence !== null) {
				if (mark && mark[0] === fence[0] && mark.length >= fence.length && trimmed === mark) {
					close(open, i, 'fence');
					fence = null;
				}
				continue;
			}
		}
		if ((lines[i].match(/\$\$/g) ?? []).length % 2 === 1) {
			if (inMath) close(open, i, 'math');
			else open = i;
			inMath = !inMath;
		}
	}
	return owner;
}

/** Cut an over-long line at a space that is not inside inline math. */
function truncate(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	let inMath = false;
	let cut = -1;
	for (let i = 0; i < MAX_LINE_CHARS; i++) {
		const ch = line[i];
		if (ch === '\\') i++;
		else if (ch === '$') inMath = !inMath;
		else if (ch === ' ' && !inMath) cut = i;
	}
	return (cut > 0 ? line.slice(0, cut) : line.slice(0, MAX_LINE_CHARS)) + ' …';
}

/**
 * Block quotes and callouts are flattened to plain paragraphs (a callout title becomes
 * bold text) and horizontal rules are dropped: their boxes and margins cost more room
 * than a row has.
 */
function flatten(line: string): string {
	if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return '';
	const quoted = /^\s*(?:>\s?)+(.*)$/.exec(line);
	if (!quoted) return line;
	const callout = /^\[!\w+\][+-]?\s*(.*)$/.exec(quoted[1]);
	if (!callout) return quoted[1];
	return callout[1] ? `**${callout[1]}**` : '';
}

/** Make a line cheap and calm to render: no embeds, no big headings, no plugin code blocks. */
function tidy(line: string): string {
	return line
		.replace(/!\[\[/g, '[[')
		.replace(/!\[([^\]]*)\]\(/g, '[$1](')
		.replace(/%%.*?%%/g, '')
		.replace(/\s\^[\w-]+\s*$/, '')
		.replace(/^(\s*)#{1,6}\s+(.*?)\s*#*\s*$/, '$1**$2**')
		.replace(/^(\s*(?:`{3,}|~{3,})).*$/, '$1');
}

/**
 * How many lines the snippet has moved since the file was indexed: find the
 * first complete snippet line in the current file and compare positions.
 */
function drift(lines: string[], result: QmdResult): number {
	if (!result.snippetLine) return 0;
	const snippet = result.snippet.split('\n');
	for (let k = 0; k < snippet.length; k++) {
		const anchor = snippet[k].trim();
		if (anchor.length < 8 || anchor.endsWith('...')) continue;
		const expected = result.snippetLine - 1 + k;
		if (lines[expected]?.trim() === anchor) return 0;
		let best = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === anchor && (best < 0 || Math.abs(i - expected) < Math.abs(best - expected))) best = i;
		}
		return best < 0 ? 0 : best - expected;
	}
	return 0;
}

/**
 * Build the excerpt from the note itself rather than from qmd's 300-character cut,
 * so it always breaks on line boundaries and never splits a formula or code block.
 */
export async function buildExcerpt(app: App, result: QmdResult): Promise<Excerpt | null> {
	const file = result.file;
	if (!file) return null;
	const raw = (await app.vault.cachedRead(file)).split('\n');
	const cache = app.metadataCache.getFileCache(file);
	const last = raw.length - 1;
	const bodyStart = cache?.frontmatterPosition ? cache.frontmatterPosition.end.line + 1 : 0;

	let match = Math.min(last, Math.max(bodyStart, result.line - 1 + drift(raw, result)));
	const lines = raw.map((line, i) => (i < bodyStart ? line : flatten(line)));
	while (match < last && !lines[match].trim()) match++;

	let heading = '';
	let headingLine = -1;
	for (const h of cache?.headings ?? []) {
		if (h.position.start.line > match) break;
		heading = h.heading;
		headingLine = h.position.start.line;
	}

	const owner = findBlocks(lines);
	let start = match;
	// The heading is shown on its own row, so the excerpt starts below it.
	if (start === headingLine && start < last) {
		start++;
		while (start < last && !lines[start].trim()) start++;
	}
	let opener = '';
	const first = owner[start];
	if (first && first.start < start) {
		if (first.kind === 'math' || start - first.start <= BLOCK_REACH) start = first.start;
		else opener = '```'; // deep inside a long code block: show it from the match
	}

	let end = start;
	let chars = 0;
	let count = 0;
	for (let i = start; i <= last && count < MAX_LINES && chars < MAX_CHARS; i++) {
		end = i;
		chars += lines[i].length;
		if (lines[i].trim()) count++;
	}
	let closer = '';
	const tail = owner[end];
	if (tail && tail.end > end) {
		if (tail.end - end <= BLOCK_REACH) end = tail.end;
		else closer = tail.kind === 'math' ? '$$' : '```';
	}

	const body = lines
		.slice(start, end + 1)
		.map((line, i) => tidy(owner[start + i] ? line : truncate(line)))
		// one blank line is a paragraph break; more is just empty space
		.filter((line, i, all) => line.trim() || (i > 0 && all[i - 1].trim()));
	const markdown = [opener, ...body, closer].filter((line, i, all) => line || (i > 0 && i < all.length - 1)).join('\n');
	return { markdown: markdown.trim(), startLine: start, endLine: end, matchLine: match, heading };
}

const rendered = new Map<string, HTMLElement>();
let mathReady: Promise<void> | null = null;

const cacheKey = (file: TFile, excerpt: Excerpt) =>
	`${file.path}:${excerpt.startLine}:${excerpt.endLine}:${file.stat.mtime}`;

/** An already rendered excerpt, if there is one, so a row can show it without a flash. */
export function cachedExcerpt(file: TFile, excerpt: Excerpt): HTMLElement | null {
	const node = rendered.get(cacheKey(file, excerpt));
	return node ? (node.cloneNode(true) as HTMLElement) : null;
}

/** Render an excerpt (markdown + math) off-screen and return a copy to place in a row. */
export async function renderExcerpt(app: App, file: TFile, excerpt: Excerpt, component: Component): Promise<HTMLElement> {
	const key = cacheKey(file, excerpt);
	let node = rendered.get(key);
	if (!node) {
		await (mathReady ??= loadMathJax());
		node = createDiv();
		await MarkdownRenderer.render(app, excerpt.markdown, node, file.path, component);
		await finishRenderMath();
		if (rendered.size >= 300) rendered.delete(rendered.keys().next().value as string);
		rendered.set(key, node);
	}
	return node.cloneNode(true) as HTMLElement;
}
