import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	activeDownload,
	DEFAULT_MODELS,
	DownloadWatch,
	formatDownload,
	ModelSpec,
	ModelState,
	modelCacheDir,
	modelSpec,
	modelState,
	resolveModel,
} from "../src/qmd/models";

const QUERY_FILE = "qmd-query-expansion-1.7B-q4_k_m.gguf";
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
	it("reads the file name and known size of an hf: URI", () => {
		expect(query).toEqual({ role: "generate", label: "query model", file: QUERY_FILE, totalBytes: 1282438912 });
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
