import { AbstractInputSuggest, App, TFolder } from 'obsidian';

/** Folder autocomplete for the folder-filter field. */
export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(app: App, inputEl: HTMLInputElement, private onPick: (path: string) => void) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		const needle = query.toLowerCase();
		return this.app.vault
			.getAllFolders()
			.filter((folder) => folder.path.toLowerCase().includes(needle))
			.sort((a, b) => a.path.length - b.path.length)
			.slice(0, 30);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		this.onPick(folder.path);
		this.close();
	}
}
