import { describe, expect, it } from "bun:test";
import {
	CONTINUATION_EVALUATION_VERSION,
	type ContinuationObservationCapture,
	type ContinuationTrialInput,
	ContinuationEvaluationError,
	evaluateContinuationTrial,
	normalizeContinuationUsage,
} from "@oh-my-pi/pi-coding-agent/session/continuation-evaluation";

const CONSTRAINT = {
	id: "constraint-no-publish",
	kind: "constraint" as const,
	evidence: "EVIDENCE_UNFINISHED_CONSTRAINT_V1",
};

const FINDING = {
	id: "finding-review-base",
	kind: "finding" as const,
	evidence: "FINDING_IMMUTABLE_REVIEW_BASE_V1",
};

const COMPLETED_TASK = { id: "task-1", kind: "completed-task" as const };
const VERIFY_REVIEW_BASE = { id: "verify-review-base", kind: "verification" as const };
const REVIEW_OBLIGATION = { id: "review-round-2", kind: "review" as const };

const CAPTURED: ContinuationObservationCapture = {
	knowledge: "captured",
	operations: "captured",
	obligations: "captured",
	attempts: "captured",
	successors: "captured",
	costs: "captured",
	allowance: "captured",
};

const SOURCE_USAGE = {
	input: 120,
	output: 40,
	cacheRead: 80,
	cacheWrite: 16,
	total: 256,
	reasoning: 12,
};

const DESTINATION_USAGE = {
	input: 30,
	output: 18,
	cacheRead: 0,
	cacheWrite: 24,
	totalTokens: 72,
	reasoningTokens: 6,
};

function passingTrial(overrides: Partial<ContinuationTrialInput> = {}): ContinuationTrialInput {
	return {
		version: CONTINUATION_EVALUATION_VERSION,
		trialId: "PT-eval-pass",
		measurementScope: "scripted-control",
		capture: CAPTURED,
		lineage: {
			runId: "run-1",
			sourceSessionId: "sess-source",
			successorSessionIds: ["sess-dest"],
		},
		requiredKnowledge: [CONSTRAINT, FINDING],
		observedKnowledge: [CONSTRAINT, FINDING],
		completedOperations: [COMPLETED_TASK],
		observedOperations: [VERIFY_REVIEW_BASE],
		requiredObligations: [REVIEW_OBLIGATION],
		observedObligations: [REVIEW_OBLIGATION],
		attempts: [
			{
				id: "source-1",
				kind: "source",
				outcome: "succeeded",
				sessionId: "sess-source",
				provider: "anthropic",
				account: "acct-a",
				model: "scripted-source",
				sessionRole: "primary",
				usage: SOURCE_USAGE,
				requestCount: 4,
				rePrimingRequests: 0,
			},
			{
				id: "dest-rejected",
				kind: "destination",
				outcome: "rejected",
				provider: "openai",
				account: "acct-b",
				model: "scripted-ineligible",
				reason: "data-scope",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0 },
				requestCount: 0,
				briefingTokens: 0,
				contextLoadedTokens: 0,
				rePrimingRequests: 0,
			},
			{
				id: "dest-failed",
				kind: "destination",
				outcome: "failed",
				sessionId: "sess-dest-failed",
				provider: "openai",
				account: "acct-b",
				model: "scripted-dest",
				reason: "first-request-error",
				usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 4, totalTokens: 14, reasoningTokens: 0 },
				requestCount: 1,
				briefingTokens: 0,
				contextLoadedTokens: 0,
				rePrimingRequests: 0,
			},
			{
				id: "dest-budget",
				kind: "destination",
				outcome: "budget-limited",
				provider: "openai",
				account: "acct-c",
				model: "scripted-dest-2",
				reason: "attempt-budget",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0 },
				requestCount: 0,
				briefingTokens: 0,
				contextLoadedTokens: 0,
				rePrimingRequests: 0,
			},
			{
				id: "dest-ok",
				kind: "destination",
				outcome: "succeeded",
				sessionId: "sess-dest",
				provider: "openai",
				account: "acct-b",
				model: "scripted-dest",
				sessionRole: "primary",
				usage: DESTINATION_USAGE,
				requestCount: 3,
				briefingTokens: 48,
				contextLoadedTokens: 64,
				rePrimingRequests: 1,
				firstUsefulActionAtMs: 1_500,
			},
		],
		allowanceObservations: [
			{
				provider: "anthropic",
				account: "acct-a",
				windowId: "5h",
				epochId: "epoch-1",
				used: 80,
				limit: 100,
				unit: "percent",
				observedAtMs: 0,
			},
		],
		sourceExhaustedAtMs: 1_000,
		sourceRolloverAtMs: 120_000,
		...overrides,
	};
}

describe("evaluateContinuationTrial", () => {
	it("accepts independently observed preservation, verification, and obligations", () => {
		const result = evaluateContinuationTrial(passingTrial());

		expect(result.verdict).toEqual({ result: "pass", reasons: [] });
		expect(result.measurementScope).toBe("scripted-control");
		expect(result.coverage).toEqual(CAPTURED);
		expect(result.findings).toEqual([
			{
				kind: "preserved-knowledge",
				id: CONSTRAINT.id,
				reason: "preserved-knowledge:constraint:constraint-no-publish",
			},
			{
				kind: "preserved-knowledge",
				id: FINDING.id,
				reason: "preserved-knowledge:finding:finding-review-base",
			},
			{
				kind: "targeted-verification",
				id: VERIFY_REVIEW_BASE.id,
				reason: "targeted-verification:verify-review-base",
			},
		]);
		expect(result.costs.attempts.map(attempt => ({ id: attempt.attemptId, outcome: attempt.outcome }))).toEqual([
			{ id: "source-1", outcome: "succeeded" },
			{ id: "dest-rejected", outcome: "rejected" },
			{ id: "dest-failed", outcome: "failed" },
			{ id: "dest-budget", outcome: "budget-limited" },
			{ id: "dest-ok", outcome: "succeeded" },
		]);
		expect(result.costs.sourceUsage).toEqual(normalizeContinuationUsage(SOURCE_USAGE));
		expect(result.costs.destinationUsage).toEqual({
			input: 38,
			output: 20,
			cacheRead: 0,
			cacheWrite: 28,
			totalTokens: 86,
			reasoningTokens: 6,
		});
		expect(result.costs.briefingTokens).toBe(48);
		expect(result.costs.contextLoadedTokens).toBe(64);
		expect(result.costs.rePrimingRequests).toBe(1);
		expect(result.costs.cacheRead).toBe(80);
		expect(result.costs.cacheWrite).toBe(44);
		expect(result.costs.totalsComplete).toBe(true);
		expect(result.costs.dimensionComplete).toEqual({
			usage: true,
			requestCount: true,
			briefingTokens: true,
			contextLoadedTokens: true,
			rePrimingRequests: true,
			reasoningTokens: true,
		});
		expect(result.costs.scriptedUsage).toBe("synthetic");
		expect(result.costs.dimensionKind).toEqual({
			usage: "synthetic",
			requestCount: "measured",
			briefingTokens: "measured",
			briefingBytes: "unknown",
			contextLoadedTokens: "measured",
			contextLoadedBytes: "unknown",
			rePrimingRequests: "measured",
			reasoningTokens: "synthetic",
			transferOverheadBytes: "unknown",
			reconstructionOverheadBytes: "unknown",
			firstUsefulActionLatencyMs: "measured",
		});
		expect(result.costs.briefingBytes).toBeNull();
		expect(result.costs.contextLoadedBytes).toBeNull();
		expect(result.costs.transferOverheadBytes).toBeNull();
		expect(result.costs.reconstructionOverheadBytes).toBeNull();
		expect(result.costs.attempts.find(attempt => attempt.attemptId === "dest-ok")?.usageKind).toBe("synthetic");
		expect(result.costs.attempts.find(attempt => attempt.attemptId === "source-1")?.usageKind).toBe("synthetic");
		expect(result.costs.firstUsefulActionLatencyMs).toBe(500);
		expect(result.costs.usefulWorkBeforeSourceRollover).toBe(true);
		expect(result.costs.attempts.find(attempt => attempt.attemptId === "dest-ok")?.coldCache).toBe(true);
		expect(result.lineage).toEqual({
			runId: "run-1",
			sourceSessionId: "sess-source",
			successorSessionIds: ["sess-dest"],
		});
		expect(result.inferenceLimits).toEqual({
			providerFree: true,
			independentObservationsOnly: true,
			modelSelfAssurance: "ignored",
			semanticQuality: "not-evaluated",
			economicSavings: "not-evaluated",
			quotaPercentage: "not-computed",
			gateC: "not-run",
		});
	});

	it("rejects when a protected constraint is omitted from destination observations", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedKnowledge: [FINDING],
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["lost-knowledge:constraint:constraint-no-publish"]);
	});

	it("rejects when a protected finding is omitted from destination observations", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedKnowledge: [CONSTRAINT],
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["lost-knowledge:finding:finding-review-base"]);
	});

	it("rejects when destination observations replay a completed task", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedOperations: [COMPLETED_TASK],
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["replayed-completed-operation:completed-task:task-1"]);
		expect(result.findings.some(finding => finding.kind === "targeted-verification")).toBe(false);
	});

	it("rejects when destination evidence contradicts a required finding", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedKnowledge: [CONSTRAINT, { ...FINDING, evidence: "DIFFERENT_REVIEW_BASE" }],
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["contradicted-knowledge:finding:finding-review-base"]);
	});

	it("rejects when required and observed knowledge kinds differ", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedKnowledge: [CONSTRAINT, { ...FINDING, kind: "constraint" }],
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["contradicted-knowledge:finding:finding-review-base"]);
	});

	it("rejects when a required review obligation is missing", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedObligations: [],
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["missed-obligation:review:review-round-2"]);
	});

	it("rejects when a required obligation is observed with a different kind", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedObligations: [{ id: REVIEW_OBLIGATION.id, kind: "landing" }],
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["missed-obligation:review:review-round-2"]);
	});

	it("does not treat independently observed verification of completed work as replay", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				observedOperations: [{ id: COMPLETED_TASK.id, kind: "verification" }, VERIFY_REVIEW_BASE],
			}),
		);

		expect(result.verdict.result).toBe("pass");
		expect(result.findings).toContainEqual({
			kind: "targeted-verification",
			id: COMPLETED_TASK.id,
			reason: "targeted-verification:task-1",
		});
		expect(result.findings).toContainEqual({
			kind: "targeted-verification",
			id: VERIFY_REVIEW_BASE.id,
			reason: "targeted-verification:verify-review-base",
		});
		expect(result.findings.some(finding => finding.kind === "replayed-completed-operation")).toBe(false);
		expect(result.verdict.reasons).toEqual([]);
	});

	it("does not relabel observed replay as verification because expectations list its id", () => {
		for (const kind of ["completed-task", "implementation", "investigation"] as const) {
			const result = evaluateContinuationTrial(
				passingTrial({
					observedOperations: [{ id: COMPLETED_TASK.id, kind }],
					expectedVerifications: [{ id: COMPLETED_TASK.id, kind: "verification" }],
				}),
			);

			expect(result.verdict.result).toBe("reject");
			expect(result.verdict.reasons).toEqual(["replayed-completed-operation:completed-task:task-1"]);
			expect(result.findings.some(finding => finding.kind === "targeted-verification")).toBe(false);
		}
	});

	it("rejects when every destination attempt failed or was budget-limited", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				attempts: passingTrial().attempts.filter(attempt => attempt.id !== "dest-ok"),
			}),
		);

		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["no-successful-destination"]);
	});

	it("rejects when a succeeded destination is not a distinct recorded successor", () => {
		const emptySuccessors = evaluateContinuationTrial(
			passingTrial({
				lineage: { runId: "run-1", sourceSessionId: "sess-source", successorSessionIds: [] },
			}),
		);
		expect(emptySuccessors.verdict.result).toBe("reject");
		expect(emptySuccessors.verdict.reasons).toEqual(["no-distinct-recorded-successor"]);

		const unrelated = evaluateContinuationTrial(
			passingTrial({
				lineage: { runId: "run-1", sourceSessionId: "sess-source", successorSessionIds: ["sess-other"] },
			}),
		);
		expect(unrelated.verdict.result).toBe("reject");
		expect(unrelated.verdict.reasons).toEqual(["no-distinct-recorded-successor"]);
	});

	it("keeps failed and budget-limited destination attempts in the cost report", () => {
		const result = evaluateContinuationTrial(passingTrial());
		const byId = Object.fromEntries(result.costs.attempts.map(attempt => [attempt.attemptId, attempt]));

		expect(byId["dest-rejected"]?.outcome).toBe("rejected");
		expect(byId["dest-rejected"]?.reason).toBe("data-scope");
		expect(byId["dest-rejected"]?.coldCache).toBeNull();
		expect(byId["dest-failed"]?.outcome).toBe("failed");
		expect(byId["dest-failed"]?.usage?.totalTokens).toBe(14);
		expect(byId["dest-failed"]?.coldCache).toBe(true);
		expect(byId["dest-budget"]?.outcome).toBe("budget-limited");
		expect(byId["dest-budget"]?.reason).toBe("attempt-budget");
		expect(byId["dest-budget"]?.coldCache).toBeNull();
		expect(result.costs.sourceRequestCount).toBe(4);
		expect(result.costs.destinationRequestCount).toBe(4);
		expect(result.costs.knownRequestCount).toBe(8);
	});

	it("does not infer cold cache for destination attempts with no request", () => {
		const result = evaluateContinuationTrial(passingTrial());
		const byId = Object.fromEntries(result.costs.attempts.map(attempt => [attempt.attemptId, attempt]));

		expect(byId["dest-rejected"]?.requestCount).toBe(0);
		expect(byId["dest-rejected"]?.usage?.cacheRead).toBe(0);
		expect(byId["dest-rejected"]?.coldCache).toBeNull();
		expect(byId["dest-budget"]?.requestCount).toBe(0);
		expect(byId["dest-budget"]?.coldCache).toBeNull();
	});

	it("marks totals incomplete when a failed attempt has no usage capture", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				attempts: [
					{
						id: "source-1",
						kind: "source",
						outcome: "succeeded",
						usage: SOURCE_USAGE,
						requestCount: 2,
					},
					{
						id: "dest-failed",
						kind: "destination",
						outcome: "failed",
						reason: "transport",
						requestCount: 1,
					},
				],
			}),
		);

		expect(result.costs.attempts.map(attempt => attempt.attemptId)).toEqual(["source-1", "dest-failed"]);
		expect(result.costs.unknownUsageAttemptIds).toEqual(["dest-failed"]);
		expect(result.costs.totalsComplete).toBe(false);
		expect(result.costs.dimensionComplete.usage).toBe(false);
		expect(result.costs.scriptedUsage).toBe("synthetic");
		expect(result.costs.dimensionKind.usage).toBe("unknown");
		expect(result.costs.attempts.find(attempt => attempt.attemptId === "dest-failed")?.usageKind).toBeNull();
		expect(result.costs.attempts.find(attempt => attempt.attemptId === "source-1")?.usageKind).toBe("synthetic");
		expect(result.costs.destinationUsage).toBeNull();
		expect(result.costs.knownTotals).toEqual(normalizeContinuationUsage(SOURCE_USAGE));
		expect(result.verdict.result).toBe("reject");
		expect(result.verdict.reasons).toEqual(["no-successful-destination"]);
	});

	it("does not treat missing cost dimensions as zero or complete", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				attempts: [
					{
						id: "source-1",
						kind: "source",
						outcome: "succeeded",
						sessionId: "sess-source",
						usage: SOURCE_USAGE,
						requestCount: 2,
					},
					{
						id: "dest-ok",
						kind: "destination",
						outcome: "succeeded",
						sessionId: "sess-dest",
						usage: DESTINATION_USAGE,
						requestCount: 3,
						firstUsefulActionAtMs: 1_500,
					},
				],
			}),
		);

		expect(result.verdict.result).toBe("pass");
		expect(result.costs.briefingTokens).toBeNull();
		expect(result.costs.contextLoadedTokens).toBeNull();
		expect(result.costs.rePrimingRequests).toBeNull();
		expect(result.costs.totalsComplete).toBe(false);
		expect(result.costs.dimensionComplete).toEqual({
			usage: true,
			requestCount: true,
			briefingTokens: false,
			contextLoadedTokens: false,
			rePrimingRequests: false,
			reasoningTokens: true,
		});
		expect(result.costs.briefingBytes).toBeNull();
		expect(result.costs.contextLoadedBytes).toBeNull();
		expect(result.costs.transferOverheadBytes).toBeNull();
		expect(result.costs.reconstructionOverheadBytes).toBeNull();
		expect(result.costs.dimensionKind.briefingTokens).toBe("unknown");
		expect(result.costs.dimensionKind.contextLoadedTokens).toBe("unknown");
		expect(result.costs.dimensionKind.rePrimingRequests).toBe("unknown");
		expect(result.costs.dimensionKind.briefingBytes).toBe("unknown");
		expect(result.costs.dimensionKind.contextLoadedBytes).toBe("unknown");
		expect(result.costs.dimensionKind.transferOverheadBytes).toBe("unknown");
		expect(result.costs.dimensionKind.reconstructionOverheadBytes).toBe("unknown");
	});

	it("rejects after-rollover useful work and leaves unknown latency unknown", () => {
		const afterRollover = evaluateContinuationTrial(
			passingTrial({
				sourceExhaustedAtMs: 1_000,
				sourceRolloverAtMs: 1_200,
			}),
		);
		expect(afterRollover.costs.firstUsefulActionLatencyMs).toBe(500);
		expect(afterRollover.costs.usefulWorkBeforeSourceRollover).toBe(false);
		expect(afterRollover.verdict.result).toBe("reject");
		expect(afterRollover.verdict.reasons).toEqual(["useful-work-after-source-rollover"]);

		const unknownLatency = evaluateContinuationTrial(
			passingTrial({
				sourceExhaustedAtMs: undefined,
				sourceRolloverAtMs: undefined,
				attempts: passingTrial().attempts.map(attempt =>
					attempt.id === "dest-ok" ? { ...attempt, firstUsefulActionAtMs: undefined } : attempt,
				),
			}),
		);
		expect(unknownLatency.costs.firstUsefulActionLatencyMs).toBeNull();
		expect(unknownLatency.costs.usefulWorkBeforeSourceRollover).toBeNull();
		expect(unknownLatency.verdict.result).toBe("pass");

		const missingUseful = evaluateContinuationTrial(
			passingTrial({
				attempts: passingTrial().attempts.map(attempt =>
					attempt.id === "dest-ok" ? { ...attempt, firstUsefulActionAtMs: undefined } : attempt,
				),
			}),
		);
		expect(missingUseful.costs.usefulWorkBeforeSourceRollover).toBeNull();
		expect(missingUseful.verdict.result).toBe("incomplete");
		expect(missingUseful.verdict.reasons).toEqual(["missing-useful-work-observation"]);
	});

	it("returns incomplete when required observation captures are missing", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				capture: {
					...CAPTURED,
					knowledge: "missing",
					operations: "missing",
					obligations: "missing",
				},
			}),
		);

		expect(result.verdict.result).toBe("incomplete");
		expect(result.verdict.reasons).toEqual([
			"missing-capture:knowledge",
			"missing-capture:operations",
			"missing-capture:obligations",
		]);
		expect(result.coverage.knowledge).toBe("missing");
		expect(result.findings.some(finding => finding.kind === "lost-knowledge")).toBe(false);
		expect(result.findings.some(finding => finding.kind === "missed-obligation")).toBe(false);
	});

	it("returns incomplete for an uncaptured empty manifest instead of passing", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				requiredKnowledge: [],
				observedKnowledge: [],
				completedOperations: [],
				observedOperations: [],
				requiredObligations: [],
				observedObligations: [],
				attempts: [],
				allowanceObservations: undefined,
				lineage: { runId: "run-1", sourceSessionId: "sess-source", successorSessionIds: [] },
				capture: {
					knowledge: "missing",
					operations: "missing",
					obligations: "missing",
					attempts: "missing",
					successors: "missing",
					costs: "missing",
					allowance: "missing",
				},
			}),
		);

		expect(result.verdict.result).toBe("incomplete");
		expect(result.verdict.reasons).toEqual([
			"missing-capture:knowledge",
			"missing-capture:operations",
			"missing-capture:obligations",
			"missing-capture:attempts",
			"missing-capture:successors",
		]);
		expect(result.costs.totalsComplete).toBe(false);
		expect(result.costs.sourceUsage).toBeNull();
		expect(result.costs.briefingTokens).toBeNull();
		expect(result.allowance).toEqual([
			{ status: "unknown", reason: "missing", provider: null, account: null, windowId: null },
		]);
	});

	it("returns incomplete for unsupported continuity measurements", () => {
		const result = evaluateContinuationTrial(
			passingTrial({
				capture: { ...CAPTURED, operations: "unsupported" },
			}),
		);

		expect(result.verdict.result).toBe("incomplete");
		expect(result.verdict.reasons).toEqual(["unsupported-measurement:operations"]);
	});

	it("keeps provider account window allowance rows separate and unknown when missing", () => {
		const missing = evaluateContinuationTrial(passingTrial({ allowanceObservations: undefined }));
		expect(missing.allowance).toEqual([
			{ status: "unknown", reason: "missing", provider: null, account: null, windowId: null },
		]);
		expect(missing.inferenceLimits.quotaPercentage).toBe("not-computed");
		expect(missing.allowance.some(row => "percent" in row || "usedFraction" in row)).toBe(false);

		const separate = evaluateContinuationTrial(
			passingTrial({
				allowanceObservations: [
					{
						provider: "anthropic",
						account: "acct-a",
						windowId: "5h",
						used: 80,
						limit: 100,
						unit: "percent",
						observedAtMs: 10,
					},
					{
						provider: "anthropic",
						account: "acct-a",
						windowId: "7d",
						used: 10,
						limit: 100,
						unit: "percent",
						observedAtMs: 10,
					},
					{
						provider: "openai",
						account: "acct-b",
						windowId: "5h",
						used: 4,
						limit: 50,
						unit: "requests",
						observedAtMs: 10,
					},
				],
			}),
		);
		expect(separate.allowance).toHaveLength(3);
		expect(
			separate.allowance.map(row =>
				row.status === "observed" ? `${row.provider}:${row.account}:${row.windowId}` : row.reason,
			),
		).toEqual(["anthropic:acct-a:5h", "anthropic:acct-a:7d", "openai:acct-b:5h"]);
		expect(separate).not.toHaveProperty("quotaPercent");
		for (const row of separate.allowance) {
			expect(row).not.toHaveProperty("percent");
			expect(row).not.toHaveProperty("usedFraction");
			if (row.status === "observed") {
				expect(row.competingConsumers).toBeNull();
			}
		}
	});

	it("keeps incomplete allowance samples unknown rather than observed", () => {
		const incompleteMeasurement = evaluateContinuationTrial(
			passingTrial({
				allowanceObservations: [{ provider: "anthropic", account: "acct-a", windowId: "5h" }],
			}),
		);
		expect(incompleteMeasurement.allowance).toEqual([
			{
				status: "unknown",
				reason: "incomplete-measurement",
				provider: "anthropic",
				account: "acct-a",
				windowId: "5h",
			},
		]);

		const uncaptured = evaluateContinuationTrial(
			passingTrial({
				capture: { ...CAPTURED, allowance: "missing" },
			}),
		);
		expect(uncaptured.allowance).toEqual([
			{ status: "unknown", reason: "missing", provider: null, account: null, windowId: null },
		]);
		expect(uncaptured.verdict.result).toBe("pass");
	});

	it("does not invent semantic quality or savings scores", () => {
		const result = evaluateContinuationTrial(passingTrial());
		expect(result.measurementScope).toBe("scripted-control");
		expect(result.inferenceLimits.semanticQuality).toBe("not-evaluated");
		expect(result.inferenceLimits.economicSavings).toBe("not-evaluated");
		expect(result).not.toHaveProperty("qualityScore");
		expect(result).not.toHaveProperty("savings");
		expect(result.gateCComparison.status).toBe("not-authorized");
		expect(result.gateCComparison.tokenReductionAlone).toBe("does-not-pass");
		expect(result.gateCComparison.budgetLimitedRuns).toBe("report-incomplete-do-not-exclude");
	});

	it("round-trips as JSON for Main's artifact report", () => {
		const result = evaluateContinuationTrial(passingTrial());
		const copy = JSON.parse(JSON.stringify(result));
		expect(copy).toEqual(result);
		expect(copy.verdict.result).toBe("pass");
		expect(copy.measurementScope).toBe("scripted-control");
		expect(copy.costs.attempts.map((attempt: { attemptId: string }) => attempt.attemptId)).toEqual([
			"source-1",
			"dest-rejected",
			"dest-failed",
			"dest-budget",
			"dest-ok",
		]);
	});

	it("throws on an unsupported evaluation version", () => {
		expect(() =>
			evaluateContinuationTrial({
				...passingTrial(),
				version: 2 as unknown as typeof CONTINUATION_EVALUATION_VERSION,
			}),
		).toThrow(ContinuationEvaluationError);
	});

	it("keeps omitted byte totals unknown and sums only when every attempt is observed", () => {
		const partial = evaluateContinuationTrial(
			passingTrial({
				attempts: passingTrial().attempts.map(attempt =>
					attempt.id === "dest-ok"
						? {
								...attempt,
								briefingBytes: 120,
								contextLoadedBytes: 400,
								transferOverheadBytes: 80,
							}
						: attempt.id === "source-1"
							? { ...attempt, contextLoadedBytes: 200 }
							: attempt.id === "dest-failed"
								? { ...attempt, contextLoadedBytes: 16 }
								: attempt,
				),
			}),
		);
		expect(partial.costs.briefingBytes).toBeNull();
		expect(partial.costs.contextLoadedBytes).toBeNull();
		expect(partial.costs.transferOverheadBytes).toBeNull();
		expect(partial.costs.reconstructionOverheadBytes).toBeNull();
		expect(partial.costs.attempts.find(attempt => attempt.attemptId === "dest-ok")?.briefingBytes).toBe(120);
		expect(partial.costs.attempts.find(attempt => attempt.attemptId === "dest-ok")?.contextLoadedBytes).toBe(400);
		expect(partial.costs.attempts.find(attempt => attempt.attemptId === "source-1")?.contextLoadedBytes).toBe(200);
		expect(partial.costs.attempts.find(attempt => attempt.attemptId === "dest-failed")?.contextLoadedBytes).toBe(16);
		expect(
			partial.costs.attempts.find(attempt => attempt.attemptId === "dest-rejected")?.contextLoadedBytes,
		).toBeNull();
		expect(partial.costs.dimensionKind.briefingBytes).toBe("unknown");
		expect(partial.costs.dimensionKind.contextLoadedBytes).toBe("unknown");
		expect(partial.costs.dimensionKind.transferOverheadBytes).toBe("unknown");
		expect(partial.costs.dimensionKind.reconstructionOverheadBytes).toBe("unknown");
		expect(partial.costs.scriptedUsage).toBe("synthetic");

		const complete = evaluateContinuationTrial(
			passingTrial({
				attempts: passingTrial().attempts.map(attempt => ({
					...attempt,
					contextLoadedBytes:
						attempt.id === "source-1"
							? 200
							: attempt.id === "dest-failed"
								? 16
								: attempt.id === "dest-ok"
									? 400
									: 0,
					briefingBytes: attempt.kind === "destination" ? (attempt.id === "dest-ok" ? 120 : 0) : undefined,
					transferOverheadBytes: attempt.id === "dest-ok" ? 80 : 0,
				})),
			}),
		);
		expect(complete.costs.contextLoadedBytes).toBe(616);
		expect(complete.costs.briefingBytes).toBe(120);
		expect(complete.costs.transferOverheadBytes).toBe(80);
		expect(complete.costs.reconstructionOverheadBytes).toBeNull();
		expect(complete.costs.dimensionKind.contextLoadedBytes).toBe("measured");
		expect(complete.costs.dimensionKind.briefingBytes).toBe("measured");
		expect(complete.costs.dimensionKind.transferOverheadBytes).toBe("measured");
		expect(complete.costs.dimensionKind.reconstructionOverheadBytes).toBe("unknown");
	});
});

describe("normalizeContinuationUsage", () => {
	it("accepts SessionStats.tokens and catalog Usage shapes without filling unknown reasoning", () => {
		expect(normalizeContinuationUsage(SOURCE_USAGE)).toEqual({
			input: 120,
			output: 40,
			cacheRead: 80,
			cacheWrite: 16,
			totalTokens: 256,
			reasoningTokens: 12,
		});
		expect(normalizeContinuationUsage(DESTINATION_USAGE)).toEqual({
			input: 30,
			output: 18,
			cacheRead: 0,
			cacheWrite: 24,
			totalTokens: 72,
			reasoningTokens: 6,
		});
		expect(normalizeContinuationUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 })).toEqual({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			reasoningTokens: null,
		});
	});
});
