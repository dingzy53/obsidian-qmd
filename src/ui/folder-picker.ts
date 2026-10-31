import { App, FuzzySuggestModal, TFolder } from 'obsidian';

/** Fuzzy folder picker, for the "Exclude a folder" button in settings. */
export class FolderPicker extends FuzzySuggestModal<TFolder> {
	constructor(app: App, private folders: TFolder[], private onPick: (path: string) => void) {
		super(app);
		this.setPlaceholder('Folder to exclude');
	}

	getItems(): TFolder[] {
		return this.folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onPick(folder.path);
	}
}
