import { describe, expect, it } from "bun:test";
import { CASE_TIMEOUT_MS, REQUEST_CAP, runCrossProviderCase } from "./fixtures/continuation/cross-provider-session";

describe("PT-01 v2 inline cross-provider continuation", () => {
	it(
		"E2: Anthropic Messages → OpenAI Responses, instruction-first, automatic continuationPreparation",
		async () => {
			const result = await runCrossProviderCase({
				caseId: "E2",
				direction: "anthropic-to-openai-responses",
				interleaving: "instruction-first",
				workflowKind: "inline-session",
				handoff: "automatic",
			});
			expect(result.caseId).toBe("E2");
			expect(result.evaluation.verdict).toEqual({ result: "pass", reasons: [] });
			expect(result.evaluation.measurementScope).toBe("scripted-control");
			expect(result.evaluation.inferenceLimits.semanticQuality).toBe("not-evaluated");
			expect(result.evaluation.inferenceLimits.economicSavings).toBe("not-evaluated");
			expect(result.evaluation.costs.usefulWorkBeforeSourceRollover).toBe(true);
			expect(result.destinationRequests).toBeGreaterThan(0);
			expect(result.sourceRequests + result.destinationRequests).toBeLessThanOrEqual(REQUEST_CAP);
			expect(result.elapsedFirstUsefulActionMs).toBeGreaterThanOrEqual(0);
			expect(result.elapsedFirstUsefulActionMs).toBeLessThan(CASE_TIMEOUT_MS);
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"E4: OpenAI Responses → Anthropic Messages, result-first, manual continueOnApprovedDestination",
		async () => {
			const result = await runCrossProviderCase({
				caseId: "E4",
				direction: "openai-responses-to-anthropic",
				interleaving: "result-first",
				workflowKind: "inline-session",
				handoff: "manual",
			});
			expect(result.caseId).toBe("E4");
			expect(result.evaluation.verdict).toEqual({ result: "pass", reasons: [] });
			expect(result.evaluation.measurementScope).toBe("scripted-control");
			expect(result.evaluation.costs.usefulWorkBeforeSourceRollover).toBe(true);
			expect(result.destinationRequests).toBeGreaterThan(0);
			expect(result.sourceRequests + result.destinationRequests).toBeLessThanOrEqual(REQUEST_CAP);
			expect(result.elapsedFirstUsefulActionMs).toBeLessThan(CASE_TIMEOUT_MS);
		},
		{ timeout: CASE_TIMEOUT_MS },
	);
});
