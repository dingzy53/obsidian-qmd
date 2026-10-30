import { Component, HoverParent, Keymap, setIcon, setTooltip } from 'obsidian';
import type QmdPlugin from '../main';
import { isAbort } from '../types';
import { FolderSuggest } from './folder-suggest';
import { ResultList } from './result-list';

export interface SearchPaneOptions {
	component: Component;
	hoverParent?: HoverParent;
	/** Modal: the first row is selected so Enter opens it. */
	autoSelect: boolean;
	debounceMs: number;
	/** Called when a result has been chosen (the modal closes itself). */
	onChoose?: () => void;
}

/**
 * Query box, folder filter, status line and results: everything the search
 * modal and the sidebar panel have in common.
 */
export class SearchPane {
	readonly inputEl: HTMLInputElement;
	readonly list: ResultList;

	private folderEl: HTMLInputElement;
	private statusEl: HTMLElement;
	private historyEl: HTMLElement;
	private abort: AbortController | null = null;
	private timer: number | null = null;
	private ticker: number | null = null;
	private degraded = false;
	private offServer: () => void;

	constructor(private plugin: QmdPlugin, containerEl: HTMLElement, private opts: SearchPaneOptions) {
		const root = containerEl.createDiv({ cls: 'qmd-pane' });

		const inputRow = root.createDiv({ cls: 'qmd-input-row' });
		this.inputEl = inputRow.createEl('input', {
			type: 'text',
			cls: 'qmd-query',
			attr: { placeholder: 'Search notes…', spellcheck: 'false' },
		});
		const deepBtn = inputRow.createDiv({ cls: 'clickable-icon qmd-deep-btn' });
		setIcon(deepBtn, 'sparkles');
		setTooltip(deepBtn, 'Deep search: expand the query with the LLM (slow). Shift+Enter');
		deepBtn.onclick = () => void this.run('deep');

		const filterRow = root.createDiv({ cls: 'qmd-filter-row' });
		setIcon(filterRow.createSpan({ cls: 'qmd-filter-icon' }), 'folder');
		this.folderEl = filterRow.createEl('input', {
			type: 'text',
			cls: 'qmd-folder',
			attr: { placeholder: 'All folders', spellcheck: 'false' },
		});
		const clearBtn = filterRow.createDiv({ cls: 'clickable-icon qmd-folder-clear' });
		setIcon(clearBtn, 'x');
		setTooltip(clearBtn, 'Clear folder filter');
		clearBtn.onclick = () => {
			this.folderEl.value = '';
			void this.run('fast');
		};
		this.statusEl = filterRow.createSpan({ cls: 'qmd-status-text' });

		this.historyEl = root.createDiv({ cls: 'qmd-history' });
		this.list = new ResultList(
			{
				app: plugin.app,
				component: opts.component,
				hoverParent: opts.hoverParent,
				hoverDelay: () => plugin.settings.hoverDelayMs,
				onOpen: () => {
					plugin.remember(this.query);
					opts.onChoose?.();
				},
				onUpdateIndex: () => void plugin.indexer.run(),
			},
			root.createDiv(),
			opts.autoSelect
		);

		new FolderSuggest(plugin.app, this.folderEl, () => void this.run('fast'));
		this.folderEl.onchange = () => void this.run('fast');
		this.inputEl.oninput = () => this.schedule();
		this.inputEl.onkeydown = (evt) => this.onKey(evt);

		// A search answered with keywords only (server still starting) reruns once it is up.
		this.offServer = plugin.server.onChange(() => {
			if (this.degraded && plugin.server.state === 'ready') void this.run('fast');
		});
		this.showHistory();
	}

	get query(): string {
		return this.inputEl.value.trim();
	}

	get folder(): string {
		return this.folderEl.value.trim().replace(/\/+$/, '');
	}

	setQuery(query: string, folder = ''): void {
		this.inputEl.value = query;
		this.folderEl.value = folder;
		void this.run('fast');
	}

	destroy(): void {
		this.abort?.abort();
		this.stopTimers();
		this.offServer();
	}

	private stopTimers(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		if (this.ticker !== null) window.clearInterval(this.ticker);
		this.timer = this.ticker = null;
	}

	private schedule(): void {
		if (this.timer !== null) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.run('fast'), this.opts.debounceMs);
	}

	private onKey(evt: KeyboardEvent): void {
		if (evt.isComposing) return;
		if (evt.key === 'ArrowDown' || evt.key === 'ArrowUp') {
			evt.preventDefault();
			// On an empty box, Up recalls the most recent query.
			if (evt.key === 'ArrowUp' && !this.query && this.plugin.settings.history.length > 0) {
				this.setQuery(this.plugin.settings.history[0], this.folder);
			} else {
				this.list.move(evt.key === 'ArrowDown' ? 1 : -1);
			}
			return;
		}
		if (evt.key !== 'Enter') return;
		evt.preventDefault();

		const selected = this.list.selected();
		const pane = Keymap.isModEvent(evt);
		if (evt.shiftKey && !pane) {
			void this.run('deep');
		} else if (!selected) {
			void this.run('fast');
		} else if (evt.altKey && !pane) {
			this.list.insertLink(selected);
		} else {
			void this.list.open(selected, pane);
		}
	}

	private setStatus(text: string, cls = ''): void {
		this.statusEl.setText(text);
		this.statusEl.className = `qmd-status-text ${cls}`;
	}

	private showHistory(): void {
		this.setStatus('');
		this.list.message('');
		this.historyEl.empty();
		const { history } = this.plugin.settings;
		if (history.length === 0) return;
		this.historyEl.createDiv({ cls: 'qmd-history-label', text: 'Recent searches' });
		for (const query of history) {
			const item = this.historyEl.createDiv({ cls: 'qmd-history-item', text: query });
			item.onclick = () => {
				this.setQuery(query, this.folder);
				this.inputEl.focus();
			};
		}
	}

	async run(kind: 'fast' | 'deep'): Promise<void> {
		this.abort?.abort();
		this.stopTimers();
		const query = this.query;
		if (!query) {
			this.abort = null;
			this.degraded = false;
			this.showHistory();
			return;
		}
		this.historyEl.empty();
		const abort = (this.abort = new AbortController());
		const started = Date.now();
		const elapsed = () => ((Date.now() - started) / 1000).toFixed(1);

		if (kind === 'deep') {
			this.plugin.remember(query);
			this.setStatus('Deep search… 0 s', 'is-busy');
			this.ticker = window.setInterval(
				() => this.setStatus(`Deep search… ${Math.round((Date.now() - started) / 1000)} s`, 'is-busy'),
				1000
			);
		} else {
			this.setStatus('Searching…', 'is-busy');
		}

		try {
			const options = { folder: this.folder || undefined, signal: abort.signal };
			const outcome =
				kind === 'deep'
					? await this.plugin.search.deep(query, options)
					: await this.plugin.search.fast(query, options);
			if (abort.signal.aborted) return;
			await this.list.set(outcome.results);
			if (this.abort !== abort) return;

			this.degraded = outcome.degraded;
			const count = outcome.results.length;
			const parts = [`${count} ${count === 1 ? 'result' : 'results'}`, `${elapsed()} s`];
			if (kind === 'deep') parts.push('deep');
			if (outcome.degraded) parts.push('keywords only');
			this.setStatus(parts.join(' · '), outcome.degraded ? 'is-warning' : '');
		} catch (e) {
			if (abort.signal.aborted || isAbort(e)) return;
			this.setStatus(e instanceof Error ? e.message : String(e), 'is-error');
		} finally {
			if (this.abort === abort && this.ticker !== null) {
				window.clearInterval(this.ticker);
				this.ticker = null;
			}
		}
	}
}
