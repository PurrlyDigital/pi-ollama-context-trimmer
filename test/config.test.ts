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
	DEFAULT_LOOP_GUARD,
	DEFAULT_ASYNC_MODE,
	DEFAULT_INTERCOM_KEEP_LAST,
	type EnvRecord,
} from "../config.ts";

describe("parseConfigFile", () => {
	it("extracts well-typed fields", () => {
		const f = parseConfigFile({
			personalityPath: "/a/personality.md",
			protectDispatch: "auto",
		});
		assert.equal(f.personalityPath, "/a/personality.md");
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
		const f = parseConfigFile({ personalityPath: 42, protectDispatch: "maybe" });
		assert.equal(f.personalityPath, undefined);
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
		assert.equal(cfg.protectDispatch, DEFAULT_PROTECT_DISPATCH);
		assert.equal(cfg.protectDispatch, "auto");
	});

	it("uses file values when env is absent", () => {
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p", protectDispatch: false },
		});
		assert.equal(cfg.personalityPath, "/file/p");
		assert.equal(cfg.protectDispatch, false);
	});

	it("env overrides file", () => {
		const env: EnvRecord = {
			[ENV.personalityPath]: "/env/p",
			[ENV.protectDispatch]: "1",
		};
		const cfg = resolveConfig({
			file: { personalityPath: "/file/p", protectDispatch: false },
			env,
		});
		assert.equal(cfg.personalityPath, "/env/p");
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

describe("dropFloorPercent", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: a value in (0, 100] is extracted (50, 1, 100 all valid)", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: 50 }).dropFloorPercent, 50);
		assert.equal(parseConfigFile({ dropFloorPercent: 1 }).dropFloorPercent, 1);
		// 100 is the upper bound — accepted (drop effectively
		// disabled: 100% of the cap means the floor equals the
		// cap, which the drop never undershoots).
		assert.equal(parseConfigFile({ dropFloorPercent: 100 }).dropFloorPercent, 100);
	});

	it("file parse: 0 is treated as absent (open-lower bound excludes 0)", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: 0 }).dropFloorPercent, undefined);
	});

	it("file parse: 101 is treated as absent (open-upper bound excludes >100)", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: 101 }).dropFloorPercent, undefined);
	});

	it("file parse: negative is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: -50 }).dropFloorPercent, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: Number.NaN }).dropFloorPercent, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: Number.POSITIVE_INFINITY }).dropFloorPercent, undefined);
		assert.equal(parseConfigFile({ dropFloorPercent: Number.NEGATIVE_INFINITY }).dropFloorPercent, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ dropFloorPercent: "50" }).dropFloorPercent, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 50_000 }).dropFloorPercent, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "75" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 75);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 50);
	});

	it("resolveConfig: out-of-range env (0, 101, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.dropFloorPercent, 50);
		const cfg101 = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "101" } as EnvRecord,
		});
		assert.equal(cfg101.dropFloorPercent, 50);
		const cfgNeg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "-10" } as EnvRecord,
		});
		assert.equal(cfgNeg.dropFloorPercent, 50);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { dropFloorPercent: 50 },
			env: { [ENV.dropFloorPercent]: "half" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 50);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { dropFloorPercent: 75 } });
		assert.equal(cfg.dropFloorPercent, 75);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.dropFloorPercent, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string in (0, 100] is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.dropFloorPercent]: "60" } as EnvRecord,
		});
		assert.equal(cfg.dropFloorPercent, 60);
		assert.equal(typeof cfg.dropFloorPercent, "number");
	});

	// --- ENV map ---

	it("ENV.dropFloorPercent is the documented namespace", () => {
		assert.equal(ENV.dropFloorPercent, "PI_CONTEXT_TRIMMER_DROP_FLOOR_PERCENT");
	});
});

describe("recencyFloor", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: a positive number is extracted", () => {
		assert.equal(parseConfigFile({ recencyFloor: 5000 }).recencyFloor, 5000);
		assert.equal(parseConfigFile({ recencyFloor: 1 }).recencyFloor, 1);
	});

	it("file parse: 0 is treated as absent (matches isPositiveNumber's open-lower bound)", () => {
		assert.equal(parseConfigFile({ recencyFloor: 0 }).recencyFloor, undefined);
	});

	it("file parse: negative is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: -100 }).recencyFloor, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: Number.NaN }).recencyFloor, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: Number.POSITIVE_INFINITY }).recencyFloor, undefined);
		assert.equal(parseConfigFile({ recencyFloor: Number.NEGATIVE_INFINITY }).recencyFloor, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ recencyFloor: "5000" }).recencyFloor, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ tier1MaxTokens: 50_000 }).recencyFloor, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "10000" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 10000);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 5000);
	});

	it("resolveConfig: non-positive env (0, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.recencyFloor, 5000);
		const cfgNeg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "-1" } as EnvRecord,
		});
		assert.equal(cfgNeg.recencyFloor, 5000);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { recencyFloor: 5000 },
			env: { [ENV.recencyFloor]: "lots" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 5000);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { recencyFloor: 7500 } });
		assert.equal(cfg.recencyFloor, 7500);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.recencyFloor, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.recencyFloor]: "20000" } as EnvRecord,
		});
		assert.equal(cfg.recencyFloor, 20000);
		assert.equal(typeof cfg.recencyFloor, "number");
	});

	// --- ENV map ---

	it("ENV.recencyFloor is the documented namespace", () => {
		assert.equal(ENV.recencyFloor, "PI_CONTEXT_TRIMMER_RECENCY_FLOOR");
	});
});

// ─── loopGuard (defense-in-depth for model-caused loops) ───────────────
//
// The loop-guard enable mode is opt-out: `loopGuard` in the config
// file or `PI_CONTEXT_TRIMMER_LOOP_GUARD` in env. `true` (default)
// turns the guard ON for every session; `false` turns it off. The
// guard is universal across session postures — the previous `"auto"`
// posture coupled the guard to a subagent-tool probe, but
// behavioral-loop detection is the same concern whether the model is
// in a parent or a subagent session, so the coupling was dropped.
// `parseConfigFile` accepts only the boolean shape; any other value
// (string, number, the previous `"auto"` sentinel) is treated as
// absent and the resolver falls through to the default `true`.

describe("loopGuard", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: boolean true is extracted", () => {
		assert.equal(parseConfigFile({ loopGuard: true }).loopGuard, true);
	});

	it("file parse: boolean false is extracted", () => {
		assert.equal(parseConfigFile({ loopGuard: false }).loopGuard, false);
	});

	it("file parse: the previous 'auto' string is treated as absent (sentinel was dropped)", () => {
		assert.equal(parseConfigFile({ loopGuard: "auto" }).loopGuard, undefined);
	});

	it("file parse: arbitrary string is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuard: "on" }).loopGuard, undefined);
		assert.equal(parseConfigFile({ loopGuard: "yes" }).loopGuard, undefined);
		assert.equal(parseConfigFile({ loopGuard: "" }).loopGuard, undefined);
	});

	it("file parse: number is treated as absent (boolean only)", () => {
		assert.equal(parseConfigFile({ loopGuard: 1 }).loopGuard, undefined);
		assert.equal(parseConfigFile({ loopGuard: 0 }).loopGuard, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).loopGuard, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env '1' forces loopGuard true over file false", () => {
		const cfg = resolveConfig({
			file: { loopGuard: false },
			env: { [ENV.loopGuard]: "1" } as EnvRecord,
		});
		assert.equal(cfg.loopGuard, true);
	});

	it("resolveConfig: env '0' forces loopGuard false over file true", () => {
		const cfg = resolveConfig({
			file: { loopGuard: true },
			env: { [ENV.loopGuard]: "0" } as EnvRecord,
		});
		assert.equal(cfg.loopGuard, false);
	});

	it("resolveConfig: env unset falls back to file value (boolean)", () => {
		const cfgTrue = resolveConfig({
			file: { loopGuard: true },
			env: {} as EnvRecord,
		});
		assert.equal(cfgTrue.loopGuard, true);
		const cfgFalse = resolveConfig({
			file: { loopGuard: false },
			env: {} as EnvRecord,
		});
		assert.equal(cfgFalse.loopGuard, false);
	});

	it("resolveConfig: env bogus value falls through to file then default true", () => {
		const cfgFromFile = resolveConfig({
			file: { loopGuard: true },
			env: { [ENV.loopGuard]: "on" } as EnvRecord,
		});
		assert.equal(cfgFromFile.loopGuard, true);
		const cfgFromDefault = resolveConfig({
			env: { [ENV.loopGuard]: "yes" } as EnvRecord,
		});
		assert.equal(cfgFromDefault.loopGuard, DEFAULT_LOOP_GUARD);
		assert.equal(cfgFromDefault.loopGuard, true);
	});

	it("resolveConfig: env 'auto' falls through to file then default true (sentinel was dropped)", () => {
		const cfgFromFile = resolveConfig({
			file: { loopGuard: true },
			env: { [ENV.loopGuard]: "auto" } as EnvRecord,
		});
		assert.equal(cfgFromFile.loopGuard, true);
		const cfgFromDefault = resolveConfig({
			env: { [ENV.loopGuard]: "auto" } as EnvRecord,
		});
		assert.equal(cfgFromDefault.loopGuard, DEFAULT_LOOP_GUARD);
		assert.equal(cfgFromDefault.loopGuard, true);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuard: false },
			env: { [ENV.loopGuard]: "" } as EnvRecord,
		});
		assert.equal(cfg.loopGuard, false);
	});

	it("resolveConfig: file boolean is honored when env is unset", () => {
		const cfgOn = resolveConfig({ file: { loopGuard: true } });
		assert.equal(cfgOn.loopGuard, true);
		const cfgOff = resolveConfig({ file: { loopGuard: false } });
		assert.equal(cfgOff.loopGuard, false);
	});

	it("resolveConfig: nothing configured returns the default true (ON for all sessions)", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.loopGuard, DEFAULT_LOOP_GUARD);
		assert.equal(cfg.loopGuard, true);
	});

	// --- ENV map ---

	it("ENV.loopGuard is the documented namespace", () => {
		assert.equal(ENV.loopGuard, "PI_CONTEXT_TRIMMER_LOOP_GUARD");
	});
});

// ─── loopGuardThreshold (nudge threshold, positive integer) ────────────

describe("loopGuardThreshold", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: positive integer is extracted", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: 3 }).loopGuardThreshold, 3);
		assert.equal(parseConfigFile({ loopGuardThreshold: 1 }).loopGuardThreshold, 1);
		assert.equal(parseConfigFile({ loopGuardThreshold: 100 }).loopGuardThreshold, 100);
	});

	it("file parse: zero is treated as absent (matches isPositiveNumber's open-lower bound)", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: 0 }).loopGuardThreshold, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: -1 }).loopGuardThreshold, undefined);
		assert.equal(parseConfigFile({ loopGuardThreshold: -100 }).loopGuardThreshold, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: Number.NaN }).loopGuardThreshold, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: Number.POSITIVE_INFINITY }).loopGuardThreshold, undefined);
		assert.equal(parseConfigFile({ loopGuardThreshold: Number.NEGATIVE_INFINITY }).loopGuardThreshold, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardThreshold: "3" }).loopGuardThreshold, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).loopGuardThreshold, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "5" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 5);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 3);
	});

	it("resolveConfig: non-positive env (0, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.loopGuardThreshold, 3);
		const cfgNeg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "-1" } as EnvRecord,
		});
		assert.equal(cfgNeg.loopGuardThreshold, 3);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardThreshold: 3 },
			env: { [ENV.loopGuardThreshold]: "lots" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 3);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { loopGuardThreshold: 7 } });
		assert.equal(cfg.loopGuardThreshold, 7);
	});

	it("resolveConfig: nothing configured leaves the field undefined", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.loopGuardThreshold, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.loopGuardThreshold]: "10" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardThreshold, 10);
		assert.equal(typeof cfg.loopGuardThreshold, "number");
	});

	// --- ENV map ---

	it("ENV.loopGuardThreshold is the documented namespace", () => {
		assert.equal(ENV.loopGuardThreshold, "PI_CONTEXT_TRIMMER_LOOP_GUARD_THRESHOLD");
	});
});

// ─── loopGuardHardBlock (hard-block threshold, positive integer) ──────

describe("loopGuardHardBlock", () => {
	// --- parseConfigFile (file channel) ---

	it("file parse: positive integer is extracted", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: 3 }).loopGuardHardBlock, 3);
		assert.equal(parseConfigFile({ loopGuardHardBlock: 1 }).loopGuardHardBlock, 1);
		assert.equal(parseConfigFile({ loopGuardHardBlock: 100 }).loopGuardHardBlock, 100);
	});

	it("file parse: zero is treated as absent (matches isPositiveNumber's open-lower bound)", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: 0 }).loopGuardHardBlock, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: -1 }).loopGuardHardBlock, undefined);
		assert.equal(parseConfigFile({ loopGuardHardBlock: -100 }).loopGuardHardBlock, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: Number.NaN }).loopGuardHardBlock, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: Number.POSITIVE_INFINITY }).loopGuardHardBlock, undefined);
		assert.equal(parseConfigFile({ loopGuardHardBlock: Number.NEGATIVE_INFINITY }).loopGuardHardBlock, undefined);
	});

	it("file parse: non-numeric (string) is treated as absent", () => {
		assert.equal(parseConfigFile({ loopGuardHardBlock: "3" }).loopGuardHardBlock, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).loopGuardHardBlock, undefined);
	});

	// --- resolveConfig (env wins over file) ---

	it("resolveConfig: env wins over file", () => {
		const cfg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "7" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 7);
	});

	it("resolveConfig: empty-string env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 3);
	});

	it("resolveConfig: non-positive env (0, negative) falls back to file", () => {
		const cfgZero = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.loopGuardHardBlock, 3);
		const cfgNeg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "-1" } as EnvRecord,
		});
		assert.equal(cfgNeg.loopGuardHardBlock, 3);
	});

	it("resolveConfig: non-numeric env falls back to file", () => {
		const cfg = resolveConfig({
			file: { loopGuardHardBlock: 3 },
			env: { [ENV.loopGuardHardBlock]: "many" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 3);
	});

	it("resolveConfig: file-only returns the file value", () => {
		const cfg = resolveConfig({ file: { loopGuardHardBlock: 5 } });
		assert.equal(cfg.loopGuardHardBlock, 5);
	});

	it("resolveConfig: nothing configured leaves the field undefined (hard-block off by default)", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.loopGuardHardBlock, undefined);
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.loopGuardHardBlock]: "8" } as EnvRecord,
		});
		assert.equal(cfg.loopGuardHardBlock, 8);
		assert.equal(typeof cfg.loopGuardHardBlock, "number");
	});

	// --- ENV map ---

	it("ENV.loopGuardHardBlock is the documented namespace", () => {
		assert.equal(ENV.loopGuardHardBlock, "PI_CONTEXT_TRIMMER_LOOP_GUARD_HARD_BLOCK");
	});
});


// ─── asyncMode (the background-summarizer opt-out) ─────────────────────
//
// `asyncMode` is a boolean toggle. `true` (default) turns the
// background (non-blocking) summarizer ON; `false` restores the
// legacy synchronous behavior. The knob is exposed in BOTH
// channels (env `PI_CONTEXT_TRIMMER_ASYNC_MODE` and the config-file
// `asyncMode` field) per the tandem principle; precedence is
// env > file > default. Badly-typed values are treated as absent
// (the resolver falls through to the next precedence layer).

describe("asyncMode — file channel (parseConfigFile)", () => {
	it("file parse: true is accepted", () => {
		assert.equal(parseConfigFile({ asyncMode: true }).asyncMode, true);
	});

	it("file parse: false is accepted", () => {
		assert.equal(parseConfigFile({ asyncMode: false }).asyncMode, false);
	});

	it("file parse: badly-typed values are treated as absent", () => {
		// Strings, numbers, null, undefined, and objects are
		// all rejected — only the strict `true` or `false`
		// boolean survives. The fallback chain (env > file >
		// default) means a badly-typed value falls through to
		// the next layer rather than crashing the resolver.
		assert.equal(parseConfigFile({ asyncMode: "yes" }).asyncMode, undefined, "string 'yes' is rejected");
		assert.equal(parseConfigFile({ asyncMode: 1 }).asyncMode, undefined, "number 1 is rejected (strict-boolean guard)");
		assert.equal(parseConfigFile({ asyncMode: 0 }).asyncMode, undefined, "number 0 is rejected (strict-boolean guard)");
		assert.equal(parseConfigFile({ asyncMode: null }).asyncMode, undefined, "null is rejected");
		assert.equal(parseConfigFile({ asyncMode: undefined }).asyncMode, undefined, "undefined is rejected");
		assert.equal(parseConfigFile({ asyncMode: {} }).asyncMode, undefined, "object is rejected");
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).asyncMode, undefined);
	});
});

describe("asyncMode — resolveConfig (precedence)", () => {
	it("default: nothing configured → DEFAULT_ASYNC_MODE (true)", () => {
		const cfg = resolveConfig({});
		assert.equal(cfg.asyncMode, DEFAULT_ASYNC_MODE, "default asyncMode matches DEFAULT_ASYNC_MODE");
		assert.equal(cfg.asyncMode, true, "DEFAULT_ASYNC_MODE is true (background ON by default)");
	});

	it("file override: asyncMode: false wins over the default", () => {
		const cfg = resolveConfig({ file: { asyncMode: false } });
		assert.equal(cfg.asyncMode, false, "file value (false) overrides the default (true)");
	});

	it("file override: asyncMode: true matches the default but is honored when set", () => {
		const cfg = resolveConfig({ file: { asyncMode: true } });
		assert.equal(cfg.asyncMode, true);
	});

	it("env override: PI_CONTEXT_TRIMMER_ASYNC_MODE=1 → true", () => {
		const cfg = resolveConfig({ env: { [ENV.asyncMode]: "1" } as EnvRecord });
		assert.equal(cfg.asyncMode, true, "env '1' forces asyncMode ON");
	});

	it("env override: PI_CONTEXT_TRIMMER_ASYNC_MODE=0 → false", () => {
		const cfg = resolveConfig({ env: { [ENV.asyncMode]: "0" } as EnvRecord });
		assert.equal(cfg.asyncMode, false, "env '0' forces asyncMode OFF");
	});

	it("env > file: env=0 wins over file=true", () => {
		// When the operator sets both channels, env wins.
		const cfg = resolveConfig({
			file: { asyncMode: true },
			env: { [ENV.asyncMode]: "0" } as EnvRecord,
		});
		assert.equal(cfg.asyncMode, false, "env '0' overrides file true");
	});

	it("env > file: env=1 wins over file=false", () => {
		const cfg = resolveConfig({
			file: { asyncMode: false },
			env: { [ENV.asyncMode]: "1" } as EnvRecord,
		});
		assert.equal(cfg.asyncMode, true, "env '1' overrides file false");
	});

	it("env unset falls back to file value", () => {
		const cfg = resolveConfig({
			file: { asyncMode: false },
			env: {},
		});
		assert.equal(cfg.asyncMode, false, "env unset → file value (false)");
	});

	it("non-'1'/'0' env value falls back to file value", () => {
		// Only the strict "1" / "0" tokens are honored. Any other
		// string (including "true", "yes", "on", an empty string)
		// is treated as "no override" so the resolver falls
		// through to the file / default layer.
		const cfg = resolveConfig({
			file: { asyncMode: false },
			env: { [ENV.asyncMode]: "true" } as EnvRecord,
		});
		assert.equal(cfg.asyncMode, false, "env 'true' is not honored; file false wins");
		const cfgEmpty = resolveConfig({
			file: { asyncMode: false },
			env: { [ENV.asyncMode]: "" } as EnvRecord,
		});
		assert.equal(cfgEmpty.asyncMode, false, "empty env string is treated as no override");
	});

	it("ENV.asyncMode is the documented namespace", () => {
		assert.equal(ENV.asyncMode, "PI_CONTEXT_TRIMMER_ASYNC_MODE");
	});
});

describe("DEFAULT_ASYNC_MODE", () => {
	it("is the documented boolean constant (true — background ON by default)", () => {
		assert.equal(DEFAULT_ASYNC_MODE, true);
	});
});

// ─── reasoningBlockCap (the count-based reasoning trim) ───────────────
//
// `reasoningBlockCap` is the operator-configurable knob that controls
// how many `type:"thinking"` content blocks the wiring layer keeps
// per message stream (counted from the latest). Integer semantics:
// `-1` = send all (passthrough), `0` = send none, any positive
// integer is the count of blocks to keep. The knob is exposed in
// BOTH channels (env `PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP` and
// the `reasoningBlockCap` JSON key) per the tandem principle;
// precedence is env > file > compile-time default (`1`).
//
// The new validator `isValidBlockCap` is file-private — the public
// surface tests assert against is `parseConfigFile` and
// `resolveConfig` (the contract surface the wiring reads). Badly-
// typed values in either channel fall through to the next precedence
// layer (the existing `parseConfigFile` rule — never throw).

describe("reasoningBlockCap — file channel (parseConfigFile)", () => {
	it("file parse: -1 (passthrough sentinel) is accepted", () => {
		assert.equal(parseConfigFile({ reasoningBlockCap: -1 }).reasoningBlockCap, -1);
	});

	it("file parse: 0 (send-none sentinel) is accepted", () => {
		assert.equal(parseConfigFile({ reasoningBlockCap: 0 }).reasoningBlockCap, 0);
	});

	it("file parse: 1 (the default) is accepted", () => {
		assert.equal(parseConfigFile({ reasoningBlockCap: 1 }).reasoningBlockCap, 1);
	});

	it("file parse: a positive integer is accepted", () => {
		assert.equal(parseConfigFile({ reasoningBlockCap: 3 }).reasoningBlockCap, 3);
		assert.equal(parseConfigFile({ reasoningBlockCap: 100 }).reasoningBlockCap, 100);
	});

	it("file parse: value < -1 is treated as absent", () => {
		// -2 and below fail `isValidBlockCap`'s `v >= -1` check
		// and are treated as absent (the resolver falls through
		// to the env / default layer).
		assert.equal(parseConfigFile({ reasoningBlockCap: -2 }).reasoningBlockCap, undefined);
		assert.equal(parseConfigFile({ reasoningBlockCap: -100 }).reasoningBlockCap, undefined);
	});

	it("file parse: a non-integer (float) is treated as absent", () => {
		// `isValidBlockCap` requires `Number.isInteger`; floats
		// fail that check (1.5 is the canonical "non-integer"
		// case) and are treated as absent.
		assert.equal(parseConfigFile({ reasoningBlockCap: 1.5 }).reasoningBlockCap, undefined);
		assert.equal(parseConfigFile({ reasoningBlockCap: 0.5 }).reasoningBlockCap, undefined);
		assert.equal(parseConfigFile({ reasoningBlockCap: -0.5 }).reasoningBlockCap, undefined);
	});

	it("file parse: non-numeric (string, boolean, null, object) is treated as absent", () => {
		assert.equal(parseConfigFile({ reasoningBlockCap: "1" }).reasoningBlockCap, undefined, "string '1' is rejected (the JSON channel does not coerce)");
		assert.equal(parseConfigFile({ reasoningBlockCap: true }).reasoningBlockCap, undefined, "boolean true is rejected");
		assert.equal(parseConfigFile({ reasoningBlockCap: null }).reasoningBlockCap, undefined, "null is rejected");
		assert.equal(parseConfigFile({ reasoningBlockCap: { a: 1 } }).reasoningBlockCap, undefined, "object is rejected");
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ reasoningBlockCap: Number.NaN }).reasoningBlockCap, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ reasoningBlockCap: Number.POSITIVE_INFINITY }).reasoningBlockCap, undefined);
		assert.equal(parseConfigFile({ reasoningBlockCap: Number.NEGATIVE_INFINITY }).reasoningBlockCap, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).reasoningBlockCap, undefined);
	});
});

describe("reasoningBlockCap — resolveConfig (precedence)", () => {
	// The wiring layer's contract is `cfg.reasoningBlockCap ?? REASONING_BLOCK_CAP_DEFAULT`
	// — the resolver returns `undefined` when neither channel sets
	// a value, and the wiring layer applies the compile-time
	// default. The tests below assert the resolver's behavior; the
	// wiring layer's default-applies behavior is covered in
	// `integration.test.ts` (the end-to-end context-handler test).

	it("env > file: env wins when both channels set a value", () => {
		const cfg = resolveConfig({
			file: { reasoningBlockCap: 3 },
			env: { [ENV.reasoningBlockCap]: "5" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, 5, "env value 5 wins over file value 3");
	});

	it("env wins with -1 (passthrough sentinel)", () => {
		const cfg = resolveConfig({
			file: { reasoningBlockCap: 1 },
			env: { [ENV.reasoningBlockCap]: "-1" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, -1, "env -1 wins over file 1 (passthrough sentinel is honored)");
	});

	it("env wins with 0 (send-none sentinel)", () => {
		const cfg = resolveConfig({
			file: { reasoningBlockCap: 1 },
			env: { [ENV.reasoningBlockCap]: "0" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, 0, "env 0 wins over file 1 (send-none sentinel is honored)");
	});

	it("file-only: env unset, file sets a value → file value returned", () => {
		const cfg = resolveConfig({
			file: { reasoningBlockCap: 7 },
		});
		assert.equal(cfg.reasoningBlockCap, 7, "file-only returns the file value");
	});

	it("nothing configured: both unset → resolver returns undefined (wiring applies the compile-time default)", () => {
		// The resolver does NOT apply a default itself — the
		// wiring layer (index.ts) is what reads
		// `REASONING_BLOCK_CAP_DEFAULT` when the resolver returns
		// undefined. The two-layer contract is intentional: the
		// resolver is the "configured value" surface, the wiring
		// is the "apply the default" surface.
		const cfg = resolveConfig({});
		assert.equal(cfg.reasoningBlockCap, undefined, "no value configured → undefined (wiring layer applies the default)");
	});

	it("empty-string env falls back to file value", () => {
		const cfg = resolveConfig({
			file: { reasoningBlockCap: 3 },
			env: { [ENV.reasoningBlockCap]: "" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, 3, "empty-string env is treated as no override; file value wins");
	});

	it("badly-typed env (non-integer string) falls back to file value", () => {
		// The env parser is strict: a non-numeric string ("abc")
		// returns undefined from `parseBlockCapEnv`; a non-integer
		// numeric string ("1.5") likewise returns undefined
		// (Number('1.5') === 1.5, which fails Number.isInteger).
		// The fallback chain: env (undefined) → file value.
		const cfgAbc = resolveConfig({
			file: { reasoningBlockCap: 3 },
			env: { [ENV.reasoningBlockCap]: "abc" } as EnvRecord,
		});
		assert.equal(cfgAbc.reasoningBlockCap, 3, "env 'abc' falls back to file value");
		const cfgFloat = resolveConfig({
			file: { reasoningBlockCap: 3 },
			env: { [ENV.reasoningBlockCap]: "1.5" } as EnvRecord,
		});
		assert.equal(cfgFloat.reasoningBlockCap, 3, "env '1.5' (non-integer) falls back to file value");
	});

	it("badly-typed file value falls back to env (then to undefined)", () => {
		// The contract: callers should pipe the raw JSON through
		// `parseConfigFile` first to get a clean `ParsedConfigFile`,
		// then pass the parsed result to `resolveConfig`. The
		// resolver does NOT re-validate its `file` parameter —
		// validation lives in `parseConfigFile`. The two-step
		// pipeline is the public surface: parse → resolve.
		const parsed = parseConfigFile({ reasoningBlockCap: "1" });
		const cfg = resolveConfig({
			file: parsed,
			env: { [ENV.reasoningBlockCap]: "5" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, 5, "parseConfigFile drops the bad file value; env value wins");
	});

	it("badly-typed in BOTH channels → resolver returns undefined", () => {
		// The two-step pipeline: parseConfigFile drops the bad
		// file value, then resolveConfig's env parser drops the
		// bad env string. The resolver returns undefined when
		// neither channel yields a valid value.
		const parsed = parseConfigFile({ reasoningBlockCap: "1" });
		const cfg = resolveConfig({
			file: parsed,
			env: { [ENV.reasoningBlockCap]: "abc" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, undefined, "both channels badly-typed → undefined (wiring default applies)");
	});

	it("env value < -1 falls back to file value (or undefined)", () => {
		// `parseBlockCapEnv` rejects values less than -1 (the
		// passthrough sentinel is the lower bound). An env of
		// "-2" returns undefined; the file value (or default)
		// applies.
		const cfgFile = resolveConfig({
			file: { reasoningBlockCap: 3 },
			env: { [ENV.reasoningBlockCap]: "-2" } as EnvRecord,
		});
		assert.equal(cfgFile.reasoningBlockCap, 3, "env -2 falls back to file value");
		const cfgUnset = resolveConfig({
			env: { [ENV.reasoningBlockCap]: "-100" } as EnvRecord,
		});
		assert.equal(cfgUnset.reasoningBlockCap, undefined, "env -100, no file → undefined");
	});

	// --- env parse grammar ---

	it("env parse: numeric integer string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.reasoningBlockCap]: "10" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, 10);
		assert.equal(typeof cfg.reasoningBlockCap, "number");
	});

	it("env parse: the -1 sentinel is preserved as a number, not coerced to 0", () => {
		// -1 is the passthrough sentinel. The env parser must
		// preserve it as the integer -1 (not coerce to 0 or any
		// other value).
		const cfg = resolveConfig({
			env: { [ENV.reasoningBlockCap]: "-1" } as EnvRecord,
		});
		assert.equal(cfg.reasoningBlockCap, -1, "env -1 is preserved as the passthrough sentinel");
	});

	// --- ENV map ---

	it("ENV.reasoningBlockCap is the documented namespace", () => {
		assert.equal(ENV.reasoningBlockCap, "PI_CONTEXT_TRIMMER_REASONING_BLOCK_CAP");
	});
});

describe("reasoningBlockCap — file parse: all-or-nothing per field", () => {
	// The existing "badly-typed values are treated as absent" rule
	// applies per-field, not per-document. A well-typed
	// `reasoningBlockCap` does NOT depend on the other fields'
	// shape (and vice versa).
	it("file parse: one well-typed field does not poison a neighboring badly-typed field", () => {
		const f = parseConfigFile({
			reasoningBlockCap: 3,
			tier1MaxTokens: "75000" as unknown as number, // badly-typed
		});
		assert.equal(f.reasoningBlockCap, 3, "well-typed reasoningBlockCap survives a neighboring bad value");
		assert.equal(f.tier1MaxTokens, undefined, "the badly-typed neighboring field is dropped");
	});
});

// ─── intercomKeepLast (Rule 1 of the pre-budget collapse) ─────────
//
// `intercomKeepLast` is the operator-configurable knob that controls
// how many `intercom_message` custom entries the wiring layer keeps
// per message stream (counted from the latest). Integer semantics:
// `-1` = send all (passthrough), `0` = send none, any positive
// integer is the count of entries to keep. The knob is exposed in
// BOTH channels (env `PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST` and
// the `intercomKeepLast` JSON key) per the tandem principle;
// precedence is env > file > compile-time default (`DEFAULT_INTERCOM_KEEP_LAST`
// = `-1`, mirroring the `reasoningBlockCap` `-1` precedent). The
// wiring layer coerces floats with `Math.trunc` (summaWords
// precedent) before passing the value to the pure policy function.

describe("intercomKeepLast — file channel (parseConfigFile)", () => {
	it("file parse: -1 (passthrough sentinel) is accepted", () => {
		assert.equal(parseConfigFile({ intercomKeepLast: -1 }).intercomKeepLast, -1);
	});

	it("file parse: 0 (send-none sentinel) is accepted", () => {
		assert.equal(parseConfigFile({ intercomKeepLast: 0 }).intercomKeepLast, 0);
	});

	it("file parse: a positive integer is accepted", () => {
		assert.equal(parseConfigFile({ intercomKeepLast: 1 }).intercomKeepLast, 1);
		assert.equal(parseConfigFile({ intercomKeepLast: 5 }).intercomKeepLast, 5);
		assert.equal(parseConfigFile({ intercomKeepLast: 100 }).intercomKeepLast, 100);
	});

	it("file parse: value < -1 is treated as absent", () => {
		// -2 and below fail `isValidBlockCap`'s `v >= -1` check
		// and are treated as absent (the resolver falls through
		// to the env / default layer). The intercomKeepLast
		// resolver reuses `isValidBlockCap` (the same integer-
		// including-sentinel predicate the reasoningBlockCap
		// resolver uses).
		assert.equal(parseConfigFile({ intercomKeepLast: -2 }).intercomKeepLast, undefined);
		assert.equal(parseConfigFile({ intercomKeepLast: -100 }).intercomKeepLast, undefined);
	});

	it("file parse: a non-integer (float) is treated as absent", () => {
		// `isValidBlockCap` requires `Number.isInteger`; floats
		// fail that check and are treated as absent. The
		// `Math.trunc` coercion lives at the wiring layer (per
		// the summaWords precedent), not at the resolver.
		assert.equal(parseConfigFile({ intercomKeepLast: 1.5 }).intercomKeepLast, undefined);
		assert.equal(parseConfigFile({ intercomKeepLast: 0.5 }).intercomKeepLast, undefined);
		assert.equal(parseConfigFile({ intercomKeepLast: -0.5 }).intercomKeepLast, undefined);
	});

	it("file parse: non-numeric (string, boolean, null, object) is treated as absent", () => {
		assert.equal(parseConfigFile({ intercomKeepLast: "5" }).intercomKeepLast, undefined, "string '5' is rejected (the JSON channel does not coerce)");
		assert.equal(parseConfigFile({ intercomKeepLast: true }).intercomKeepLast, undefined, "boolean true is rejected");
		assert.equal(parseConfigFile({ intercomKeepLast: null }).intercomKeepLast, undefined, "null is rejected");
		assert.equal(parseConfigFile({ intercomKeepLast: { a: 1 } }).intercomKeepLast, undefined, "object is rejected");
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ intercomKeepLast: Number.NaN }).intercomKeepLast, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ intercomKeepLast: Number.POSITIVE_INFINITY }).intercomKeepLast, undefined);
		assert.equal(parseConfigFile({ intercomKeepLast: Number.NEGATIVE_INFINITY }).intercomKeepLast, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).intercomKeepLast, undefined);
	});
});

describe("intercomKeepLast — resolveConfig (precedence)", () => {
	// The wiring layer's contract is
	// `cfg.intercomKeepLast !== undefined ? Math.trunc(cfg.intercomKeepLast) : DEFAULT_INTERCOM_KEEP_LAST`
	// — the resolver returns `undefined` when neither channel sets
	// a value, and the wiring layer applies the compile-time
	// default. The tests below assert the resolver's behavior; the
	// wiring layer's `Math.trunc` coercion is covered in
	// `integration.test.ts`.

	it("env > file: env wins when both channels set a value", () => {
		const cfg = resolveConfig({
			file: { intercomKeepLast: 3 },
			env: { [ENV.intercomKeepLast]: "5" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, 5, "env value 5 wins over file value 3");
	});

	it("env wins with -1 (passthrough sentinel)", () => {
		const cfg = resolveConfig({
			file: { intercomKeepLast: 1 },
			env: { [ENV.intercomKeepLast]: "-1" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, -1, "env -1 wins over file 1 (passthrough sentinel is honored)");
	});

	it("env wins with 0 (send-none sentinel)", () => {
		const cfg = resolveConfig({
			file: { intercomKeepLast: 1 },
			env: { [ENV.intercomKeepLast]: "0" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, 0, "env 0 wins over file 1 (send-none sentinel is honored)");
	});

	it("file-only: env unset, file sets a value → file value returned", () => {
		const cfg = resolveConfig({
			file: { intercomKeepLast: 7 },
		});
		assert.equal(cfg.intercomKeepLast, 7, "file-only returns the file value");
	});

	it("nothing configured: both unset → resolver returns undefined (wiring applies the compile-time default)", () => {
		// The resolver does NOT apply a default itself — the
		// wiring layer (index.ts) is what reads
		// `DEFAULT_INTERCOM_KEEP_LAST` when the resolver returns
		// undefined. The two-layer contract mirrors the existing
		// `reasoningBlockCap` shape.
		const cfg = resolveConfig({});
		assert.equal(cfg.intercomKeepLast, undefined, "no value configured → undefined (wiring layer applies the default)");
	});

	it("DEFAULT_INTERCOM_KEEP_LAST is the documented constant (-1 passthrough)", () => {
		// The default is `-1` (passthrough — every intercom_message
		// survives) so existing operators see no behavior change
		// when upgrading. To opt in to a cap, set the env var or
		// JSON key to `0` (send none) or a positive integer
		// (keep the last N).
		assert.equal(DEFAULT_INTERCOM_KEEP_LAST, -1);
	});

	it("empty-string env falls back to file value", () => {
		const cfg = resolveConfig({
			file: { intercomKeepLast: 3 },
			env: { [ENV.intercomKeepLast]: "" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, 3, "empty-string env is treated as no override; file value wins");
	});

	it("badly-typed env (non-integer string) falls back to file value", () => {
		// The env parser is strict: a non-numeric string ("abc")
		// returns undefined; a non-integer numeric string ("1.5")
		// likewise returns undefined (Number('1.5') === 1.5, which
		// fails Number.isInteger). The fallback chain: env
		// (undefined) → file value.
		const cfgAbc = resolveConfig({
			file: { intercomKeepLast: 3 },
			env: { [ENV.intercomKeepLast]: "abc" } as EnvRecord,
		});
		assert.equal(cfgAbc.intercomKeepLast, 3, "env 'abc' falls back to file value");
		const cfgFloat = resolveConfig({
			file: { intercomKeepLast: 3 },
			env: { [ENV.intercomKeepLast]: "1.5" } as EnvRecord,
		});
		assert.equal(cfgFloat.intercomKeepLast, 3, "env '1.5' (non-integer) falls back to file value");
	});

	it("badly-typed file value falls back to env (then to undefined)", () => {
		// The two-step pipeline: parseConfigFile drops the bad
		// file value, then resolveConfig's env parser picks up
		// the env value.
		const parsed = parseConfigFile({ intercomKeepLast: "5" });
		const cfg = resolveConfig({
			file: parsed,
			env: { [ENV.intercomKeepLast]: "3" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, 3, "parseConfigFile drops the bad file value; env value wins");
	});

	it("badly-typed in BOTH channels → resolver returns undefined", () => {
		// The two-step pipeline: parseConfigFile drops the bad
		// file value, then resolveConfig's env parser drops the
		// bad env string. The resolver returns undefined when
		// neither channel yields a valid value.
		const parsed = parseConfigFile({ intercomKeepLast: "5" });
		const cfg = resolveConfig({
			file: parsed,
			env: { [ENV.intercomKeepLast]: "abc" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, undefined, "both channels badly-typed → undefined (wiring default applies)");
	});

	it("env value < -1 falls back to file value (or undefined)", () => {
		const cfgFile = resolveConfig({
			file: { intercomKeepLast: 3 },
			env: { [ENV.intercomKeepLast]: "-2" } as EnvRecord,
		});
		assert.equal(cfgFile.intercomKeepLast, 3, "env -2 falls back to file value");
		const cfgUnset = resolveConfig({
			env: { [ENV.intercomKeepLast]: "-100" } as EnvRecord,
		});
		assert.equal(cfgUnset.intercomKeepLast, undefined, "env -100, no file → undefined");
	});

	// --- env parse grammar ---

	it("env parse: numeric integer string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.intercomKeepLast]: "10" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, 10);
		assert.equal(typeof cfg.intercomKeepLast, "number");
	});

	it("env parse: the -1 sentinel is preserved as a number, not coerced to 0", () => {
		const cfg = resolveConfig({
			env: { [ENV.intercomKeepLast]: "-1" } as EnvRecord,
		});
		assert.equal(cfg.intercomKeepLast, -1, "env -1 is preserved as the passthrough sentinel");
	});

	// --- ENV map ---

	it("ENV.intercomKeepLast is the documented namespace", () => {
		assert.equal(ENV.intercomKeepLast, "PI_CONTEXT_TRIMMER_INTERCOM_KEEP_LAST");
	});

	// --- Math.trunc coercion at the wiring layer (covered as a
	//     config-layer test for the resolveConfig contract: the
	//     resolver does NOT coerce; float inputs are rejected by
	//     the parseConfigFile `isValidBlockCap` predicate and
	//     treated as absent). The wiring layer's coercion is
	//     exercised end-to-end in `integration.test.ts`.

	it("resolver contract: floats are treated as absent at the parse layer; the wiring layer applies Math.trunc to a configured integer value", () => {
		// The resolver does not coerce floats — the parseConfigFile
		// predicate `isValidBlockCap` rejects non-integers, so a
		// file value of `1.5` is dropped. The wiring layer
		// (`index.ts`) coerces the resolved integer to its integer
		// form via `Math.trunc(cfg.intercomKeepLast)` — a
		// deliberate `60.0` becomes `60`, a deliberate `60.5`
		// would be stripped to `60`. The end-to-end wiring-layer
		// coercion is covered in `integration.test.ts`.
		const parsedFloat = parseConfigFile({ intercomKeepLast: 1.5 });
		assert.equal(parsedFloat.intercomKeepLast, undefined, "non-integer file value is treated as absent (Math.trunc is the wiring layer's job, not the resolver's)");
		const parsedInteger = parseConfigFile({ intercomKeepLast: 5 });
		assert.equal(parsedInteger.intercomKeepLast, 5, "integer file value survives the parse");
	});
});
// ─── tokenEstimatorDivisor (the operator-configurable chars-per-token) ─
//
// `tokenEstimatorDivisor` is the operator-configurable knob that
// controls the chars-per-token constant the policy uses for every
// per-message token estimate (the trimmable mass, the protected mass,
// the system-prompt mass, the `[summa: …]` envelope tag). The knob
// is exposed in BOTH channels (env
// `PI_CONTEXT_TRIMMER_TOKEN_ESTIMATOR_DIVISOR` and the
// `tokenEstimatorDivisor` JSON key) per the tandem principle;
// precedence is env > JSON > undefined. The wiring layer coerces
// with `Math.trunc` to an integer (summaWords precedent) when
// passing the value to the pure policy. The policy's
// `TOKEN_ESTIMATOR_DIVISOR_DEFAULT = 3` is the compile-time
// fallback when neither channel sets a value.
//
// The validator `isPositiveNumber` (the existing predicate for the
// numeric threshold fields) applies: non-numeric, zero, negative,
// `NaN`, and `Infinity` are all treated as absent so the resolver
// falls through to the next precedence layer. There is no "default"
// for the resolver — the wiring layer applies the compile-time
// default when the resolver returns undefined.

describe("tokenEstimatorDivisor — file channel (parseConfigFile)", () => {
	it("file parse: well-typed positive number is extracted", () => {
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: 3 }).tokenEstimatorDivisor, 3);
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: 4 }).tokenEstimatorDivisor, 4);
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: 1 }).tokenEstimatorDivisor, 1);
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: 100 }).tokenEstimatorDivisor, 100);
	});

	it("file parse: non-numeric value (string) is treated as absent", () => {
		// The file channel does NOT coerce strings to numbers; the
		// `isPositiveNumber` predicate accepts only `typeof === "number"`.
		// Operators who want a string-valued JSON entry must use a
		// numeric JSON literal, not a quoted string.
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: "3" }).tokenEstimatorDivisor, undefined);
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: "4" }).tokenEstimatorDivisor, undefined);
	});

	it("file parse: zero is treated as absent (not a valid divisor; chars/0 is undefined)", () => {
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: 0 }).tokenEstimatorDivisor, undefined);
	});

	it("file parse: negative number is treated as absent", () => {
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: -1 }).tokenEstimatorDivisor, undefined);
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: -100 }).tokenEstimatorDivisor, undefined);
	});

	it("file parse: NaN is treated as absent", () => {
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: Number.NaN }).tokenEstimatorDivisor, undefined);
	});

	it("file parse: Infinity (positive or negative) is treated as absent", () => {
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: Number.POSITIVE_INFINITY }).tokenEstimatorDivisor, undefined);
		assert.equal(parseConfigFile({ tokenEstimatorDivisor: Number.NEGATIVE_INFINITY }).tokenEstimatorDivisor, undefined);
	});

	it("file parse: missing key leaves the field undefined", () => {
		assert.equal(parseConfigFile({ personalityPath: "/p" }).tokenEstimatorDivisor, undefined);
	});
});

describe("tokenEstimatorDivisor — resolveConfig (precedence)", () => {
	// The wiring layer's contract is
	// `cfg.tokenEstimatorDivisor !== undefined ? Math.trunc(cfg.tokenEstimatorDivisor) : TOKEN_ESTIMATOR_DIVISOR_DEFAULT`
	// — the resolver returns `undefined` when neither channel sets a
	// value, and the wiring layer applies the compile-time default.
	// The tests below assert the resolver's behavior; the wiring
	// layer's default-applies behavior is covered in
	// `integration.test.ts` (the end-to-end context-handler test).

	it("env > file: env wins when both channels set a value", () => {
		const cfg = resolveConfig({
			file: { tokenEstimatorDivisor: 4 },
			env: { [ENV.tokenEstimatorDivisor]: "3" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, 3, "env value 3 wins over file value 4 (the tandem rule)");
	});

	it("env wins: env 4 forces the legacy chars/4 default over file 3", () => {
		const cfg = resolveConfig({
			file: { tokenEstimatorDivisor: 3 },
			env: { [ENV.tokenEstimatorDivisor]: "4" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, 4, "env value 4 wins over file value 3 (the legacy chars/4 default is reachable via env)");
	});

	it("file-only: env unset, file sets a value → file value returned", () => {
		const cfg = resolveConfig({
			file: { tokenEstimatorDivisor: 4 },
		});
		assert.equal(cfg.tokenEstimatorDivisor, 4, "file-only returns the file value");
	});

	it("nothing configured: both unset → resolver returns undefined (wiring applies the compile-time default)", () => {
		// The resolver does NOT apply a default itself — the
		// wiring layer (index.ts) is what reads
		// `TOKEN_ESTIMATOR_DIVISOR_DEFAULT` when the resolver
		// returns undefined. The two-layer contract is intentional:
		// the resolver is the "configured value" surface, the
		// wiring is the "apply the default" surface.
		const cfg = resolveConfig({});
		assert.equal(cfg.tokenEstimatorDivisor, undefined, "no value configured → undefined (wiring layer applies the compile-time default)");
	});

	it("empty-string env falls back to file value", () => {
		const cfg = resolveConfig({
			file: { tokenEstimatorDivisor: 4 },
			env: { [ENV.tokenEstimatorDivisor]: "" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, 4, "empty-string env is treated as no override; file value wins");
	});

	it("non-numeric env falls back to file value", () => {
		// The env parser is strict: a non-numeric string ("abc")
		// returns undefined from `parseNumberEnv`; the fallback
		// chain (env undefined → file value) returns the file
		// value. The `parseNumberEnv` shape matches every other
		// numeric knob in the file (tier1MaxTokens, tier2MaxTokens,
		// summaWords, recencyFloor, loopGuardThreshold, etc.).
		const cfg = resolveConfig({
			file: { tokenEstimatorDivisor: 4 },
			env: { [ENV.tokenEstimatorDivisor]: "not-a-number" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, 4, "env 'not-a-number' falls back to file value");
	});

	it("badly-typed env (zero, negative) falls back to file value", () => {
		// The env parser applies the same `isPositiveNumber`
		// predicate the file parser uses: zero, negative, NaN,
		// and Infinity are all rejected and treated as absent.
		const cfgZero = resolveConfig({
			file: { tokenEstimatorDivisor: 4 },
			env: { [ENV.tokenEstimatorDivisor]: "0" } as EnvRecord,
		});
		assert.equal(cfgZero.tokenEstimatorDivisor, 4, "env '0' falls back to file value");
		const cfgNeg = resolveConfig({
			file: { tokenEstimatorDivisor: 4 },
			env: { [ENV.tokenEstimatorDivisor]: "-1" } as EnvRecord,
		});
		assert.equal(cfgNeg.tokenEstimatorDivisor, 4, "env '-1' falls back to file value");
	});

	it("badly-typed file value falls back to env (then to undefined)", () => {
		// The two-step pipeline: parseConfigFile drops the bad
		// file value, then resolveConfig's env parser picks up
		// the env value. The resolver returns the env value
		// when the file channel is absent and env is set.
		const parsed = parseConfigFile({ tokenEstimatorDivisor: "3" });
		const cfg = resolveConfig({
			file: parsed,
			env: { [ENV.tokenEstimatorDivisor]: "4" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, 4, "parseConfigFile drops the bad file value; env value wins");
	});

	it("badly-typed in BOTH channels → resolver returns undefined", () => {
		// The two-step pipeline: parseConfigFile drops the bad
		// file value, then resolveConfig's env parser drops the
		// bad env string. The resolver returns undefined when
		// neither channel yields a valid value.
		const parsed = parseConfigFile({ tokenEstimatorDivisor: "3" });
		const cfg = resolveConfig({
			file: parsed,
			env: { [ENV.tokenEstimatorDivisor]: "abc" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, undefined, "both channels badly-typed → undefined (wiring default applies)");
	});

	// --- env parse grammar ---

	it("env parse: numeric string is coerced to number", () => {
		const cfg = resolveConfig({
			env: { [ENV.tokenEstimatorDivisor]: "4" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, 4, "env '4' is coerced to the number 4");
		assert.equal(typeof cfg.tokenEstimatorDivisor, "number", "the parsed value is a number, not a string");
	});

	it("env parse: large positive integer is preserved", () => {
		// The validator's only constraint is `v > 0`; large
		// positive integers are accepted. Operators with an
		// unusually sparse token ratio (chars/10, e.g.) can
		// reach it through the env channel.
		const cfg = resolveConfig({
			env: { [ENV.tokenEstimatorDivisor]: "10" } as EnvRecord,
		});
		assert.equal(cfg.tokenEstimatorDivisor, 10);
		assert.equal(typeof cfg.tokenEstimatorDivisor, "number");
	});

	// --- ENV map ---

	it("ENV.tokenEstimatorDivisor is the documented namespace", () => {
		assert.equal(ENV.tokenEstimatorDivisor, "PI_CONTEXT_TRIMMER_TOKEN_ESTIMATOR_DIVISOR");
	});
});
