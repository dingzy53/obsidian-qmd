import { HoverParent, HoverPopover, ItemView, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import type QmdPlugin from '../main';
import { SearchPane } from './search-pane';

export const VIEW_TYPE_SEARCH = 'qmd-search-view';

interface SearchViewState {
	query?: string;
	folder?: string;
}

/** Sidebar search panel: results stay visible while you work. */
export class QmdSearchView extends ItemView implements HoverParent {
	hoverPopover: HoverPopover | null = null;
	pane: SearchPane | null = null;
	private restored: SearchViewState = {};

	constructor(leaf: WorkspaceLeaf, private plugin: QmdPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_SEARCH;
	}

	getDisplayText(): string {
		return 'QMD search';
	}

	getIcon(): string {
		return 'sparkles';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('qmd-view');
		this.pane = new SearchPane(this.plugin, this.contentEl, {
			component: this,
			hoverParent: this,
			autoSelect: false,
			debounceMs: 300,
		});
		if (this.restored.query) this.pane.setQuery(this.restored.query, this.restored.folder);
	}

	async onClose(): Promise<void> {
		this.pane?.destroy();
		this.pane = null;
	}

	getState(): Record<string, unknown> {
		return { query: this.pane?.query ?? '', folder: this.pane?.folder ?? '' };
	}

	async setState(state: SearchViewState, result: ViewStateResult): Promise<void> {
		this.restored = state ?? {};
		if (this.pane && this.restored.query && this.restored.query !== this.pane.query) {
			this.pane.setQuery(this.restored.query, this.restored.folder);
		}
		await super.setState(state, result);
	}

	focusInput(): void {
		this.pane?.inputEl.focus();
		this.pane?.inputEl.select();
	}
}
