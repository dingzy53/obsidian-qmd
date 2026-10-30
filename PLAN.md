# Delay the hover page preview in the sidebar panels

## Context

In the right sidebar (the **search panel** and the **related-notes panel**), moving the mouse over a result row opens Obsidian's page preview almost straight away. If you're just moving the pointer across the list, popovers keep opening over the notes. The goal is for a preview to appear only after the pointer has rested on one row for a moment: 2 s by default, adjustable in settings. Holding Ctrl/Cmd still shows the preview straight away, as it does everywhere else in Obsidian.

**Cause** (`src/ui/result-list.ts:153-165`): `fillRow()` sets `row.onmouseover`, which triggers `workspace.trigger('hover-link', …)` straight away. `mouseover` bubbles, so it fires again every time the pointer crosses a child element (title, folder, heading, snippet, math). The hover source is registered with `defaultMod: false` in `src/main.ts:40`, so no modifier key is needed. The only wait is Obsidian's own short internal delay.

The quick-search modal has no `hoverParent`, so it isn't affected and stays the same.

## Steps

### 0. Branch and PLAN.md
- `git switch -c feat/hover-preview-delay` (from `main`; the tree is clean).
- Write `PLAN.md` at the repo root with the content of this plan: context, design, file changes and verification. Leave it uncommitted, like the code, until the user asks for a commit.

### 1. Setting: `src/types.ts`
- Add `hoverDelayMs: number; // wait before showing the page preview in the sidebar; 0 = Obsidian's default` to `QmdSettings`.
- Add `hoverDelayMs: 2000` to `DEFAULT_SETTINGS`. Existing installs pick it up through the `Object.assign` in `loadSettings`.

### 2. Settings UI: `src/settings.ts`, *Search* section
Add a slider, following the existing `Search results` and `Rerank candidates` sliders:
```ts
new Setting(containerEl)
	.setName('Hover preview delay')
	.setDesc('In the sidebar panels, how long to rest on a result before its preview opens, in milliseconds. Hold Ctrl (Cmd on macOS) to preview at once.')
	.addSlider((slider) =>
		slider.setLimits(0, 5000, 250).setValue(settings.hoverDelayMs).setDynamicTooltip()
			.onChange(async (value) => { settings.hoverDelayMs = value; await plugin.saveSettings(); })
	);
```
`saveSettings()` without `true` is correct here: the server doesn't need a restart.

### 3. Hosts pass the delay: `ResultListHost`
- `src/ui/result-list.ts`: add `/** Milliseconds to wait before the hover preview opens. */ hoverDelay?: () => number;` to `ResultListHost`. It's a getter, so a change in settings applies right away without re-rendering.
- `src/ui/search-pane.ts` (~line 66): pass `hoverDelay: () => plugin.settings.hoverDelayMs` when building the `ResultList`.
- `src/ui/related-view.ts` (~line 48): pass `hoverDelay: () => this.plugin.settings.hoverDelayMs`.

### 4. Delayed trigger: `src/ui/result-list.ts`
Add one pending timer per list, since only one row can be under the pointer at a time:
```ts
private hoverTimer: number | null = null;

private cancelHover(): void {
	if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
	this.hoverTimer = null;
}
```
In `fillRow()`, replace the `onmouseover` block:
- Build the `hover-link` payload in a small local `preview(event: MouseEvent)` function (same fields as now: `event`, `source`, `hoverParent`, `targetEl: row`, `linktext`, `sourcePath`, `state.scroll`).
- `row.onmouseenter = (evt)`: `cancelHover()`. If `Keymap.isModEvent(evt)` or the delay is 0, call `preview(evt)` straight away. Otherwise start `window.setTimeout(() => { this.hoverTimer = null; preview(lastEvent); }, delay)`.
  - `mouseenter` doesn't bubble, so crossing child elements no longer re-triggers the preview.
- Keep the latest pointer event for the timer callback. Extend the existing `row.onmousemove` handler with `lastEvent = evt` so the popover is placed where the pointer is now, not where it entered. If Ctrl/Cmd is pressed while waiting (`Keymap.isModEvent(evt)` on mousemove), cancel the timer and preview straight away.
- `row.onmouseleave`, `row.onmousedown` and the existing `row.ondragstart`: call `cancelHover()`. Clicking or dragging a row should never open a preview afterwards.
- Also call `cancelHover()` at the top of `set()` and `message()`, since the rows are replaced and their `mouseleave` may never fire. In the constructor, add `host.component.register(() => this.cancelHover())` so closing the panel can't leave a timer behind.
- Leave `HOVER_SOURCE` and the `registerHoverLinkSource` call in `src/main.ts` unchanged. Users who want Ctrl-only previews can still set that under *Settings → Page preview → QMD Search*.

### 5. Docs
- `README.md`: change the Mouse line to "hover (about 2 s, or at once with Ctrl) shows a page preview". Add a settings table row: `| Hover preview delay | 2000 ms | Sidebar panels; Ctrl-hover previews at once. |`.
- `AGENTS.md` §3, *Obsidian internals used*: add to the `hover-link` bullet that the plugin delays it itself (`mouseenter` + timer, `hoverDelayMs`), because Obsidian's own delay is too short for a dense list.

## Files touched
`src/types.ts`, `src/settings.ts`, `src/ui/result-list.ts`, `src/ui/search-pane.ts`, `src/ui/related-view.ts`, `README.md`, `AGENTS.md`, new `PLAN.md`.

## Verification
1. `npm run build`, `npm run lint` and `npm test`. These must pass; the existing vitest suite covers the query and snippet helpers and should be unchanged.
2. `npm run deploy`, then `obsidian plugin:reload id=qmd-search`. Check `obsidian dev:errors` for errors.
3. Confirm the setting is loaded: `obsidian eval code="app.plugins.plugins['qmd-search'].settings.hoverDelayMs"` should return `2000`.
4. Manual test in the search panel and the related-notes panel:
   - Sweep the pointer across several rows: no popover opens.
   - Rest on one row: the popover opens after about 2 s, scrolled to the match.
   - Leave the row before 2 s: nothing opens. Click a row while waiting: the note opens and no popover appears.
   - Hold Ctrl while entering a row, or press Ctrl while resting: the popover opens at once.
   - Set the slider to 0: the old behaviour comes back. Set it to 5000: the wait gets longer without a reload.
   - The quick-search modal behaves as before (no hover preview).
   - Close the panel while a timer is pending: no popover appears and `obsidian dev:errors` shows nothing.
5. Take a screenshot of a delayed popover with `obsidian dev:screenshot path=~/qmd-hover.png`.
