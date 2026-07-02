// ─── Unit tests — config resolution (pure) ──────────────────────────────
//
// Exercises `parseConfigFile` + `resolveConfig` with synthetic file
// contents and env records. No file I/O, no `process.env` — both
// inputs are passed in, so the precedence (env over file, file over
// defaults) is tested deterministically.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	resolveConfig,
	parseConfigFile,
	ENV,
	DEFAULT_PROTECT_DISPATCH,
	type EnvRecord,
} from "../config.ts";

describe("parseConfigFile", () => {
	it("extracts well-typed fields", () => {
		const f = parseConfigFile({
			personalityPath: "/a/personality.md",
			trackerPath: "/b/tracker.py",
			protectDispatch: "auto",
		});
		assert.equal(f.personalityPath, "/a/personality.md");
		assert.equal(f.trackerPath, "/b/tracker.py");
		assert.equal(f.protectDispatch, "auto");
	});

	it("accepts boolean protectDispatch", () => {
		assert.equal(parseConfigFile({ protectDispatch: true }).protectDispatch, true);
		assert.equal(parseConfigFile({ protectDispatch: false }).protectDispatch, false);
	});

	it("ignores unknown keys", () => {
		const f = parseConfigFile({ unknown: "x", personalityPath: "/p" });
		assert.equal(f.personalityPath, "/p");
		assert.equal((f as Record<string, unknown>).unknown, undefined);
	});

	it("rejects badly-typed values", () => {
		const f = parseConfigFile({ personalityPath: 42, trackerPath: "", protectDispatch: "maybe" });
		assert.equal(f.personalityPath, undefined);
		assert.equal(f.trackerPath, undefined);
		assert.equal(f.protectDispatch, undefined);
	});

	it("returns empty for non-object input", () => {
		assert.deepEqual(parseConfigFile(null), {});
		assert.deepEqual(parseConfigFile("string"), {});
		assert.deepEqual(parseConfigFile(undefined), {});
	});
});

describe("resolveConfig — precedence", () => {
	it("defaults when nothing is configured", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.personalityPath, undefined);
		assert.equal(cfg.trackerPath, undefined);
		assert.equal(cfg.protectDispatch, DEFAULT_PROTECT_DISPATCH);
		assert.equal(cfg.protectDispatch, "auto");
	});

	it("uses file values when env is absent", () => {
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p", trackerPath: "/file/t", protectDispatch: false },
		});
		assert.equal(cfg.personalityPath, "/file/p");
		assert.equal(cfg.trackerPath, "/file/t");
		assert.equal(cfg.protectDispatch, false);
	});

	it("env overrides file", () => {
		const env: EnvRecord = {
			[ENV.personalityPath]: "/env/p",
			[ENV.trackerPath]: "/env/t",
			[ENV.protectDispatch]: "1",
		};
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p", trackerPath: "/file/t", protectDispatch: false },
			env,
		});
		assert.equal(cfg.personalityPath, "/env/p");
		assert.equal(cfg.trackerPath, "/env/t");
		assert.equal(cfg.protectDispatch, true);
	});

	it("env protectDispatch=0 forces OFF over file true", () => {
		const cfg = resolveConfig({
			file: { protectDispatch: true },
			env: { [ENV.protectDispatch]: "0" } as EnvRecord,
		});
		assert.equal(cfg.protectDispatch, false);
	});

	it("env protectDispatch unset falls back to file value", () => {
		const cfg = resolveConfig({
			file: { protectDispatch: true },
			env: {},
		});
		assert.equal(cfg.protectDispatch, true);
	});

	it("file protectDispatch 'auto' is honored", () => {
		const cfg = resolveConfig({ file: { protectDispatch: "auto" } });
		assert.equal(cfg.protectDispatch, "auto");
	});

	it("empty-string env is treated as unset (falls back to file)", () => {
		const env: EnvRecord = { [ENV.personalityPath]: "" };
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p" },
			env,
		});
		assert.equal(cfg.personalityPath, "/file/p");
	});

	it("bogus env protectDispatch value is ignored (falls back to file/default)", () => {
		const cfg = resolveConfig({
			file: { protectDispatch: false },
			env: { [ENV.protectDispatch]: "maybe" } as EnvRecord,
		});
		assert.equal(cfg.protectDispatch, false);
	});
});

describe("preservedPaths", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed array of non-empty strings is extracted", () => {
		const f = parseConfigFile({ preservedPaths: ["AGENTS.md", "CLAUDE.md"] });
		assert.deepEqual(f.preservedPaths, ["AGENTS.md", "CLAUDE.md"]);
	});

	it("file parse: array with a non-string element is rejected (field undefined)", () => {
		const f = parseConfigFile({ preservedPaths: ["AGENTS.md", 42] });
		assert.equal(f.preservedPaths, undefined);
	});

	it("file parse: array with an empty string element is rejected (field undefined)", () => {
		const f = parseConfigFile({ preservedPaths: ["AGENTS.md", ""] });
		assert.equal(f.preservedPaths, undefined);
	});

	it("file parse: non-array value is rejected (field undefined)", () => {
		assert.equal(parseConfigFile({ preservedPaths: "AGENTS.md" }).preservedPaths, undefined);
		assert.equal(parseConfigFile({ preservedPaths: { a: 1 } }).preservedPaths, undefined);
		assert.equal(parseConfigFile({ preservedPaths: 42 }).preservedPaths, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		const f = parseConfigFile({ personalityPath: "/p" });
		assert.equal(f.preservedPaths, undefined);
	});

	it("file parse: empty array is accepted (no patterns)", () => {
		const f = parseConfigFile({ preservedPaths: [] });
		assert.deepEqual(f.preservedPaths, []);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file (env present and non-empty)", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["file-only"] },
			env: { [ENV.preservedPaths]: "AGENTS.md,~/CLAUDE.md" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md", "~/CLAUDE.md"]);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["AGENTS.md"] },
			env: { [ENV.preservedPaths]: "" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md"]);
	});

	it("resolveConfig: file-only (no env) returns the file list", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["AGENTS.md", "CLAUDE.md"] },
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md", "CLAUDE.md"]);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.preservedPaths, undefined);
	});

	// --- env parse grammar ---

	it("env parse: comma-separated, trimmed, empties filtered", () => {
		const cfg = resolveConfig({
			env: { [ENV.preservedPaths]: "AGENTS.md, CLAUDE.md ,,~/secrets.md" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md", "CLAUDE.md", "~/secrets.md"]);
	});

	it("env parse: single value (no commas) is a list of one", () => {
		const cfg = resolveConfig({
			env: { [ENV.preservedPaths]: "AGENTS.md" } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md"]);
	});

	it("env parse: whitespace-only commas are dropped", () => {
		const cfg = resolveConfig({
			env: { [ENV.preservedPaths]: "  ,  ,AGENTS.md,  " } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["AGENTS.md"]);
	});

	it("env parse: all-whitespace / all-commas env is treated as unset", () => {
		const cfg = resolveConfig({
			file: { preservedPaths: ["file-only"] },
			env: { [ENV.preservedPaths]: " , , " } as EnvRecord,
		});
		assert.deepEqual(cfg.preservedPaths, ["file-only"]);
	});

	// --- ENV map ---

	it("ENV.preservedPaths is the documented namespace", () => {
		assert.equal(ENV.preservedPaths, "PI_CONTEXT_TRIMMER_PRESERVED_PATHS");
	});
});