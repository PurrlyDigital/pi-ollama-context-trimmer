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

describe("tier1MaxTokens", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed positive number is extracted", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 75000 }).tier1MaxTokens, 75000);
	});

	it("file parse: non-numeric value (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: "75000" }).tier1MaxTokens, undefined);
	});

	it("file parse: zero is treated as absent (not a valid token budget)", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 0 }).tier1MaxTokens, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: -100 }).tier1MaxTokens, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: Number.NaN }).tier1MaxTokens, undefined);
	});

	it("file parse: Infinity is treated as absent", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: Number.POSITIVE_INFINITY }).tier1MaxTokens, undefined);
		assert.equal(parseConfigFile({ tier1MaxTokens: Number.NEGATIVE_INFINITY }).tier1MaxTokens, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).tier1MaxTokens, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { tier1MaxTokens: 50_000 },
			env: { [ENV.tier1MaxTokens]: "75000" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 75000);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier1MaxTokens: 50_000 },
			env: { [ENV.tier1MaxTokens]: "" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 50_000);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier1MaxTokens: 50_000 },
			env: { [ENV.tier1MaxTokens]: "not-a-number" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 50_000);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { tier1MaxTokens: 75_000 } });
		assert.equal(cfg.tier1MaxTokens, 75_000);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.tier1MaxTokens, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.tier1MaxTokens]: "125000" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 125000);
		assert.equal(typeof cfg.tier1MaxTokens, "number");
	});

	// --- ENV map ---

	it("ENV.tier1MaxTokens is the documented namespace", () => {
		assert.equal(ENV.tier1MaxTokens, "PI_CONTEXT_TRIMMER_TIER1_MAX_TOKENS");
	});
});

describe("tier2MaxTokens", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed positive number is extracted", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: 150000 }).tier2MaxTokens, 150000);
	});

	it("file parse: non-numeric value (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: "150000" }).tier2MaxTokens, undefined);
	});

	it("file parse: zero is treated as absent (not a valid token budget)", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: 0 }).tier2MaxTokens, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: -200 }).tier2MaxTokens, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: Number.NaN }).tier2MaxTokens, undefined);
	});

	it("file parse: Infinity is treated as absent", () => {
		assert.equal(parseConfigFile({ tier2MaxTokens: Number.POSITIVE_INFINITY }).tier2MaxTokens, undefined);
		assert.equal(parseConfigFile({ tier2MaxTokens: Number.NEGATIVE_INFINITY }).tier2MaxTokens, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).tier2MaxTokens, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 100_000 },
			env: { [ENV.tier2MaxTokens]: "150000" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 150000);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 100_000 },
			env: { [ENV.tier2MaxTokens]: "" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 100_000);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 100_000 },
			env: { [ENV.tier2MaxTokens]: "abc" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 100_000);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { tier2MaxTokens: 150_000 } });
		assert.equal(cfg.tier2MaxTokens, 150_000);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.tier2MaxTokens, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.tier2MaxTokens]: "200000" } as EnvRecord,
		});
		assert.equal(cfg.tier2MaxTokens, 200000);
		assert.equal(typeof cfg.tier2MaxTokens, "number");
	});

	// --- ENV map ---

	it("ENV.tier2MaxTokens is the documented namespace", () => {
		assert.equal(ENV.tier2MaxTokens, "PI_CONTEXT_TRIMMER_TIER2_MAX_TOKENS");
	});
});

describe("summaWords", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: well-typed positive number is extracted", () => {
		assert.equal(parseConfigFile({ summaWords: 100 }).summaWords, 100);
	});

	it("file parse: non-numeric value (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: "100" }).summaWords, undefined);
	});

	it("file parse: zero is treated as absent (not a valid word cap)", () => {
		assert.equal(parseConfigFile({ summaWords: 0 }).summaWords, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: -50 }).summaWords, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: Number.NaN }).summaWords, undefined);
	});

	it("file parse: Infinity is treated as absent", () => {
		assert.equal(parseConfigFile({ summaWords: Number.POSITIVE_INFINITY }).summaWords, undefined);
		assert.equal(parseConfigFile({ summaWords: Number.NEGATIVE_INFINITY }).summaWords, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).summaWords, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { summaWords: 60 },
			env: { [ENV.summaWords]: "100" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 100);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { summaWords: 60 },
			env: { [ENV.summaWords]: "" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 60);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { summaWords: 60 },
			env: { [ENV.summaWords]: "lots" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 60);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { summaWords: 80 } });
		assert.equal(cfg.summaWords, 80);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.summaWords, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.summaWords]: "120" } as EnvRecord,
		});
		assert.equal(cfg.summaWords, 120);
		assert.equal(typeof cfg.summaWords, "number");
	});

	// --- ENV map ---

	it("ENV.summaWords is the documented namespace", () => {
		assert.equal(ENV.summaWords, "PI_CONTEXT_TRIMMER_SUMMA_WORDS");
	});
});

describe("tier-threshold fields — per-field independence", () => {
	it("file parse: one field malformed does not poison the others", () => {
		const f = parseConfigFile({
			tier1MaxTokens: 75_000,
			tier2MaxTokens: "not-a-number",
			summaWords: 80,
		});
		assert.equal(f.tier1MaxTokens, 75_000);
		assert.equal(f.tier2MaxTokens, undefined);
		assert.equal(f.summaWords, 80);
	});

	it("resolveConfig: env sets one field, file sets another, third is undefined", () => {
		const cfg = resolveConfig({
			file: { tier2MaxTokens: 200_000 },
			env: { [ENV.tier1MaxTokens]: "75000" } as EnvRecord,
		});
		assert.equal(cfg.tier1MaxTokens, 75000);
		assert.equal(cfg.tier2MaxTokens, 200_000);
		assert.equal(cfg.summaWords, undefined);
	});
});