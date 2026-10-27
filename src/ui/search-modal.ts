import { Component, Modal } from 'obsidian';
import type QmdPlugin from '../main';
import { SearchPane } from './search-pane';

const KEYS: [string, string][] = [
	['↑↓', 'navigate'],
	['↵', 'open'],
	['ctrl ↵', 'new tab'],
	['ctrl alt ↵', 'split'],
	['shift ↵', 'deep search'],
	['alt ↵', 'insert link'],
	['esc', 'close'],
];

/** Keyboard-driven quick search. */
export class QmdSearchModal extends Modal {
	private pane: SearchPane | null = null;
	private component = new Component();

	constructor(private plugin: QmdPlugin, private initialQuery = '') {
		super(plugin.app);
	}

	onOpen(): void {
		this.modalEl.addClass('qmd-modal');
		this.contentEl.empty();
		this.component.load();
		this.pane = new SearchPane(this.plugin, this.contentEl, {
			component: this.component,
			autoSelect: true,
			debounceMs: 200,
			onChoose: () => this.close(),
		});

		const footer = this.contentEl.createDiv({ cls: 'qmd-instructions' });
		for (const [key, action] of KEYS) {
			const item = footer.createSpan({ cls: 'qmd-instruction' });
			item.createSpan({ cls: 'qmd-instruction-key', text: key });
			item.appendText(` ${action}`);
		}

		if (this.initialQuery) this.pane.setQuery(this.initialQuery);
		this.pane.inputEl.focus();
	}

	onClose(): void {
		this.pane?.destroy();
		this.pane = null;
		this.component.unload();
		this.contentEl.empty();
	}
}
