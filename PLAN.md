# Exclude folders from the qmd index

## Context

The plugin indexes everything the collection's glob matches. The only way to leave a folder out today is to hand-edit `.qmd/index.yml`. This adds an **Excluded folders** list in settings and a folder right-click item.

Decisions from the user:
- Excluding a folder soft-removes its notes (`qmd update` only).
- The plugin then shows a short warning that the text stays in the index.
- A manual **Purge** button removes it.

What testing and reading the code established (qmd 2.8.3):

| Fact | Consequence |
|---|---|
| `collections.<name>.ignore` is the only mechanism. It is YAML-only, with no CLI command. | The plugin has to edit `index.yml`. |
| A terminal `qmd update` reads only the YAML. | `index.yml` is the **single source of truth**. Nothing goes in `data.json`, or running qmd by hand would undo the exclusion. |
| `ignore` is not in the `qmd trust` gated set (hooks, paths, models). | Editing it doesn't re-arm trust. |
| `qmd update` deactivates any document the glob no longer returns and counts it as `removed`. | The existing `removed > 0` path already restarts the server. |
| Deactivated notes leave keyword and vector results, but their text and vectors stay until `qmd cleanup`. ANN takes `limit * 3` candidates *before* filtering on `active = 1`. | Unpurged vectors thin out vector results. This is what the warning is about. |
| `cleanup` also clears the LLM cache and runs VACUUM. | Purge stops the server first and restarts it after. |
| `Archive (old)/**` silently matches nothing. The escaped form matched for 11 tricky names under fast-glob's micromatch and 13 under picomatch (`getIgnoredLookupMatch`). | Folder names must be escaped the way `fg.escapePath` does. |
| The Math vault already has `Z - Template/**`, `99 - Assets/**`, `.obsidian/**`, `*.aux`, `*.dvi`, `*.log`, and the file is git-tracked. | Edit only the `ignore:` block. Never rewrite the whole file. Keep non-folder rules untouched. |

Obsidian API: the design uses only APIs available in 1.13.0, so `minAppVersion` stays. `type: 'list'` is unchanged in 1.14.4 (the only new control is `secret`). Avoid group `search` (1.13.1). `tab.update()` re-renders the open page (checked on the live 1.14.5 app). `refreshDomState()` does not change structure.

## Step 0: Branch

Plan mode blocked this, so it runs first once the plan is approved:

- `git switch -c feat/exclude-folders` from clean `main`.
- Replace `PLAN.md` with this plan, as the earlier feature branch did. Leave it uncommitted until asked.

## Step 1: Spike on a scratch project (no code)

In a throwaway `qmd init` project, confirm with qmd itself:

1. Add an `ignore` entry, then `qmd update`: it prints `N removed`.
2. Remove the entry, then `qmd update`: the notes return as `new` with no re-embedding.
3. Exclude, `qmd cleanup`, re-include: `(N unique hashes need vectors)` appears, so the existing embed step picks them up.
4. A folder named `Archive (old)` is excluded by its escaped pattern.
5. `qmd status` prints `Orphaned: N` in the form the parser will expect.

If any of these differs, stop and revise the plan. Record confirmed facts in `AGENTS.md` §3.

## Step 2: `src/qmd/config.ts` (new)

Pure helpers, tested in vitest:
- `folderPattern(rel)`: escapes with `/[\\()*?[\]{}|]|^!|[!+@](?=\()/g` (matched `fg.escapePath` for all 11 test names) and appends `/**`.
- `patternFolder(pattern)`: the reverse. Returns `null` unless the pattern is exactly a literal path plus `/**` with no dot-leading segment, so `*.aux`, `.obsidian/**` and `**/drafts/**` count as "other rules".
- `parseCollections(text, projectDir)`: uses Obsidian's `parseYaml`. Moves the `~` and relative-path resolution out of `QmdSearch.collectionRoots()` (`src/qmd/search.ts:231`) so there is one parser.
- `withIgnore(text, collection, patterns)`: replaces only that collection's `ignore:` block.
  - Handles block and flow styles, and removes the key when the list is empty.
  - Inserts after `pattern:` or `path:` when the key is absent.
  - Items are written with `JSON.stringify`, which keeps the file's double-quoted style.
  - Comments inside the block are lost. Everything else stays byte-identical.

`class QmdConfig`:
- Holds the parsed state in memory, because `getSettingDefinitions()` must do no I/O.
- Exposes `reload(): boolean`, `folders` (vault-relative), `otherPatterns`, `rootOf(name)`, `isExcluded(path)`, `canExclude(path)`, `exclude`, `include` and `rename`.
- Folder mapping: vault path → absolute → relative to each collection root. Collections that don't contain the folder are skipped. A folder equal to or above a root can't be excluded.
- `canExclude` is false when an ancestor is already excluded.

Every write:
1. Re-reads the file.
2. Applies `withIgnore`.
3. **Round-trip check**: parses before and after, requires `ignore` to equal the expected list, and requires everything else to be deep-equal. On a mismatch it throws and writes nothing.
4. Writes atomically (temp file in `.qmd/`, then rename through `realpath`).

Uses Node `fs`, like `runner.configPath()`, because `.qmd` is hidden from the Vault API and may be outside the vault.

## Step 3: Wiring `src/qmd/search.ts`

Inject `QmdConfig`. Delete `collectionRoots()`, the `roots` field and the unused `fs`/`os` imports. `toResult` uses `config.rootOf()`. `invalidate()` calls `config.reload()`, so hand edits are still picked up after each index run.

## Step 4: `src/qmd/indexer.ts`

- `takeRemoved()`: a running total of removed notes, read for the warning. It is a total because a running job can pick up a config change before the job that follows it. `changeExclusions` clears it first when the indexer is idle.
- `rerun()`: `run()` joins a running job, and that job may already have read the old config. So: `if (this.job) await this.job; if (this.aborted) return; return this.run();`
- `purge()`: waits for any running job, then runs through the same `job` slot so an update can't overlap it. The sequence is state `'purging'` → `server.stop()` → `stream(['cleanup'])` → `search.invalidate()`. In `finally`, restart the server if it was running and not aborted, so a failed cleanup never leaves it off.
- Add `'purging'` to `IndexState`. Share one error path with `execute()`.

`src/qmd/runner.ts`: add `orphaned` to `QmdStatus`, parsed from `Orphaned:\s+(\d+)`.

## Step 5: `src/main.ts`

- Create `config` before the tab and call `config.reload()`. Keep a `settingTab` reference. Call `config.reload()` in `applyConfig()`.
- `excludeFolder` / `includeFolder`: run the edit in try/catch (Notice on failure), call `settingTab.update()`, and trigger a 2 s debounced reindex so several edits make one `qmd update`. Cancel the debounce in `onunload`.
- Reindex: `await indexer.rerun()`, then `takeRemoved()`. On failure, show a Notice. If the count is above 0, show:
  `3 notes removed from search. Their text stays in the index until you purge it in settings.`
- `workspace.on('file-menu')`, per the Context menus docs: for a non-root `TFolder` where `canExclude` or exact exclusion holds, add **Exclude from qmd index** or **Include in qmd index**.
- `vault.on('rename')` for folders: `config.rename(old, new)`, which also rewrites entries under `old/`, so it's safe if Obsidian fires for children too. Otherwise renaming an excluded folder would quietly re-index it. No reindex is needed.
- Debounced `settingTab.update()` on folder create, delete and rename: the tab keeps its rows until `update()`, and a rename event arrives before the children move.
- `refreshStatus`: treat `purging` as busy, with the text `Purging removed notes…`.

## Step 6: UI

`src/ui/folder-picker.ts` (new): `FuzzySuggestModal<TFolder>` with `getItems`, `getItemText` and `onChooseItem`. `FolderSuggest` needs an input element, so it doesn't fit here.

`src/settings.ts`:
- New `type: 'list'` definition after *Index*:
  - `heading: 'Excluded folders'`, `emptyState: 'All folders are indexed.'`
  - `addItem: { name: 'Exclude a folder', action }` opens the picker over `getAllFolders()` filtered by `canExclude`.
  - `onDelete: (index) => includeFolder(config.folders[index])`
  - `items`: one row per folder with `searchable: false`, and `desc: 'Not in the vault.'` when `getFolderByPath` finds nothing.
- *Index* group: an **Other ignore rules** row listing `otherPatterns`, visible when there are any, so the list isn't mistaken for everything that's ignored.
- *Refresh* group: a **Purge removed notes** row with a warning-styled button. Desc: `Deletes the text and vectors of notes no longer indexed. The server restarts. Including them again means embedding them again.`
- `renderIndexStatus`: add `, N orphaned chunks` to the status line. After `verify()`, if `config.reload()` reports a change, call `this.update()`. This is the tab-open refresh for hand edits, and it can't loop because the second pass finds no change.

## Step 7: Tests and docs

- `test/config.test.ts`:
  - `folderPattern` / `patternFolder` round-trips for the tricky names.
  - `withIgnore` on a copy of the Math `index.yml` (the diff is only the block), no `ignore` key, flow style, last collection in the file, quoted names, a second collection untouched, removing the last entry.
  - Round-trip check rejects a corrupted edit.
- `test/obsidian-stub.ts`: `export { parse as parseYaml } from "yaml"`. Add `yaml` as a devDependency (it's already in `node_modules` transitively). No runtime dependency is added.
- `README.md`: settings rows, a short *Good to know* note on soft removal and purge, and a **Disclosures** line saying the plugin edits `.qmd/index.yml`.
- `AGENTS.md`: §2 layout. §3 facts: `ignore` semantics, escaping, soft removal and the ANN effect, purge needs the server off, `index.yml` is the source of truth.

## Files

New: `src/qmd/config.ts`, `src/ui/folder-picker.ts`, `test/config.test.ts`.
Changed: `src/main.ts`, `src/settings.ts`, `src/qmd/search.ts`, `src/qmd/indexer.ts`, `src/qmd/runner.ts`, `test/obsidian-stub.ts`, `package.json`, `package-lock.json`, `README.md`, `AGENTS.md`, `PLAN.md`.

## Verification

Use a **throwaway vault** at `~/qmd-exclude-test`, not `/tmp` (the Flatpak sandbox has its own). Seed it with a few dozen notes, including a folder named `Archive (old)`. Delete it afterwards. The Math vault is not touched, because its `index.yml` and `index.sqlite` are git-tracked. Opening the new vault in Obsidian may need one manual step from the user.

1. `npm run build`, `npm run lint` (0 errors, 0 warnings), `npm test`.
2. `QMD_PLUGIN_DIR=… npm run deploy`, `obsidian plugin:reload id=qmd-vault-search`, `obsidian dev:errors`.
3. Exclude a folder from settings:
   - The `git diff` of `index.yml` shows only the `ignore:` block.
   - The notice gives the right count.
   - Keyword search and the related panel no longer return the folder.
4. Exclude `Archive (old)` by right-click. Confirm the item flips to **Include in qmd index**, and that it works with the settings tab closed (`update()` doesn't throw).
5. Delete the row: notes come back with no embed job.
6. Exclude again, press Purge:
   - The status bar shows purging.
   - The `Orphaned` count reaches 0 and `qmd status` still reports the project index.
   - Search works afterwards.
   - Re-including runs `qmd embed`.
7. Exclude a folder while `qmd update` is running: the second run picks up the change.
8. Rename an excluded folder, and also its parent: `index.yml` follows and the notes stay out. Delete an excluded folder: the row shows *Not in the vault*.
9. Hand-edit `index.yml` and reopen settings: the list updates.
10. Add `# comment` lines around `ignore:` and exclude a folder: comments outside the block survive. Make the YAML unusual enough to fail the round-trip check: a Notice appears and the file is unchanged.
11. `qmd trust list` is unchanged, and `qmd update` from a terminal keeps the exclusion.
12. Per AGENTS §4: exactly one `qmd.js mcp --http` process after a reload, a restart, a purge and a disable.

## Out of scope

- Following Obsidian's own *Excluded files* (undocumented API; the user declined it).
- Automatic purge.
- Filtering excluded folders out of the search folder suggester.
- Bumping typings or the version.

## Sources

- [Settings](https://docs.obsidian.md/Plugins/User+interface/Settings)
- [Migrate to declarative settings](https://docs.obsidian.md/plugins/guides/migrate-declarative-settings)
- [Context menus](https://docs.obsidian.md/Plugins/User+interface/Context+menus)
- [Modals](https://docs.obsidian.md/Plugins/User+interface/Modals)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [`obsidian@1.14.4` typings](https://unpkg.com/obsidian@1.14.4/obsidian.d.ts)
- [Forum: where Excluded files is stored](https://forum.obsidian.md/t/where-are-the-path-listed-in-excluded-files-stored/109066)
- qmd 2.8.3 README, `dist/store.js`, `dist/trust.js`
