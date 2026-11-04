# QMD Vault Search (`qmd-vault-search`)

An Obsidian desktop plugin that searches the vault's own **QMD** index. Developed and tested on Linux with the Flatpak build of Obsidian. The plain (non-Flatpak) spawn path was checked on macOS 14 with 2.1.2.

---

## 1. Design principles

1. **The vault's own index, or nothing.** qmd picks its index from the working directory: the nearest `.qmd/` at or above it, else the global `~/.cache/qmd` index. Every qmd call therefore runs in the *project directory* (the folder containing `.qmd`, by default the vault root). `QmdRunner` refuses to run when `.qmd/index.yml` is missing and `verify()` checks that `qmd status` reports `<projectDir>/.qmd/index.sqlite`. A silent fallback to the global index was the original bug; do not reintroduce it.
2. **Warm server for speed.** One managed `qmd mcp --http` child keeps the models loaded. Fast search goes over its REST endpoint; the CLI is used for keyword fallback, deep search and index jobs.
3. **Zero runtime dependencies.** Obsidian API plus Node built-ins (`child_process`, `http`, `fs`, `os`, `path`).
4. **One result row everywhere.** The modal, the search panel and the related-notes panel all use `ResultList`. Rows show note name, folder, matched section and an excerpt. No score, docid or line badges, no per-row buttons.
5. **Scheduled refresh.** The index is refreshed at launch and daily (user's choice). When `qmd update` reports no changes, nothing else happens: no embed, no server restart. Changing the excluded folders refreshes at once.
6. **`index.yml` is the record of excluded folders.** A `qmd update` run outside Obsidian reads nothing else, so the list is never copied into `data.json`. The plugin edits only the `ignore:` block of a collection and leaves every other line alone, because the file may be tracked in git.

---

## 2. Layout

```
src/
  main.ts              lifecycle, commands, status bar, wiring
  types.ts             settings, QmdResult
  settings.ts          settings tab
  utils.ts             openAtMatch (+flash), link helpers
  qmd/runner.ts        binary resolution; exec/spawn/kill in the project dir (Flatpak-aware); status(); verify()
  qmd/config.ts        index.yml: collection roots, excluded folders, safe edits of the ignore block
  qmd/server.ts        managed `qmd mcp --http` child, health, restart, http client
  qmd/search.ts        fast / deep / related; query sanitizing; result -> vault file
  qmd/indexer.ts       update + embed job; purge; launch and daily schedule
  ui/result-list.ts    the shared rows: render, open, hover, menu, drag, keyboard selection
  ui/snippet.ts        excerpt built from the note file; render + cache
  ui/search-pane.ts    query box + folder filter + status + list (shared by modal and panel)
  ui/search-modal.ts   quick-search modal
  ui/search-view.ts    sidebar search panel
  ui/related-view.ts   related-notes panel
  ui/folder-suggest.ts folder autocomplete
  ui/folder-picker.ts  fuzzy folder modal for "Exclude a folder"
scripts/deploy.mjs     copy the build into the vault
```

---

## 3. Facts about qmd and Flatpak that the code depends on

These were established by testing against qmd 2.8.3 and Obsidian 1.13.7 (Flatpak). Re-verify after upgrades.

**Spawning**
- Flatpak form: `flatpak-spawn --host [--watch-bus] --directory=<dir> --env=PWD=<dir> <qmd> …`. `--directory` alone leaves a stale `PWD`, which qmd reads. The sandbox environment is not forwarded to the host; pass what is needed with `--env=`.
- `qmd` is a launcher script that starts the real program as a child process. Through `flatpak-spawn`, **SIGTERM reaches only the launcher and leaves the real process running**; SIGINT is forwarded to the whole host process group, and `--watch-bus` kills the group when the spawner dies. So `QmdRunner.kill()` sends SIGINT (outside Flatpak: SIGINT to the detached process group). Never stop qmd with SIGTERM.
- Outside Flatpak, an app started from the macOS Dock (or a desktop launcher) gets only the system `PATH`, not the one a shell profile builds for fnm/nvm. `resolveBinary()` therefore also checks the version managers' default folders, and `command()` puts the binary's own folder (and its symlink target's) first on the child's `PATH`, because an npm-installed `qmd` starts with `#!/usr/bin/env node` and the matching `node` sits next to it. Do not ask a login shell for `PATH`: the README promises that nothing runs through a shell.
- Never use `qmd mcp --daemon` (its pidfile is shared with the global index) and never `pkill -f`.

**Server**
- Talk to it with Node `http` on host `localhost`. Renderer `fetch` adds `Origin: app://obsidian.md` and gets 403.
- `POST /query` needs `searches: [{type, query}]` and **`rerank: false` sent explicitly** (rerank defaults to on and takes minutes on CPU).
- It fuses the top 20 keyword and top 20 vector hits, so it returns at most 40 results. Keyword lists are always ranked first and weighted double; the order of `searches` has no effect.
- The server logs every request; its pipes must be drained or it eventually blocks.
- The plugin never adopts a server it did not start. A busy port means "try the next one".
- After the launcher exits, the real server still needs a moment to close; `stop()` waits until the port is free.

**Results and queries**
- REST returns `file: "qmd://<collection>/<url-encoded path>"`; the CLI returns it unencoded. Do not use `--full-path` (it emits `./`-relative paths when cwd is the vault). Stored paths are verbatim relative to the collection root; a relative collection `path` resolves against the folder containing `.qmd`.
- `line` is the 1-based matched line; the snippet header `@@ -S,C @@` gives the snippet's first line `S`. Over REST each snippet line is also prefixed with `N: `.
- vec queries are rejected if they contain negation (`/(^|\s)-[\w"]/`); REST lex queries are rejected on an odd number of `"`. On the CLI, pass the query after `--` or a leading `-` is parsed as a flag.
- Query expansion costs about 12–20 s on CPU even with warm models, so deep search runs as a separate, abortable CLI process (`qmd query … --no-rerank`).

**Index**
- `qmd init` (2.8.3) creates `index.yml` with `collections: {}`. `qmd update` then indexes nothing and still exits 0, so `verify()` treats an index with no collections as a `problem`. Setup is `qmd init && qmd collection add .`.
- `qmd update` prints `Indexed: N new, M updated, U unchanged, R removed` and, when vectors are missing, `(N unique hashes need vectors)`. `QmdIndexer` parses both.
- SQLite runs in WAL mode with a 120 s busy timeout, so the server and an index job can overlap. The server is restarted after a job that changed something, which also checkpoints the WAL into `index.sqlite` (the vault tracks that file in git).

**Excluded folders**
- `collections.<name>.ignore` is YAML-only: no qmd command sets it, and `qmd update` must run before it has any effect. It is not in the `qmd trust` gated set, so editing it does not re-arm trust.
- Rules are fast-glob patterns relative to the collection root. They must be escaped: `Archive (old)/**` silently matches nothing, `Archive \(old\)/**` works. `folderPattern()` mirrors `fg.escapePath`. A rule that is not exactly one literal folder plus `/**` is shown as an "other rule" and never rewritten.
- A malformed `index.yml` makes every qmd command fail, so a write is refused unless parsing the result shows that only that `ignore` list changed.
- Excluding is a soft removal: the notes leave keyword and vector results and count as `removed`, but their text and vectors stay in `index.sqlite`. Vector search takes `limit * 3` nearest chunks before it filters on active documents, so leftover vectors thin out results until `qmd cleanup`. Including a folder before a purge needs no embedding; after a purge the notes are embedded again.
- `qmd cleanup` also clears the LLM cache and ends with VACUUM, so `purge()` stops the server first. It is manual by the user's choice.
- `qmd status` prints `Orphaned: N embedding chunks (P%) — …` only when N > 0.

**Directory and settings**
- ID `qmd-vault-search`, name "QMD Vault Search": `qmd-search` (achekulaev/obsidian-qmd) and the name "QMD Search" (id `qmd`) are taken in the community directory. View types are prefixed `qmd-vault-` for the same reason.
- `minAppVersion` 1.13.0: the settings tab is declarative (`getSettingDefinitions()`, no `display()`), so settings appear in Obsidian's settings search. `setControlValue` saves and restarts the server for the keys in `RECONFIGURE`; rows that depend on a toggle use `visible` and are refreshed with `refreshDomState()`. Excluded folders are a `type: 'list'` definition. `getSettingDefinitions()` must not read files, so it uses `QmdConfig`'s parsed state, reloaded by the index status check.
- The tab keeps its rows until `update()`: reopening it does not rebuild them. So `update()` follows `QmdConfig.onChange` and, debounced, folder create/delete/rename. A rename event arrives before the folder's children have moved, so rows built during it are wrong.
- In Obsidian 1.14 settings is a popout window with its own `document`. A modal opened from it (the folder picker) and a Notice appear in that window; `app.setting.activeTab.containerEl.ownerDocument` reaches it from `obsidian eval`. Checked on 1.14.5.
- UI strings must pass `obsidianmd/ui/sentence-case`, which lowercases unknown acronyms: write "qmd" mid-sentence and never start a UI string with "QMD".

**Obsidian internals used (feature-detected)**
- `editor.addHighlights(ranges, 'is-flashing', true, true)` / `removeHighlights` for the flash.
- `app.dragManager.dragFile` / `onDragStart` for dragging a row as a file.
- `workspace.trigger('hover-link', …)` with a registered hover source for page preview. `ResultList` delays the trigger itself (`mouseenter` + timer, `hoverDelayMs`, Ctrl/Cmd skips it): Obsidian's own wait is too short for a dense list, and `mouseover` would re-fire on every child element.

---

## 4. Workflow

- `npm run build` — type-check (`tsc --noEmit`) and bundle.
- `npm run lint`, `npm test` — eslint with `eslint-plugin-obsidianmd` recommended, the rule set the community-plugin review runs (keep it at 0 errors and 0 warnings; no `eslint-disable` comments, the review rejects them); vitest for the pure query/snippet helpers (`obsidian` is stubbed in `test/obsidian-stub.ts`).
- `npm run deploy` — build and copy into the vault (`QMD_PLUGIN_DIR` sets the target).
- Reload in the running app: `obsidian plugin:reload id=qmd-vault-search`. Inspect with `obsidian eval code="app.plugins.plugins['qmd-vault-search']…"`, `obsidian dev:errors`, `obsidian dev:screenshot path=<file under $HOME>` (the sandbox has its own `/tmp`).
- After any change to process handling, check that exactly one `qmd.js mcp --http` process exists after a reload, a restart and a disable.

## 5. Releasing and the community directory

Checked against the developer docs (obsidian-developer-docs, October 2026).
- Plugins are submitted at community.obsidian.md, not by a PR to `obsidian-releases`. The submission happens once; after that every GitHub release is scanned automatically. A plugin with scan **errors** cannot be installed. Warnings do not block it.
- The scan reads `manifest.json` at HEAD of `main`, then downloads the release whose tag equals its `version`. Both must agree. Tag `2.0.0` still carries the old `qmd-search` manifest, so that version can never be served again.
- Tags have no `v` prefix (`.npmrc` sets `tag-version-prefix=""`). `release.yml` triggers only on `x.y.z` and fails if the tag differs from the manifest version.
- **Build verification:** the scanner runs the first script it finds among `build`, `build:plugin` and `compile`, then compares the output with the release `main.js`. Only CI builds release assets.
- The scanner lints the source with `eslint-plugin-obsidianmd`. It skips `test`, `scripts`, `*.test.*`, `*.mjs`, `esbuild.config.mjs`, `version-bump.mjs`, and a few other fixed names (see the FAQ). `vitest.config.ts` is not on that list, so it is scanned and has to stay lint-clean.
- **Review branch**, on the plugin's directory page, previews a scan of any branch or commit without a release. Run it before tagging.
- Description rules: at most 250 characters, ends with a period, no emoji. The `id` cannot contain `obsidian` or end in `plugin`, and the name cannot contain "Obsidian" or "Plugin". Command IDs do not repeat the plugin ID. No `fundingUrl` unless donations are accepted.
- README disclosures are required for network use and for files outside the vault. Keep the README's Privacy and security section accurate whenever the binary lookup, the server or the index location changes.
- **Scan results, 2.1.1** (everything else passed):
  - *Behavior*: warnings for **Direct filesystem access** (`fs`) and **Shell execution** (`child_process`), and a recommendation for **Clipboard access**. These come from the modules being used at all, not from how they are used, and they do not block listing. They are expected and accepted, and the README's Privacy and security section answers each one.
    - `child_process` is the plugin's purpose.
    - `fs` is needed for an *Index location* outside the vault and for the binary lookup.
    - The clipboard is write-only (*Copy link*, and the insert-link fallback in `ui/result-list.ts`). Removing those two calls would clear the recommendation.
  - Do not add more of these modules without a matching disclosure.
- **CSS lint** warns on `!important` and on unknown type selectors such as `mjx-container`. MathJax display math sets no inline styles. Its rule is `mjx-container[display]`, so override it by specificity with the `.MathJax` class (`.qmd-row-snippet .MathJax[display='true']`).
