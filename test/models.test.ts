import * as fs from "fs";
import * as obsidian from "obsidian";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activeDownload,
	DEFAULT_MODELS,
	DownloadWatch,
	fetchRemoteEtag,
	formatDownload,
	formatPullButton,
	ModelSpec,
	ModelState,
	modelCacheDir,
	modelSpec,
	modelState,
	resolveModel,
	seedMissingEtags,
} from "../src/qmd/models";

const QUERY_FILE = "qmd-query-expansion-1.7B-q4_k_m.gguf";
const EMBED_FILE = "embeddinggemma-300M-Q8_0.gguf";
const embed = modelSpec("embed", DEFAULT_MODELS.embed) as ModelSpec;
const query = modelSpec("generate", DEFAULT_MODELS.generate) as ModelSpec;
const rerank = modelSpec("rerank", DEFAULT_MODELS.rerank) as ModelSpec;

describe("modelCacheDir", () => {
	it("uses XDG_CACHE_HOME when set", () => {
		expect(modelCacheDir({ XDG_CACHE_HOME: "/x/cache" }, "/home/u", false)).toBe("/x/cache/qmd/models");
	});
	it("falls back to ~/.cache", () => {
		expect(modelCacheDir({}, "/home/u", false)).toBe("/home/u/.cache/qmd/models");
	});
	it("ignores the Flatpak sandbox's XDG_CACHE_HOME, since qmd runs on the host", () => {
		const env = { XDG_CACHE_HOME: "/home/u/.var/app/md.obsidian.Obsidian/cache" };
		expect(modelCacheDir(env, "/home/u", true)).toBe("/home/u/.cache/qmd/models");
	});
});

describe("modelSpec and resolveModel", () => {
	it("reads the file name, Hugging Face URL and known size of an hf: URI", () => {
		expect(query).toEqual({
			role: "generate",
			label: "query model",
			file: QUERY_FILE,
			url: `https://huggingface.co/tobil/qmd-query-expansion-1.7B-gguf/resolve/main/${QUERY_FILE}`,
			totalBytes: 1282438912,
		});
	});
	it("preserves subdirectory paths in the Hugging Face URL", () => {
		expect(modelSpec("embed", "hf:user/repo/sub/dir/other.gguf")).toEqual({
			role: "embed",
			label: "embedding model",
			file: "other.gguf",
			url: "https://huggingface.co/user/repo/resolve/main/sub/dir/other.gguf",
			totalBytes: null,
		});
	});
	it("returns null for a local model file", () => {
		expect(modelSpec("generate", "/models/mine.gguf")).toBeNull();
	});
	it("has no total for an unknown model", () => {
		expect(modelSpec("embed", "hf:a/b/other.gguf")?.totalBytes).toBeNull();
	});
	it("prefers index.yml, then the environment, then the default", () => {
		const env = { QMD_GENERATE_MODEL: "hf:e/e/env.gguf" };
		expect(resolveModel("generate", { generate: "hf:c/c/conf.gguf" }, env)).toBe("hf:c/c/conf.gguf");
		expect(resolveModel("generate", {}, env)).toBe("hf:e/e/env.gguf");
		expect(resolveModel("generate", {}, {})).toBe(DEFAULT_MODELS.generate);
	});
});

describe("modelState", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "qmd-models-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("reports a missing cache folder as missing", () => {
		const state = modelState(path.join(dir, "nope"), query);
		expect(state).toMatchObject({ present: false, downloading: false, doneBytes: null });
	});
	it("finds the cached hf_<user>_<file> copy", () => {
		fs.writeFileSync(path.join(dir, `hf_tobil_${QUERY_FILE}`), "GGUF");
		expect(modelState(dir, query)).toMatchObject({ present: true, downloading: false });
	});
	it("does not count the .etag sidecar as the model", () => {
		fs.writeFileSync(path.join(dir, `${QUERY_FILE}.etag`), "x");
		expect(modelState(dir, query).present).toBe(false);
	});
	it("reads the progress of an .ipull partial file from its allocated blocks", () => {
		const partial = path.join(dir, `hf_tobil_${QUERY_FILE}.ipull`);
		// ipull sizes the file to the total and writes at offsets, so the file is sparse.
		const fd = fs.openSync(partial, "w");
		fs.ftruncateSync(fd, 1282438912);
		fs.writeSync(fd, Buffer.alloc(1 << 20, 1), 0, 1 << 20, 0);
		fs.closeSync(fd);
		const state = modelState(dir, query);
		expect(state.present).toBe(false);
		expect(state.downloading).toBe(true);
		if (fs.statSync(partial).blocks !== undefined) {
			expect(state.doneBytes).toBeGreaterThanOrEqual(1 << 20);
			expect(state.doneBytes).toBeLessThan(1282438912);
		}
	});
});

const state = (spec: ModelSpec, present: boolean, doneBytes: number | null, downloading = doneBytes !== null): ModelState => ({
	spec,
	present,
	downloading,
	doneBytes,
	changedAt: 0,
});

describe("formatDownload", () => {
	it("shows bytes against the known total", () => {
		expect(formatDownload(state(query, false, 420e6))).toBe("Downloading query model (0.4 / 1.3 GB)");
	});
	it("uses MB for a model under 1 GB", () => {
		expect(formatDownload(state(rerank, false, 120e6))).toBe("Downloading reranker (120 / 639 MB)");
	});
	it("shows the expected size before any progress", () => {
		expect(formatDownload(state(query, false, null))).toBe("Downloading query model (~1.3 GB, first run)");
	});
	it("shows bytes alone for a model of unknown size", () => {
		const other = { ...query, totalBytes: null };
		expect(formatDownload(state(other, false, 2.5e9))).toBe("Downloading query model (2.5 GB)");
	});
});

describe("activeDownload", () => {
	it("picks the model being downloaded over another missing one", () => {
		const active = activeDownload([state(query, false, null, false), state(rerank, false, 5e6)]);
		expect(active?.spec.role).toBe("rerank");
	});
	it("returns null when every model is cached", () => {
		expect(activeDownload([state(query, true, null)])).toBeNull();
	});
});

describe("DownloadWatch", () => {
	it("is active while a missing model keeps growing, and stops when it stalls or lands", () => {
		let now = 0;
		let states = [state(query, false, null, false)];
		const watch = new DownloadWatch(() => states, () => now);
		expect(watch.active()).toBe(true);

		now = 60_000;
		states = [state(query, false, 100e6)];
		expect(watch.active()).toBe(true);

		now = 60_000 + 119_000;
		expect(watch.active()).toBe(true);
		now = 60_000 + 121_000;
		expect(watch.active()).toBe(false); // stalled for over two minutes

		states = [state(query, false, 200e6)];
		expect(watch.active()).toBe(true);
		states = [state(query, true, null)];
		expect(watch.active()).toBe(false);
	});
});

describe("formatPullButton", () => {
	it("shows Downloading… while pulling", () => {
		expect(formatPullButton([state(query, false, null, false)], true)).toBe("Downloading…");
	});
	it("says Check for updates when all models are cached", () => {
		expect(formatPullButton([state(query, true, null), state(rerank, true, null), state(embed, true, null)], false)).toBe(
			"Check for updates"
		);
	});
	it("names the single missing model and its size", () => {
		expect(formatPullButton([state(query, true, null), state(rerank, false, null, false), state(embed, true, null)], false)).toBe(
			"Download reranker (639 MB)"
		);
		const unknown = { ...rerank, totalBytes: null };
		expect(formatPullButton([state(query, true, null), state(unknown, false, null, false)], false)).toBe("Download reranker");
	});
	it("shows the count and combined size when multiple models are missing", () => {
		expect(
			formatPullButton([state(query, false, null, false), state(rerank, false, null, false), state(embed, true, null)], false)
		).toBe("Download 2 models (1.9 GB)");
		expect(
			formatPullButton(
				[state(query, false, null, false), state(rerank, false, null, false), state(embed, false, null, false)],
				false
			)
		).toBe("Download all models (2.3 GB)");
		const unknown = { ...embed, totalBytes: null };
		expect(
			formatPullButton([state(query, false, null, false), state(unknown, false, null, false)], false)
		).toBe("Download all models");
	});
});

describe("fetchRemoteEtag", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends a HEAD request via requestUrl and reads ETag case-insensitively", async () => {
		const spy = vi.spyOn(obsidian, "requestUrl").mockResolvedValue({
			status: 200,
			headers: { ETag: '"abc123"' },
		} as unknown as obsidian.RequestUrlResponse);
		await expect(fetchRemoteEtag(query.url)).resolves.toBe('"abc123"');
		expect(spy).toHaveBeenCalledWith({ url: query.url, method: "HEAD", throw: false });
	});

	it("returns null on non-2xx responses, missing headers or errors", async () => {
		vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
			status: 404,
			headers: { etag: '"nope"' },
		} as unknown as obsidian.RequestUrlResponse);
		await expect(fetchRemoteEtag(query.url)).resolves.toBeNull();

		vi.spyOn(obsidian, "requestUrl").mockResolvedValueOnce({
			status: 200,
			headers: {},
		} as unknown as obsidian.RequestUrlResponse);
		await expect(fetchRemoteEtag(query.url)).resolves.toBeNull();

		vi.spyOn(obsidian, "requestUrl").mockRejectedValueOnce(new Error("offline"));
		await expect(fetchRemoteEtag(query.url)).resolves.toBeNull();
	});
});

describe("seedMissingEtags", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "qmd-etags-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("writes .etag only for present models without one and leaves existing sidecars alone", async () => {
		fs.writeFileSync(path.join(dir, `hf_tobil_${QUERY_FILE}`), "GGUF");
		fs.writeFileSync(path.join(dir, `hf_ggml-org_${EMBED_FILE}`), "GGUF");
		fs.writeFileSync(path.join(dir, `${EMBED_FILE}.etag`), '"already-there"\n');

		const requested: string[] = [];
		const seeded = await seedMissingEtags(dir, [query, rerank, embed], async (url) => {
			requested.push(url);
			return '"remote-etag"';
		});

		expect(requested).toEqual([query.url]);
		expect(seeded).toEqual([QUERY_FILE]);
		expect(fs.readFileSync(path.join(dir, `${QUERY_FILE}.etag`), "utf8")).toBe('"remote-etag"\n');
		expect(fs.readFileSync(path.join(dir, `${EMBED_FILE}.etag`), "utf8")).toBe('"already-there"\n');
		expect(fs.existsSync(path.join(dir, `${rerank.file}.etag`))).toBe(false);
	});

	it("skips writing when no ETag is returned or the cache folder does not exist", async () => {
		fs.writeFileSync(path.join(dir, `hf_tobil_${QUERY_FILE}`), "GGUF");
		await expect(seedMissingEtags(dir, [query], async () => null)).resolves.toEqual([]);
		expect(fs.existsSync(path.join(dir, `${QUERY_FILE}.etag`))).toBe(false);

		const missingDir = path.join(dir, "nope");
		const getEtag = vi.fn(async () => '"unused"');
		await expect(seedMissingEtags(missingDir, [query], getEtag)).resolves.toEqual([]);
		expect(getEtag).not.toHaveBeenCalled();
	});
});
