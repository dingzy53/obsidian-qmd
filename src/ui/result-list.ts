import {
	App,
	Component,
	finishRenderMath,
	HoverParent,
	Keymap,
	loadMathJax,
	Menu,
	Notice,
	PaneType,
	renderMath,
	TFile,
} from 'obsidian';
import { QmdResult } from '../types';
import { insertIntoEditor, linkTo, openAtMatch } from '../utils';
import { buildExcerpt, cachedExcerpt, Excerpt, renderExcerpt } from './snippet';

export const HOVER_SOURCE = 'qmd-search';

export interface ResultListHost {
	app: App;
	/** Owns the rendered markdown; unloaded with the surface. */
	component: Component;
	/** Set for sidebar views to enable hover page preview. */
	hoverParent?: HoverParent;
	/** Called just before a result is opened (the modal closes itself here). */
	onOpen?: (result: QmdResult) => void;
	onUpdateIndex: () => void;
}

/** Obsidian's internal drag source, so a dragged row behaves like a dragged file. */
interface DragManager {
	dragFile(evt: globalThis.DragEvent, file: TFile): unknown;
	onDragStart(evt: globalThis.DragEvent, data: unknown): void;
}

/**
 * The compact result rows shared by the search modal, the search panel and
 * the related-notes panel.
 */
export class ResultList {
	private results: QmdResult[] = [];
	private rows: HTMLElement[] = [];
	private excerpts = new Map<QmdResult, Excerpt>();
	private index = -1;
	private generation = 0;

	constructor(private host: ResultListHost, readonly el: HTMLElement, private autoSelect = false) {
		el.addClass('qmd-results');
	}

	get size(): number {
		return this.results.length;
	}

	/** Replace the rows. The old rows stay on screen until the new ones are ready. */
	async set(results: QmdResult[], emptyText = 'No matching notes.'): Promise<void> {
		const generation = ++this.generation;
		const { app } = this.host;
		const excerpts = await Promise.all(results.map((r) => buildExcerpt(app, r).catch(() => null)));
		if (generation !== this.generation) return;

		this.results = results;
		this.excerpts = new Map();
		this.rows = [];
		this.index = -1;
		const fragment = createFragment();
		const pending: { result: QmdResult; excerpt: Excerpt; snippetEl: HTMLElement }[] = [];

		results.forEach((result, i) => {
			const excerpt = excerpts[i];
			if (excerpt) this.excerpts.set(result, excerpt);
			const row = fragment.createDiv({ cls: 'qmd-row' });
			this.rows.push(row);
			const snippetEl = this.fillRow(row, result, excerpt);
			if (result.file && excerpt && snippetEl) {
				const ready = cachedExcerpt(result.file, excerpt);
				if (ready) snippetEl.replaceChildren(...Array.from(ready.childNodes));
				else pending.push({ result, excerpt, snippetEl });
			}
		});

		this.el.empty();
		if (results.length === 0) this.el.createDiv({ cls: 'qmd-empty', text: emptyText });
		this.el.append(fragment);
		this.el.scrollTop = 0;
		if (this.autoSelect && results.length > 0) this.select(0);

		// Rows are up; the rendered excerpts follow without holding up the caller.
		void this.renderPending(pending, generation);
	}

	private async renderPending(
		pending: { result: QmdResult; excerpt: Excerpt; snippetEl: HTMLElement }[],
		generation: number
	): Promise<void> {
		for (const { result, excerpt, snippetEl } of pending) {
			if (generation !== this.generation || !result.file) return;
			try {
				const node = await renderExcerpt(this.host.app, result.file, excerpt, this.host.component);
				if (generation !== this.generation) return;
				snippetEl.replaceChildren(...Array.from(node.childNodes));
			} catch (e) {
				console.warn('[qmd-search] could not render excerpt:', e);
			}
		}
	}

	/** Show a plain message instead of rows. */
	message(text: string): void {
		this.generation++;
		this.results = [];
		this.rows = [];
		this.index = -1;
		this.el.empty();
		if (text) this.el.createDiv({ cls: 'qmd-empty', text });
	}

	private fillRow(row: HTMLElement, result: QmdResult, excerpt: Excerpt | null): HTMLElement | null {
		const file = result.file;
		const name = result.path.split('/').pop() ?? result.path;
		row.createDiv({ cls: 'qmd-row-title', text: name.replace(/\.md$/i, '') });

		if (!file) {
			row.addClass('is-stale');
			const info = row.createDiv({ cls: 'qmd-row-path', text: 'Not in the vault any more. ' });
			const update = info.createEl('a', { text: 'Update index' });
			update.onclick = (evt) => {
				evt.stopPropagation();
				this.host.onUpdateIndex();
			};
			return null;
		}

		const folder = file.parent?.path ?? '';
		if (folder && folder !== '/') row.createDiv({ cls: 'qmd-row-path', text: folder });
		if (excerpt?.heading && excerpt.heading !== file.basename) {
			const headingEl = row.createDiv({ cls: 'qmd-row-heading', text: `§ ${excerpt.heading}` });
			if (excerpt.heading.includes('$')) void this.typesetHeading(headingEl, excerpt.heading);
		}
		const snippetEl = row.createDiv({ cls: 'qmd-row-snippet markdown-rendered' });
		snippetEl.setText((excerpt?.markdown ?? result.snippet).trim());

		row.onclick = (evt) => void this.open(result, Keymap.isModEvent(evt));
		row.onauxclick = (evt) => {
			if (evt.button === 1) void this.open(result, 'tab');
		};
		row.oncontextmenu = (evt) => this.showMenu(evt, result, file);
		row.onmousemove = () => {
			if (this.autoSelect) this.select(this.rows.indexOf(row), false);
		};

		const hoverParent = this.host.hoverParent;
		if (hoverParent) {
			row.onmouseover = (event) => {
				this.host.app.workspace.trigger('hover-link', {
					event,
					source: HOVER_SOURCE,
					hoverParent,
					targetEl: row,
					linktext: file.path,
					sourcePath: '',
					state: { scroll: excerpt?.matchLine ?? Math.max(0, result.line - 1) },
				});
			};
		}

		row.draggable = true;
		row.ondragstart = (evt) => {
			const dragManager = (this.host.app as App & { dragManager?: DragManager }).dragManager;
			if (dragManager?.dragFile && dragManager?.onDragStart) {
				dragManager.onDragStart(evt, dragManager.dragFile(evt, file));
			} else {
				evt.dataTransfer?.setData('text/plain', linkTo(this.host.app, file));
			}
		};
		return snippetEl;
	}

	/** Headings such as "Continuity of $f(x)$" would otherwise show raw LaTeX. */
	private async typesetHeading(el: HTMLElement, heading: string): Promise<void> {
		try {
			await loadMathJax();
			el.setText('§ ');
			heading.split(/\$([^$]+)\$/).forEach((part, i) => {
				if (i % 2) el.append(renderMath(part, false));
				else el.appendText(part);
			});
			await finishRenderMath();
		} catch {
			el.setText(`§ ${heading}`);
		}
	}

	private showMenu(evt: MouseEvent, result: QmdResult, file: TFile): void {
		const { app } = this.host;
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle('Open in new tab').setIcon('file-plus').onClick(() => void this.open(result, 'tab'))
		);
		menu.addItem((item) =>
			item.setTitle('Open to the right').setIcon('separator-vertical').onClick(() => void this.open(result, 'split'))
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle('Copy link').setIcon('link').onClick(() => {
				void navigator.clipboard.writeText(linkTo(app, file));
				new Notice('Link copied');
			})
		);
		menu.addItem((item) =>
			item.setTitle('Insert link at cursor').setIcon('text-cursor-input').onClick(() => this.insertLink(result))
		);
		menu.addSeparator();
		app.workspace.trigger('file-menu', menu, file, HOVER_SOURCE);
		menu.showAtMouseEvent(evt);
	}

	async open(result: QmdResult, pane: PaneType | boolean): Promise<void> {
		if (!result.file) {
			new Notice('This note is not in the vault any more. Update the index.');
			return;
		}
		const excerpt = this.excerpts.get(result);
		const matchLine = excerpt?.matchLine ?? Math.max(0, result.line - 1);
		this.host.onOpen?.(result);
		await openAtMatch(this.host.app, result.file, matchLine, excerpt?.endLine ?? matchLine, pane);
	}

	insertLink(result: QmdResult): void {
		if (!result.file) return;
		const link = linkTo(this.host.app, result.file);
		this.host.onOpen?.(result);
		if (!insertIntoEditor(this.host.app, link)) {
			void navigator.clipboard.writeText(link);
			new Notice('No note is open to insert into. Link copied instead.');
		}
	}

	selected(): QmdResult | null {
		return this.results[this.index] ?? null;
	}

	/** Move the keyboard selection, wrapping at the ends. */
	move(delta: number): void {
		const count = this.rows.length;
		if (count === 0) return;
		const next = this.index < 0 ? (delta > 0 ? 0 : count - 1) : (this.index + delta + count) % count;
		this.select(next);
	}

	private select(index: number, scroll = true): void {
		if (index === this.index || index < 0) return;
		this.rows[this.index]?.removeClass('is-selected');
		this.index = index;
		const row = this.rows[index];
		row?.addClass('is-selected');
		if (scroll) row?.scrollIntoView({ block: 'nearest' });
	}
}
