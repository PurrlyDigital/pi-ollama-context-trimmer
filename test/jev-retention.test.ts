import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyJevRetentionCandidates } from "../jev-retention.ts";

function candidate(id: string, text = `content for ${id}`) {
	return { id, text, tokens: Math.ceil(text.length / 3) };
}

describe("classifyJevRetentionCandidates", () => {
	it("returns validated Choice probabilities", async () => {
		let calls = 0;
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			calls++;
			const body = JSON.parse(String(init?.body)) as { model?: string; questions?: Record<string, unknown> };
			assert.equal(body.model, "jev-latest");
			assert.deepEqual(Object.keys(body.questions ?? {}), ["candidate_0", "candidate_1"]);
			return new Response(JSON.stringify({
				answers: {
					candidate_0: {
						type: "choice",
						choice: "keep",
						confidence: 0.8,
						probabilities: { keep: 0.9, drop: 0.08, uncertain: 0.02 },
					},
					candidate_1: {
						type: "choice",
						choice: "drop",
						confidence: 0.7,
						probabilities: { keep: 0.1, drop: 0.85, uncertain: 0.05 },
					},
				},
			}), { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof fetch;

		const result = await classifyJevRetentionCandidates({
			apiKey: "test-key",
			taskContext: "Complete the requested change.",
			candidates: [candidate("keep-me"), candidate("drop-me")],
			fetchImpl,
		});
		assert.equal(calls, 1);
		assert.equal(result.get("keep-me")?.choice, "keep");
		assert.equal(result.get("keep-me")?.keepProbability, 0.9);
		assert.equal(result.get("drop-me")?.choice, "drop");
	});

	it("does not retry a failed request", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return new Response("service unavailable", { status: 503 });
		}) as typeof fetch;
		const result = await classifyJevRetentionCandidates({
			apiKey: "test-key",
			taskContext: "task",
			candidates: [candidate("one")],
			fetchImpl,
		});
		assert.equal(calls, 1);
		assert.equal(result.size, 0);
	});

	it("uses one timeout for the complete invocation", async () => {
		let calls = 0;
		const signals = new Set<AbortSignal>();
		const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
			calls++;
			const signal = init?.signal;
			assert.ok(signal);
			signals.add(signal);
			return new Promise<Response>(() => {});
		}) as typeof fetch;
		const large = "x".repeat(50_000);
		const started = performance.now();
		const result = await classifyJevRetentionCandidates({
			apiKey: "test-key",
			taskContext: "task",
			candidates: Array.from({ length: 12 }, (_, index) => candidate(`c${index}`, large)),
			timeoutMs: 25,
			fetchImpl,
		});
		const elapsed = performance.now() - started;
		assert.equal(result.size, 0);
		assert.equal(signals.size, 1);
		assert.equal(calls, 4);
		assert.ok(elapsed < 250, `expected one bounded invocation, got ${elapsed}ms`);
	});

	it("ignores malformed answers", async () => {
		const fetchImpl = (async () => new Response(JSON.stringify({
			answers: {
				candidate_0: {
					choice: "keep",
					confidence: 4,
					probabilities: { keep: 2, drop: -1, uncertain: 0 },
				},
			},
		}), { status: 200 })) as typeof fetch;
		const result = await classifyJevRetentionCandidates({
			apiKey: "test-key",
			taskContext: "task",
			candidates: [candidate("bad")],
			fetchImpl,
		});
		assert.equal(result.size, 0);
	});
});
