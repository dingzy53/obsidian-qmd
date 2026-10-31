# QMD Vault Search

An [Obsidian](https://obsidian.md) desktop plugin that searches your vault with its own **[QMD](https://github.com/tobi/qmd)** index: fast keyword + semantic search, LLM-expanded deep search on demand, and a related-notes panel. No runtime dependencies.

## Requirements

- Obsidian 1.13.0 or newer, desktop only. Tested on Linux (Flatpak and native); macOS and Windows are untested.
- [qmd](https://github.com/tobi/qmd) installed, with an index created inside the vault (`qmd init` in the vault folder).

## Installation

**From a release**

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/dingzy53/obsidian-qmd/releases/latest).
2. Put them in `<vault>/.obsidian/plugins/qmd-vault-search/` (`.obsidian` is your vault's configuration folder).
3. Reload Obsidian and enable **QMD Vault Search** under *Settings → Community plugins*.

**Upgrading from the `qmd-search` or `obsidian-qmd` folder:** the plugin ID is now `qmd-vault-search`. Copy `data.json` from the old plugin folder into the new one to keep your settings, then delete the old folder.

**With BRAT:** add `dingzy53/obsidian-qmd`.

---

## How it works

- **The vault's own index.** The plugin runs `qmd` inside the vault folder, so qmd uses `<vault>/.qmd/index.sqlite` and `<vault>/.qmd/index.yml` (created with `qmd init`). If that index cannot be found the plugin says so and stops; it never falls back to the global index.
- **A warm server.** While Obsidian is open the plugin keeps one `qmd mcp --http` process running so the embedding model stays loaded. A fused keyword + vector search then takes roughly 0.3–0.7 s instead of 10+ s per search through the CLI. The server stops when the plugin is disabled or Obsidian closes.
- **Scheduled refresh.** About 20 seconds after launch, and once a day after a set hour, the plugin runs `qmd update` and, if anything changed, `qmd embed`. When nothing changed it does nothing else.

---

## Using it

| Surface | Open with | What it does |
|---|---|---|
| Quick search | command **QMD Vault Search: Search** (assign a hotkey) | Type to search; results update as you type. |
| Vault search panel | ribbon icon ✨ or **Open search panel** | The same search in the right sidebar; results stay while you work. |
| Related notes | **Open related notes** | Notes semantically close to the note you are on. Follows the active note. |
| Selection | **Search selected text** | Sends the selection to the search panel. |

Each result shows the note name, its folder, the matched section and an excerpt taken from the note itself (math rendered, never cut mid-formula).

**Keys in the search box**

| Key | Action |
|---|---|
| ↑ / ↓ | Move through results (↑ on an empty box recalls the last query) |
| Enter | Open the note at the match and flash it |
| Ctrl/Cmd+Enter | Open in a new tab |
| Ctrl/Cmd+Alt+Enter | Open to the right |
| Shift+Enter | Deep search: rerun with LLM query expansion (about 15–20 s on CPU) |
| Alt+Enter | Insert a link to the result at the cursor |

**Mouse:** click opens, Ctrl-click or middle-click opens a new tab, resting on a row in a sidebar panel shows a page preview (after about 2 s, or at once with Ctrl held), right-click gives a menu, and a row can be dragged into a note to make a link.

**Query syntax:** `"exact phrase"` and `-excluded` work for the keyword half of the search. **Folder filter:** type a folder in the field under the search box.

**Excluding folders:** right-click a folder and choose **Exclude from qmd index**, or use *Excluded folders* in settings. Its notes leave search after a short refresh. Their text stays in the index file until you press **Purge**.

The status bar item **QMD ●** shows the state (green ready, yellow starting or indexing, red problem). Click it to update the index, restart the server or open settings.

---

## Settings

| Setting | Default | Notes |
|---|---|---|
| Index location | vault root | Folder that contains `.qmd`. The row below it shows the index status. |
| Path to qmd | auto-detect | |
| Excluded folders | none | Saved as `ignore` rules in `.qmd/index.yml`, so `qmd` run from a terminal follows them too. |
| Refresh at startup | on | |
| Refresh daily | on, 04:00 | First chance after that hour while Obsidian is open. |
| Purge removed notes | button | Runs `qmd cleanup` with the server stopped. Notes you include again are embedded again. |
| Embed changed notes | on | Runs `qmd embed` after an update that changed something. |
| Keep a qmd server running | on | Off = keyword search only. Status, log and port show while it is on. |
| Port | 8421 | The next five are tried if it is taken. |
| Search results | 20 | Up to 40. |
| Related notes shown | 10 | |
| Hover preview delay | 2 s | Sidebar panels. Ctrl/Cmd-hover previews at once. |
| Rerank deep search | off | Minutes without a dedicated GPU. Shows *Rerank candidates* when on. |

All settings appear in Obsidian's settings search.

---

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # type-check and bundle to main.js
npm run lint     # the same eslint-plugin-obsidianmd rules the community-plugin review runs
npm test
QMD_PLUGIN_DIR=<vault>/.obsidian/plugins/qmd-vault-search npm run deploy   # build and copy into a vault
```

Then reload the plugin: `obsidian plugin:reload id=qmd-vault-search`. See [AGENTS.md](AGENTS.md) for design notes.

## Releasing

```bash
npm version patch   # bumps package.json, manifest.json and versions.json, commits and tags
git push --follow-tags
```

The tag triggers the Release workflow, which lints, tests, builds and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release.

---

## Disclosures

- **Network:** the plugin talks only to the `qmd` server it starts itself, over HTTP on `localhost`. The plugin sends nothing to the internet. qmd downloads its embedding and query models the first time they are needed; see the [qmd documentation](https://github.com/tobi/qmd).
- **Files outside the vault:** the plugin runs the external `qmd` program, which you install yourself. qmd keeps its models and cache in your home directory. If you set *Index location* to a folder outside the vault, the index is read from and written there.
- **Config file:** excluding or including a folder, or renaming an excluded one, edits the `ignore` list in `.qmd/index.yml`. Nothing else in that file is changed.
- No telemetry, ads, accounts or payments.

---

## Good to know

- `.qmd/index.sqlite` changes whenever the index is refreshed after notes changed. While the server runs, the newest writes sit in `index.sqlite-wal` and are folded into `index.sqlite` when the server stops or restarts.
- A fused search draws on the top 20 keyword and top 20 semantic hits. With a folder filter the plugin tops the list up with a wider keyword search.
- Reranking and query expansion are CPU-bound LLM work; only fast search is instant.
- Until you purge, the vectors of excluded notes still take up places among the nearest matches, so semantic results can be thinner. Including a folder again before a purge needs no re-embedding.

## License

[MIT](LICENSE)
