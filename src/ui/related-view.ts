import { debounce, HoverParent, HoverPopover, ItemView, setIcon, setTooltip, TFile, WorkspaceLeaf } from 'obsidian';
import type QmdPlugin from '../main';
import { isAbort } from '../types';
import { ResultList } from './result-list';

export const VIEW_TYPE_RELATED = 'qmd-related-view';

/** Notes semantically close to the note you are on; follows the active note. */
export class QmdRelatedView extends ItemView implements HoverParent {
	hoverPopover: HoverPopover | null = null;
	private list: ResultList | null = null;
	private relatedTitleEl: HTMLElement | null = null;
	private abort: AbortController | null = null;
	private shownFor = ''; // path:mtime the list currently reflects
	private stale = false; // the active note changed while the panel was hidden

	private schedule = debounce(() => void this.refresh(), 800, true);

	constructor(leaf: WorkspaceLeaf, private plugin: QmdPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_RELATED;
	}

	getDisplayText(): string {
		return 'QMD related notes';
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('qmd-view');
		const root = this.contentEl.createDiv({ cls: 'qmd-pane' });

		const header = root.createDiv({ cls: 'qmd-related-header' });
		this.relatedTitleEl = header.createDiv({ cls: 'qmd-related-title', text: 'Related notes' });
		const refreshBtn = header.createDiv({ cls: 'clickable-icon' });
		setIcon(refreshBtn, 'refresh-cw');
		setTooltip(refreshBtn, 'Refresh');
		refreshBtn.onclick = () => void this.refresh(true);

		this.list = new ResultList(
			{
				app: this.app,
				component: this,
				hoverParent: this,
				hoverDelay: () => this.plugin.settings.hoverDelayMs,
				onUpdateIndex: () => void this.plugin.indexer.run(),
			},
			root.createDiv()
		);

		this.registerEvent(this.app.workspace.on('file-open', () => this.schedule()));
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.schedule()));
		this.register(this.plugin.server.onChange(() => this.schedule()));
		void this.refresh();
	}

	async onClose(): Promise<void> {
		this.abort?.abort();
	}

	onResize(): void {
		// Also fires when the tab becomes visible again.
		if (this.stale) this.schedule();
	}

	private async refresh(force = false): Promise<void> {
		const list = this.list;
		if (!list) return;
		if (!this.contentEl.isShown()) {
			this.stale = true;
			return;
		}
		this.stale = false;

		// When the sidebar has focus this is still the last note worked on.
		const file = this.app.workspace.getActiveFile();
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		const key = `${file.path}:${file.stat.mtime}`;
		if (!force && key === this.shownFor) return;

		this.abort?.abort();
		const abort = (this.abort = new AbortController());
		this.relatedTitleEl?.setText(`Related to ${file.basename}`);
		try {
			const results = await this.plugin.search.related(file, abort.signal);
			if (abort.signal.aborted) return;
			await list.set(results, 'No related notes found.');
			this.shownFor = key;
		} catch (e) {
			if (abort.signal.aborted || isAbort(e)) return;
			this.shownFor = '';
			list.message(e instanceof Error ? e.message : String(e));
		}
	}
}
