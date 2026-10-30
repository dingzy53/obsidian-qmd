import { debounce, FileSystemAdapter, Menu, Notice, Plugin, setTooltip } from 'obsidian';
import { QmdIndexer } from './qmd/indexer';
import { QmdRunner } from './qmd/runner';
import { QmdSearch } from './qmd/search';
import { QmdServer } from './qmd/server';
import { QmdSettingTab } from './settings';
import { DEFAULT_SETTINGS, QmdSettings } from './types';
import { QmdRelatedView, VIEW_TYPE_RELATED } from './ui/related-view';
import { HOVER_SOURCE } from './ui/result-list';
import { QmdSearchModal } from './ui/search-modal';
import { QmdSearchView, VIEW_TYPE_SEARCH } from './ui/search-view';

const HISTORY_SIZE = 20;

export default class QmdPlugin extends Plugin {
	settings: QmdSettings = DEFAULT_SETTINGS;
	vaultPath = '';
	runner!: QmdRunner;
	server!: QmdServer;
	search!: QmdSearch;
	indexer!: QmdIndexer;

	private statusDot: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private reconfigure = debounce(() => void this.applyConfig(), 1000, true);

	async onload(): Promise<void> {
		await this.loadSettings();

		const adapter = this.app.vault.adapter;
		this.vaultPath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
		const getSettings = () => this.settings;
		this.runner = new QmdRunner(getSettings, this.vaultPath);
		this.server = new QmdServer(this.runner, getSettings);
		this.search = new QmdSearch(this.app, this.runner, this.server, getSettings, this.vaultPath);
		this.indexer = new QmdIndexer(this.runner, this.server, this.search, getSettings, () => this.saveSettings());

		this.registerView(VIEW_TYPE_SEARCH, (leaf) => new QmdSearchView(leaf, this));
		this.registerView(VIEW_TYPE_RELATED, (leaf) => new QmdRelatedView(leaf, this));
		this.registerHoverLinkSource(HOVER_SOURCE, { display: 'QMD Vault Search', defaultMod: false });

		this.addRibbonIcon('sparkles', 'Open vault search', () => void this.openSearchView());

		this.addCommand({
			id: 'search',
			name: 'Search',
			callback: () => new QmdSearchModal(this).open(),
		});
		this.addCommand({
			id: 'open-search-panel',
			name: 'Open search panel',
			callback: () => void this.openSearchView(),
		});
		this.addCommand({
			id: 'open-related-notes',
			name: 'Open related notes',
			callback: () =>
				void this.app.workspace.ensureSideLeaf(VIEW_TYPE_RELATED, 'right', { active: true, reveal: true }),
		});
		this.addCommand({
			id: 'search-selection',
			name: 'Search selected text',
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection().trim();
				if (!selection) return false;
				if (!checking) void this.openSearchView(selection);
				return true;
			},
		});
		this.addCommand({
			id: 'update-index',
			name: 'Update index now',
			callback: () => void this.updateIndex(),
		});
		this.addCommand({
			id: 'restart-server',
			name: 'Restart qmd server',
			callback: () => void this.server.restart(),
		});

		this.addSettingTab(new QmdSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('qmd-statusbar', 'mod-clickable');
		this.statusDot = this.statusEl.createSpan({ cls: 'qmd-status-dot' });
		this.statusEl.createSpan({ text: 'QMD' });
		this.statusEl.onclick = (evt) => this.showStatusMenu(evt);
		this.register(this.server.onChange(() => this.refreshStatus()));
		this.register(this.indexer.onChange(() => this.refreshStatus()));
		this.refreshStatus();

		this.registerEvent(this.app.workspace.on('quit', () => void this.server.stop()));
		this.app.workspace.onLayoutReady(() => void this.start());
	}

	onunload(): void {
		this.indexer.abort();
		void this.server.stop();
	}

	private async start(): Promise<void> {
		await this.runner.verify();
		this.refreshStatus();
		if (this.runner.problem) new Notice(`QMD: ${this.runner.problem}`, 10000);
		void this.server.start();
		this.indexer.schedule(this);
	}

	/** The index location, binary or server settings changed: check again and restart the server. */
	private async applyConfig(): Promise<void> {
		this.runner.resetBinary();
		this.search.invalidate();
		await this.server.stop();
		await this.runner.verify();
		this.refreshStatus();
		await this.server.start();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<QmdSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...saved };
	}

	async saveSettings(reconfigure = false): Promise<void> {
		await this.saveData(this.settings);
		if (reconfigure) this.reconfigure();
	}

	/** Put a query at the top of the recent-searches list. */
	remember(query: string): void {
		const text = query.trim();
		if (!text || this.settings.history[0] === text) return;
		this.settings.history = [text, ...this.settings.history.filter((q) => q !== text)].slice(0, HISTORY_SIZE);
		void this.saveSettings();
	}

	async openSearchView(query?: string): Promise<void> {
		const leaf = await this.app.workspace.ensureSideLeaf(VIEW_TYPE_SEARCH, 'right', { active: true, reveal: true });
		if (!(leaf.view instanceof QmdSearchView)) return;
		if (query) leaf.view.pane?.setQuery(query);
		leaf.view.focusInput();
	}

	private async updateIndex(): Promise<void> {
		await this.indexer.run();
		const failed = this.indexer.state === 'error';
		new Notice(`Index ${failed ? 'refresh failed: ' : 'refreshed: '}${this.indexer.message}`, failed ? 10000 : 4000);
	}

	refreshStatus(): void {
		if (!this.statusEl || !this.statusDot) return;
		let cls = 'is-off';
		let text = 'Server off: keyword search only';
		if (this.runner.problem) {
			cls = 'is-error';
			text = this.runner.problem;
		} else if (this.indexer.state === 'updating' || this.indexer.state === 'embedding') {
			cls = 'is-busy';
			text = this.indexer.state === 'updating' ? 'Updating index…' : 'Embedding changed notes…';
		} else if (this.indexer.state === 'error') {
			cls = 'is-error';
			text = `Index refresh failed: ${this.indexer.message}`;
		} else if (this.server.state === 'ready') {
			cls = 'is-ready';
			text = `Ready (server on port ${this.server.port})`;
		} else if (this.server.state === 'starting') {
			cls = 'is-busy';
			text = 'Starting server…';
		} else if (this.server.state === 'failed') {
			cls = 'is-error';
			text = 'Server failed to start: keyword search only';
		}
		const lastRun = this.settings.lastIndexRun
			? `\nIndex refreshed ${new Date(this.settings.lastIndexRun).toLocaleString()}`
			: '';
		this.statusDot.className = `qmd-status-dot ${cls}`;
		setTooltip(this.statusEl, `QMD: ${text}${lastRun}`, { placement: 'top' });
	}

	private showStatusMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle('Update index now').setIcon('refresh-cw').onClick(() => void this.updateIndex())
		);
		menu.addItem((item) =>
			item.setTitle('Restart qmd server').setIcon('rotate-ccw').onClick(() => void this.server.restart())
		);
		menu.addItem((item) =>
			item.setTitle('Settings').setIcon('settings').onClick(() => {
				const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
				setting?.open();
				setting?.openTabById(this.manifest.id);
			})
		);
		menu.showAtMouseEvent(evt);
	}
}
