import { App, Editor, EditorRange, MarkdownView, PaneType, TFile } from 'obsidian';

/** Obsidian's own flash highlight, which the public Editor type does not declare. */
type FlashingEditor = Editor & {
	addHighlights?: (ranges: EditorRange[], cls: string, removePrevious: boolean, scroll: boolean) => void;
	removeHighlights?: (cls: string) => void;
};

/**
 * Open a note at the matched lines (0-based) and flash them, the way core search does.
 */
export async function openAtMatch(
	app: App,
	file: TFile,
	matchLine: number,
	endLine: number,
	pane: PaneType | boolean
): Promise<void> {
	const leaf = app.workspace.getLeaf(pane);
	await leaf.openFile(file, { active: true, eState: { line: matchLine } });

	const view = leaf.view;
	if (!(view instanceof MarkdownView) || view.getMode() !== 'source') return;
	const editor: FlashingEditor = view.editor;
	const from = Math.min(matchLine, editor.lastLine());
	const to = Math.min(Math.max(endLine, from), editor.lastLine());
	const range: EditorRange = { from: { line: from, ch: 0 }, to: { line: to, ch: editor.getLine(to).length } };

	editor.setCursor(range.from);
	editor.scrollIntoView(range, true);
	if (editor.addHighlights && editor.removeHighlights) {
		editor.addHighlights([range], 'is-flashing', true, true);
		window.setTimeout(() => editor.removeHighlights?.('is-flashing'), 2000);
	}
}

/** A link to `file` in the format the vault is configured to use. */
export function linkTo(app: App, file: TFile): string {
	return app.fileManager.generateMarkdownLink(file, app.workspace.getActiveFile()?.path ?? '');
}

/** Insert text at the cursor of the note the user was last working in. */
export function insertIntoEditor(app: App, text: string): boolean {
	const view =
		app.workspace.getActiveViewOfType(MarkdownView) ??
		(app.workspace.getMostRecentLeaf()?.view as MarkdownView | undefined);
	if (!(view instanceof MarkdownView)) return false;
	view.editor.replaceSelection(text);
	return true;
}
