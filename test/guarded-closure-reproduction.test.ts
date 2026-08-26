import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

type ClosureStatus = "closed" | "rejected" | "replayed";

type ClosureResult = {
	status: ClosureStatus;
	events: string[];
};

type ClosureOptions = {
	approved?: boolean;
	open?: boolean;
	mergeable?: boolean;
	draft?: boolean;
	checksPassed?: boolean;
	baseBranch?: string;
	defaultBranch?: string;
	prNumber?: number;
	bindingComplete?: boolean;
	expectedHead?: string;
	merged?: boolean;
	failRemoteCleanup?: boolean;
};

type Fixture = {
	root: string;
	home: string;
	remote: string;
	work: string;
	feature: string;
	unrelated: string;
	prNumber: number;
	featureHead: string;
	unrelatedHead: string;
};

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function runGit(cwd: string, home: string, args: string[]): string {
	const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...environment,
			GIT_CONFIG_GLOBAL: join(home, "missing-global-git-config"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
		},
	}).trim();
}

function withEnvironment(values: Record<string, string>, action: () => void): void {
	const original = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
	try {
		Object.assign(process.env, values);
		action();
	} finally {
		for (const [key, value] of original) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function commit(work: string, home: string, message: string): void {
	runGit(work, home, ["add", "--all"]);
	runGit(work, home, [
		"-c",
		"user.name=Closure fixture",
		"-c",
		"user.email=closure-fixture@example.test",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		message,
	]);
}

function refValue(cwd: string, home: string, ref: string, gitDir?: string): string | undefined {
	const args = gitDir
		? ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", ref]
		: ["rev-parse", "--verify", "--quiet", ref];
	try {
		return runGit(cwd, home, args);
	} catch {
		return undefined;
	}
}

function branchFile(work: string, home: string, branch: string, path: string): string | undefined {
	try {
		return runGit(work, home, ["show", `${branch}:${path}`]);
	} catch {
		return undefined;
	}
}

function deleteBoundRef(cwd: string, home: string, ref: string, expectedHead: string, gitDir?: string): boolean {
	const args = gitDir
		? ["--git-dir", gitDir, "update-ref", "-d", ref, expectedHead]
		: ["update-ref", "-d", ref, expectedHead];
	try {
		runGit(cwd, home, args);
		return true;
	} catch {
		return false;
	}
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "context-trimmer-closure-"));
	fixtureRoots.push(root);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true });
	const remote = join(root, "origin.git");
	const work = join(root, "work");
	const feature = "closure-fixture";
	const unrelated = "keep-this-branch";

	runGit(root, home, ["init", "--bare", remote]);
	runGit(root, home, ["clone", remote, work]);
	runGit(work, home, ["switch", "-c", "main"]);
	writeFileSync(join(work, "base.txt"), "base\n");
	commit(work, home, "Create the base fixture");
	runGit(work, home, ["push", "-u", "origin", "main"]);
	runGit(root, home, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

	runGit(work, home, ["switch", "-c", unrelated]);
	writeFileSync(join(work, "unrelated.txt"), "keep\n");
	commit(work, home, "Create an unrelated branch");
	runGit(work, home, ["push", "-u", "origin", unrelated]);
	const unrelatedHead = refValue(work, home, `refs/heads/${unrelated}`);
	if (!unrelatedHead) {
		throw new Error("The fixture did not create the unrelated branch.");
	}

	runGit(work, home, ["switch", "main"]);
	runGit(work, home, ["switch", "-c", feature]);
	writeFileSync(join(work, "closure-proof.txt"), "guarded closure fixture\n");
	commit(work, home, "Create the closure fixture");
	runGit(work, home, ["push", "-u", "origin", feature]);
	const featureHead = refValue(work, home, `refs/heads/${feature}`);
	if (!featureHead) {
		throw new Error("The fixture did not create the feature branch.");
	}
	runGit(work, home, ["switch", "main"]);

	return {
		root,
		home,
		remote,
		work,
		feature,
		unrelated,
		prNumber: 17,
		featureHead,
		unrelatedHead,
	};
}

function closeFixture(fixture: Fixture, options: ClosureOptions = {}): ClosureResult {
	const events: string[] = [];
	const expectedHead = options.expectedHead ?? fixture.featureHead;
	const featureRef = `refs/heads/${fixture.feature}`;
	const remoteFeatureRef = `refs/heads/${fixture.feature}`;
	const reject = (reason: string): ClosureResult => ({
		status: "rejected",
		events: [...events, `rejected:${reason}`],
	});

	if ((options.prNumber ?? fixture.prNumber) !== fixture.prNumber) {
		return reject("pr-identity");
	}
	if (!(options.bindingComplete ?? true)) {
		return reject("binding");
	}
	if (!(options.open ?? true)) {
		return reject("state");
	}
	if (options.draft ?? false) {
		return reject("draft");
	}
	if (!(options.approved ?? true)) {
		return reject("approval");
	}
	if (!(options.mergeable ?? true)) {
		return reject("mergeable");
	}
	if (!(options.checksPassed ?? true)) {
		return reject("checks");
	}
	if ((options.defaultBranch ?? "main") !== "main" || (options.baseBranch ?? "main") !== "main") {
		return reject("default-branch");
	}
	if (runGit(fixture.work, fixture.home, ["status", "--porcelain"]) !== "") {
		return reject("worktree");
	}
	if (
		refValue(fixture.work, fixture.home, "refs/heads/main") !==
		refValue(fixture.root, fixture.home, "refs/heads/main", fixture.remote)
	) {
		return reject("worktree-sync");
	}

	events.push("validated");
	if (options.merged) {
		const expectedEvidence = `${fixture.prNumber}:${expectedHead}`;
		if (branchFile(fixture.work, fixture.home, "main", "closure-evidence.txt") !== expectedEvidence) {
			return reject("merged-evidence");
		}
		events.push("replay-merge-verified");
		const localHead = refValue(fixture.work, fixture.home, featureRef);
		if (localHead && !deleteBoundRef(fixture.work, fixture.home, featureRef, expectedHead)) {
			return reject("local-cleanup");
		}
		events.push(localHead ? "replay-local-ref-deleted" : "replay-local-ref-absent");
		const remoteHead = refValue(fixture.root, fixture.home, remoteFeatureRef, fixture.remote);
		if (remoteHead && !deleteBoundRef(fixture.root, fixture.home, remoteFeatureRef, expectedHead, fixture.remote)) {
			return reject("remote-cleanup");
		}
		events.push(remoteHead ? "replay-remote-ref-deleted" : "replay-remote-ref-absent");
		return { status: "replayed", events: [...events, "final-verified"] };
	}

	if (refValue(fixture.work, fixture.home, featureRef) !== expectedHead) {
		return reject("head");
	}
	if (refValue(fixture.root, fixture.home, remoteFeatureRef, fixture.remote) !== expectedHead) {
		return reject("remote-head");
	}

	runGit(fixture.work, fixture.home, ["merge", "--squash", expectedHead]);
	writeFileSync(join(fixture.work, "closure-evidence.txt"), `${fixture.prNumber}:${expectedHead}\n`);
	commit(fixture.work, fixture.home, `Close fixture pull request ${fixture.prNumber}`);
	runGit(fixture.work, fixture.home, ["push", "origin", "main"]);
	events.push("merged");

	const mainHead = refValue(fixture.work, fixture.home, "refs/heads/main");
	if (
		!mainHead ||
		refValue(fixture.root, fixture.home, "refs/heads/main", fixture.remote) !== mainHead ||
		branchFile(fixture.work, fixture.home, "main", "closure-proof.txt") !== "guarded closure fixture"
	) {
		return reject("default-branch-verification");
	}
	events.push("default-branch-verified");

	if (!deleteBoundRef(fixture.work, fixture.home, featureRef, expectedHead)) {
		return reject("local-cleanup");
	}
	events.push("local-ref-deleted");

	if (options.failRemoteCleanup) {
		runGit(fixture.root, fixture.home, [
			"--git-dir",
			fixture.remote,
			"update-ref",
			remoteFeatureRef,
			mainHead,
			expectedHead,
		]);
	}
	if (!deleteBoundRef(fixture.root, fixture.home, remoteFeatureRef, expectedHead, fixture.remote)) {
		return reject("remote-cleanup");
	}
	events.push("remote-ref-deleted");

	if (refValue(fixture.work, fixture.home, featureRef) || refValue(fixture.root, fixture.home, remoteFeatureRef, fixture.remote)) {
		return reject("final-verification");
	}
	return { status: "closed", events: [...events, "final-verified"] };
}

describe("guarded closure reproduction", () => {
	it("closes only the bound fixture and preserves unrelated refs", () => {
		const fixture = createFixture();
		const result = closeFixture(fixture);

		assert.equal(result.status, "closed");
		assert.deepEqual(result.events, [
			"validated",
			"merged",
			"default-branch-verified",
			"local-ref-deleted",
			"remote-ref-deleted",
			"final-verified",
		]);
		assert.equal(branchFile(fixture.work, fixture.home, "main", "closure-proof.txt"), "guarded closure fixture");
		assert.equal(refValue(fixture.work, fixture.home, `refs/heads/${fixture.feature}`), undefined);
		assert.equal(refValue(fixture.root, fixture.home, `refs/heads/${fixture.feature}`, fixture.remote), undefined);
		assert.equal(refValue(fixture.work, fixture.home, `refs/heads/${fixture.unrelated}`), fixture.unrelatedHead);
		assert.equal(
			refValue(fixture.root, fixture.home, `refs/heads/${fixture.unrelated}`, fixture.remote),
			fixture.unrelatedHead,
		);
	});

	it("ignores inherited Git configuration", () => {
		const outside = mkdtempSync(join(tmpdir(), "context-trimmer-outside-"));
		fixtureRoots.push(outside);
		writeFileSync(join(outside, "sentinel.txt"), "outside\n");
		withEnvironment(
			{
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.worktree",
				GIT_CONFIG_VALUE_0: outside,
			},
			() => {
				const fixture = createFixture();
				assert.equal(closeFixture(fixture).status, "closed");
			},
		);
		assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "outside\n");
		assert.deepEqual(readdirSync(outside).sort(), ["sentinel.txt"]);
	});

	it("rejects an incomplete or mismatched binding before merge", () => {
		const fixture = createFixture();
		const closed = closeFixture(fixture, { open: false });
		const draft = closeFixture(fixture, { draft: true });
		const unapproved = closeFixture(fixture, { approved: false });
		const unmergeable = closeFixture(fixture, { mergeable: false });
		const failedChecks = closeFixture(fixture, { checksPassed: false });
		const wrongBase = closeFixture(fixture, { baseBranch: "release" });
		const wrongHead = closeFixture(fixture, { expectedHead: "not-the-bound-head" });
		const mismatched = closeFixture(fixture, { prNumber: fixture.prNumber + 1 });
		writeFileSync(join(fixture.work, "uncommitted.txt"), "dirty\n");
		const dirty = closeFixture(fixture);

		assert.deepEqual(closed, { status: "rejected", events: ["rejected:state"] });
		assert.deepEqual(draft, { status: "rejected", events: ["rejected:draft"] });
		assert.deepEqual(unapproved, { status: "rejected", events: ["rejected:approval"] });
		assert.deepEqual(unmergeable, { status: "rejected", events: ["rejected:mergeable"] });
		assert.deepEqual(failedChecks, { status: "rejected", events: ["rejected:checks"] });
		assert.deepEqual(wrongBase, { status: "rejected", events: ["rejected:default-branch"] });
		assert.deepEqual(wrongHead, { status: "rejected", events: ["validated", "rejected:head"] });
		assert.deepEqual(mismatched, { status: "rejected", events: ["rejected:pr-identity"] });
		assert.deepEqual(dirty, { status: "rejected", events: ["rejected:worktree"] });
		assert.equal(branchFile(fixture.work, fixture.home, "main", "closure-proof.txt"), undefined);
		assert.equal(refValue(fixture.work, fixture.home, `refs/heads/${fixture.feature}`), fixture.featureHead);
		assert.equal(
			refValue(fixture.root, fixture.home, `refs/heads/${fixture.feature}`, fixture.remote),
			fixture.featureHead,
		);
	});

	it("rejects incomplete cleanup and performs no later cleanup", () => {
		const fixture = createFixture();
		const result = closeFixture(fixture, { failRemoteCleanup: true });

		assert.equal(result.status, "rejected");
		assert.deepEqual(result.events, [
			"validated",
			"merged",
			"default-branch-verified",
			"local-ref-deleted",
			"rejected:remote-cleanup",
		]);
		assert.equal(branchFile(fixture.work, fixture.home, "main", "closure-proof.txt"), "guarded closure fixture");
		assert.equal(refValue(fixture.work, fixture.home, `refs/heads/${fixture.feature}`), undefined);
		assert.notEqual(refValue(fixture.root, fixture.home, `refs/heads/${fixture.feature}`, fixture.remote), undefined);
		assert.equal(
			refValue(fixture.root, fixture.home, `refs/heads/${fixture.unrelated}`, fixture.remote),
			fixture.unrelatedHead,
		);
	});

	it("replays a merged closure with absent bound refs without new mutations", () => {
		const fixture = createFixture();
		const closed = closeFixture(fixture);
		const mainHead = refValue(fixture.work, fixture.home, "refs/heads/main");
		const replay = closeFixture(fixture, { merged: true });

		assert.equal(closed.status, "closed");
		assert.deepEqual(replay, {
			status: "replayed",
			events: [
				"validated",
				"replay-merge-verified",
				"replay-local-ref-absent",
				"replay-remote-ref-absent",
				"final-verified",
			],
		});
		assert.equal(refValue(fixture.work, fixture.home, "refs/heads/main"), mainHead);
		assert.equal(refValue(fixture.work, fixture.home, `refs/heads/${fixture.unrelated}`), fixture.unrelatedHead);
		assert.equal(
			refValue(fixture.root, fixture.home, `refs/heads/${fixture.unrelated}`, fixture.remote),
			fixture.unrelatedHead,
		);
	});

	it("rejects replay with ambiguous identity or an incomplete binding", () => {
		const fixture = createFixture();
		assert.equal(closeFixture(fixture).status, "closed");
		const mainHead = refValue(fixture.work, fixture.home, "refs/heads/main");
		const ambiguousIdentity = closeFixture(fixture, { merged: true, prNumber: fixture.prNumber + 1 });
		const incompleteBinding = closeFixture(fixture, { merged: true, bindingComplete: false });
		const mismatchedHead = closeFixture(fixture, { merged: true, expectedHead: "not-the-bound-head" });

		assert.deepEqual(ambiguousIdentity, { status: "rejected", events: ["rejected:pr-identity"] });
		assert.deepEqual(incompleteBinding, { status: "rejected", events: ["rejected:binding"] });
		assert.deepEqual(mismatchedHead, { status: "rejected", events: ["validated", "rejected:merged-evidence"] });
		assert.equal(refValue(fixture.work, fixture.home, "refs/heads/main"), mainHead);
		assert.equal(refValue(fixture.work, fixture.home, `refs/heads/${fixture.feature}`), undefined);
		assert.equal(refValue(fixture.root, fixture.home, `refs/heads/${fixture.feature}`, fixture.remote), undefined);
		assert.equal(refValue(fixture.work, fixture.home, `refs/heads/${fixture.unrelated}`), fixture.unrelatedHead);
		assert.equal(
			refValue(fixture.root, fixture.home, `refs/heads/${fixture.unrelated}`, fixture.remote),
			fixture.unrelatedHead,
		);
	});
});
