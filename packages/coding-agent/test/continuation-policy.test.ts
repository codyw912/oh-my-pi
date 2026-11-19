import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	type ContinuationActionCost,
	type ContinuationActionInput,
	type ContinuationDestination,
	type ContinuationDestinationObservation,
	type ContinuationDestinationSelectionInput,
	type ContinuationModelCapabilities,
	type ContinuationPolicyV1,
	type ContinuationRequiredCapabilities,
	checkContinuationDestination,
	chooseContinuationAction,
	continuationDestinationKey,
	ContinuationPolicyError,
	selectContinuationDestination,
	validateContinuationPolicy,
} from "@oh-my-pi/pi-coding-agent/session/continuation-policy";

function destination(overrides: Partial<ContinuationDestination> = {}): ContinuationDestination {
	return {
		provider: "anthropic",
		account: "acct-primary",
		model: "claude-opus",
		roles: ["primary"],
		settings: { thinkingLevel: ThinkingLevel.High },
		dataScope: "workspace",
		...overrides,
	};
}

function policyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		version: 1,
		revision: "rev-1",
		candidates: [destination()],
		roles: ["primary", "advisor"],
		dataScope: "workspace",
		unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
		attemptBudget: 2,
		restrictedAccounts: [],
		...overrides,
	};
}

function boundPolicy(overrides: Record<string, unknown> = {}): ContinuationPolicyV1 {
	return validateContinuationPolicy(policyInput(overrides));
}

function model(overrides: Partial<ContinuationModelCapabilities> = {}): ContinuationModelCapabilities {
	return {
		provider: "anthropic",
		id: "claude-opus",
		account: "acct-primary",
		supportsTools: true,
		input: ["text", "image"],
		contextWindow: 200_000,
		reasoning: true,
		supportedEfforts: [Effort.Low, Effort.Medium, Effort.High],
		serviceTierFamily: "anthropic",
		...overrides,
	};
}

function required(overrides: Partial<ContinuationRequiredCapabilities> = {}): ContinuationRequiredCapabilities {
	return {
		tools: true,
		modalities: ["text"],
		contextTokens: 12_000,
		settings: { thinkingLevel: ThinkingLevel.High },
		dataScope: "workspace",
		...overrides,
	};
}

function observation(overrides: Partial<ContinuationDestinationObservation> = {}): ContinuationDestinationObservation {
	return {
		policyRevision: "rev-1",
		role: "primary",
		model: model(),
		required: required(),
		allowances: [{ provider: "anthropic", account: "acct-primary", window: "weekly", headroom: "healthy" }],
		attemptsUsed: 0,
		unknownHeadroomRequestsUsed: 0,
		rejectedKeys: [],
		...overrides,
	};
}

function selection(
	overrides: Partial<ContinuationDestinationSelectionInput> = {},
): ContinuationDestinationSelectionInput {
	return {
		policyRevision: "rev-1",
		role: "primary",
		required: required(),
		allowances: [{ provider: "anthropic", account: "acct-primary", window: "weekly", headroom: "healthy" }],
		models: [model()],
		attemptsUsed: 0,
		unknownHeadroomRequestsUsed: 0,
		rejectedKeys: [],
		...overrides,
	};
}

describe("validateContinuationPolicy", () => {
	it("accepts a serializable explicit policy and rejects a changed shape", () => {
		const policy = boundPolicy();
		expect(JSON.parse(JSON.stringify(policy))).toEqual(policy);
		expect(() => validateContinuationPolicy({ ...policy, version: 2 })).toThrow(ContinuationPolicyError);
		expect(() => validateContinuationPolicy({ ...policy, roles: ["default"] })).toThrow(ContinuationPolicyError);
		expect(() =>
			validateContinuationPolicy({
				...policy,
				candidates: [{ ...destination(), settings: { thinkingLevel: "inherit" } }],
			}),
		).toThrow(ContinuationPolicyError);
		expect(() =>
			validateContinuationPolicy({
				...policy,
				unknownHeadroom: { allowFirstUsefulRequest: true, maxFirstUsefulRequests: 0 },
			}),
		).toThrow(ContinuationPolicyError);
	});
});

describe("checkContinuationDestination", () => {
	it("allows an exactly authorized destination before work", () => {
		const policy = boundPolicy();
		const decision = checkContinuationDestination(policy, policy.candidates[0]!, observation());
		expect(decision).toEqual({
			eligible: true,
			destination: policy.candidates[0],
			unknownHeadroomAllowed: false,
		});
	});

	it("rejects a staged destination after the policy revision changes", () => {
		const policy = boundPolicy({ revision: "rev-2" });
		const decision = checkContinuationDestination(policy, policy.candidates[0]!, observation());
		expect(decision.eligible).toBe(false);
		if (!decision.eligible) expect(decision.rejection.code).toBe("policy-revision-mismatch");
	});

	it("rejects a different model that shares an exhausted account and window", () => {
		const alias = destination({ model: "claude-sonnet" });
		const policy = boundPolicy({
			candidates: [destination(), alias],
		});
		const decision = checkContinuationDestination(
			policy,
			alias,
			observation({
				model: model({ id: "claude-sonnet" }),
				allowances: [{ provider: "anthropic", account: "acct-primary", window: "weekly", headroom: "exhausted" }],
			}),
		);
		expect(decision.eligible).toBe(false);
		if (!decision.eligible) expect(decision.rejection.code).toBe("headroom-exhausted");
	});

	it("rejects a policy-restricted account even when a model alias looks unused", () => {
		const alias = destination({ model: "claude-sonnet" });
		const policy = boundPolicy({
			candidates: [alias],
			restrictedAccounts: [{ provider: "anthropic", account: "acct-primary", window: "weekly" }],
		});
		const decision = checkContinuationDestination(
			policy,
			alias,
			observation({
				model: model({ id: "claude-sonnet" }),
				allowances: [{ provider: "anthropic", account: "acct-primary", window: "weekly", headroom: "healthy" }],
			}),
		);
		expect(decision.eligible).toBe(false);
		if (!decision.eligible) expect(decision.rejection.code).toBe("account-restricted");
	});

	it("treats unknown telemetry as not healthy unless an explicit first-useful-request bound remains", () => {
		const denied = boundPolicy();
		const unknown = observation({ allowances: [] });
		const deniedDecision = checkContinuationDestination(denied, denied.candidates[0]!, unknown);
		expect(deniedDecision.eligible).toBe(false);
		if (!deniedDecision.eligible) expect(deniedDecision.rejection.code).toBe("headroom-unknown");

		const allowed = boundPolicy({
			unknownHeadroom: { allowFirstUsefulRequest: true, maxFirstUsefulRequests: 1 },
		});
		const allowedDecision = checkContinuationDestination(allowed, allowed.candidates[0]!, unknown);
		expect(allowedDecision).toMatchObject({ eligible: true, unknownHeadroomAllowed: true });

		const exhaustedDecision = checkContinuationDestination(
			allowed,
			allowed.candidates[0]!,
			observation({ allowances: [], unknownHeadroomRequestsUsed: 1 }),
		);
		expect(exhaustedDecision.eligible).toBe(false);
		if (!exhaustedDecision.eligible)
			expect(exhaustedDecision.rejection.code).toBe("unknown-headroom-budget-exhausted");
	});

	it("rejects when the attempt budget is exhausted", () => {
		const policy = boundPolicy({ attemptBudget: 1 });
		const decision = checkContinuationDestination(policy, policy.candidates[0]!, observation({ attemptsUsed: 1 }));
		expect(decision.eligible).toBe(false);
		if (!decision.eligible) expect(decision.rejection.code).toBe("attempt-budget-exhausted");
	});

	it("rejects missing tools, modalities, and over-budget context without truncating", () => {
		const policy = boundPolicy();
		const dest = policy.candidates[0]!;
		const tools = checkContinuationDestination(policy, dest, observation({ model: model({ supportsTools: false }) }));
		expect(tools.eligible).toBe(false);
		if (!tools.eligible) expect(tools.rejection.code).toBe("tools-unsupported");

		const modality = checkContinuationDestination(
			policy,
			dest,
			observation({
				model: model({ input: ["text"] }),
				required: required({ modalities: ["text", "image"] }),
			}),
		);
		expect(modality.eligible).toBe(false);
		if (!modality.eligible) expect(modality.rejection.code).toBe("modality-unsupported");

		const context = checkContinuationDestination(
			policy,
			dest,
			observation({
				model: model({ contextWindow: 8_000 }),
				required: required({ contextTokens: 8_001 }),
			}),
		);
		expect(context.eligible).toBe(false);
		if (!context.eligible) expect(context.rejection.code).toBe("context-exceeded");
	});

	it("rejects unauthorized roles and settings instead of downgrading them", () => {
		const policy = boundPolicy({
			roles: ["primary", "advisor", "worker"],
			candidates: [destination({ roles: ["primary"], settings: { thinkingLevel: ThinkingLevel.High } })],
		});
		const dest = policy.candidates[0]!;
		const role = checkContinuationDestination(policy, dest, observation({ role: "worker" }));
		expect(role.eligible).toBe(false);
		if (!role.eligible) expect(role.rejection.code).toBe("role-unauthorized");

		const settings = checkContinuationDestination(
			policy,
			dest,
			observation({
				required: required({ settings: { thinkingLevel: ThinkingLevel.Medium } }),
			}),
		);
		expect(settings.eligible).toBe(false);
		if (!settings.eligible) expect(settings.rejection.code).toBe("settings-unsupported");

		const unsupportedEffort = checkContinuationDestination(
			policy,
			dest,
			observation({
				model: model({ supportedEfforts: [Effort.Low, Effort.Medium] }),
			}),
		);
		expect(unsupportedEffort.eligible).toBe(false);
		if (!unsupportedEffort.eligible) expect(unsupportedEffort.rejection.code).toBe("settings-unsupported");
	});

	it("rejects an unapproved data scope", () => {
		const policy = boundPolicy();
		const decision = checkContinuationDestination(
			policy,
			policy.candidates[0]!,
			observation({ required: required({ dataScope: "secrets" }) }),
		);
		expect(decision.eligible).toBe(false);
		if (!decision.eligible) expect(decision.rejection.code).toBe("data-scope-unauthorized");
	});
});

describe("selectContinuationDestination", () => {
	it("selects the first ordered eligible destination and records prior rejections", () => {
		const first = destination({ settings: {} });
		const second = destination({ provider: "openai", account: "acct-openai", model: "gpt-5", settings: {} });
		const policy = boundPolicy({
			candidates: [first, second],
			roles: ["primary"],
		});
		const result = selectContinuationDestination(
			policy,
			selection({
				allowances: [
					{ provider: "anthropic", account: "acct-primary", window: "weekly", headroom: "exhausted" },
					{ provider: "openai", account: "acct-openai", window: "weekly", headroom: "healthy" },
				],
				models: [
					model(),
					model({
						provider: "openai",
						id: "gpt-5",
						account: "acct-openai",
						reasoning: false,
						supportedEfforts: [],
					}),
				],
				required: required({ settings: {} }),
			}),
		);
		expect(result.destination).toEqual(second);
		expect(result.rejected.map(entry => entry.code)).toContain("headroom-exhausted");
	});

	it("does not revisit a rejected candidate and stops when the attempt budget is gone", () => {
		const first = destination();
		const second = destination({ provider: "openai", account: "acct-openai", model: "gpt-5", settings: {} });
		const policy = boundPolicy({
			candidates: [first, second],
			attemptBudget: 2,
		});
		const skipped = selectContinuationDestination(
			policy,
			selection({
				rejectedKeys: [continuationDestinationKey(first)],
				models: [
					model(),
					model({
						provider: "openai",
						id: "gpt-5",
						account: "acct-openai",
						reasoning: false,
						supportedEfforts: [],
					}),
				],
				allowances: [
					{ provider: "anthropic", account: "acct-primary", window: "weekly", headroom: "healthy" },
					{ provider: "openai", account: "acct-openai", window: "weekly", headroom: "healthy" },
				],
				required: required({ settings: {} }),
			}),
		);
		expect(skipped.destination).toEqual(second);
		expect(skipped.rejected[0]?.code).toBe("candidate-already-rejected");

		const exhausted = selectContinuationDestination(policy, selection({ attemptsUsed: 2 }));
		expect(exhausted.destination).toBeNull();
		expect(exhausted.rejected.map(entry => entry.code)).toEqual(["attempt-budget-exhausted"]);
	});

	it("does not mutate policy or selection input", () => {
		const policy = boundPolicy();
		const input = selection();
		const policySnapshot = structuredClone(policy);
		const inputSnapshot = structuredClone(input);
		selectContinuationDestination(policy, input);
		expect(policy).toEqual(policySnapshot);
		expect(input).toEqual(inputSnapshot);
	});
});

// Measured PT-01 E2 wire sizes from native Gate B output
// /nix/store/djhhna8mdfgy54xydfsq28wmciz6vcvm-omp-continuation-local-18.1.13.
// Allocation to candidate components below is synthetic, not a billing model.
const PT01_BYTES = { sourceWork: 962, destinationContext: 9111, briefing: 3194 };

function actionCost(overrides: Partial<ContinuationActionCost> = {}): ContinuationActionCost {
	return {
		maintenance: 0,
		transfer: 0,
		cacheRead: 0,
		cachePopulation: 0,
		reconstruction: 0,
		advisorRepriming: 0,
		remainingWork: 0,
		...overrides,
	};
}

function actionInput(): ContinuationActionInput {
	return {
		admission: { kind: "allow" },
		effectsSettled: true,
		compactionAllowed: true,
		fresh: checkContinuationDestination(boundPolicy(), destination(), observation()),
		workRevision: "work-1",
		costs: {
			workRevision: "work-1",
			unit: "bytes",
			kind: "scripted-control",
			actions: {
				continue: actionCost({ cacheRead: PT01_BYTES.sourceWork, remainingWork: 32 }),
				compact: actionCost({ maintenance: PT01_BYTES.briefing, remainingWork: 32 }),
				fresh: actionCost({
					transfer: PT01_BYTES.briefing,
					cachePopulation: PT01_BYTES.destinationContext,
					advisorRepriming: PT01_BYTES.sourceWork,
					remainingWork: 32,
				}),
			},
		},
	};
}

describe("chooseContinuationAction", () => {
	it("continues warm nearly finished work without a token-count rotation trigger", () => {
		const decision = chooseContinuationAction(actionInput());
		expect(decision.kind).toBe("continue");
		if (!("totals" in decision)) throw new Error("Expected a cost comparison");
		expect(decision.totals?.continue).toBe(994);
		expect(decision.evidenceKind).toBe("scripted-control");
	});

	it("charges a measured repeated evidence read instead of counting smaller bootstrap text as a win", async () => {
		using temp = TempDir.createSync("continuation-reconstruction");
		const evidence = Bun.file(path.join(temp.path(), "discovery.txt"));
		await Bun.write(evidence, "Prior investigation evidence.\n".repeat(400));
		await evidence.arrayBuffer(); // The warm actor has already read this evidence.
		const input = actionInput();
		input.compactionAllowed = false;
		input.costs!.actions.continue = actionCost({ cacheRead: PT01_BYTES.destinationContext });
		input.costs!.actions.fresh = actionCost({ transfer: PT01_BYTES.briefing });
		expect(chooseContinuationAction(input).kind).toBe("fresh");

		const reconstructed = await evidence.arrayBuffer();
		input.costs!.actions.fresh.reconstruction = reconstructed.byteLength;
		const decision = chooseContinuationAction(input);
		expect(decision.kind).toBe("continue");
		if (!("totals" in decision)) throw new Error("Expected measured reconstruction to be charged");
		expect(decision.totals?.fresh).toBe(PT01_BYTES.briefing + reconstructed.byteLength);
	});

	it("keeps unknown or stale costs from forcing a discretionary transition", () => {
		const input = actionInput();
		input.costs!.actions.fresh!.reconstruction = null;
		expect(chooseContinuationAction(input).kind).toBe("continue");
		input.costs!.actions.fresh = actionCost();
		input.workRevision = "work-2";
		expect(chooseContinuationAction(input).kind).toBe("continue");
		delete input.costs;
		expect(chooseContinuationAction(input).kind).toBe("continue");
	});

	it("selects permitted compaction without granting a cheaper unapproved destination", () => {
		const input = actionInput();
		input.fresh = checkContinuationDestination(boundPolicy(), destination({ account: "unapproved" }), observation());
		input.costs!.actions.compact = actionCost({ maintenance: 10 });
		input.costs!.actions.fresh = actionCost();
		expect(chooseContinuationAction(input).kind).toBe("compact");
		input.compactionAllowed = false;
		expect(chooseContinuationAction(input).kind).toBe("continue");
	});

	it("hands off an exhausted source without requiring missing cost evidence", () => {
		const input = actionInput();
		input.admission = {
			kind: "handoff-required",
			reason: "quota exhausted",
			provider: "anthropic",
			account: "source",
		};
		delete input.costs;
		expect(chooseContinuationAction(input).kind).toBe("fresh");
		input.fresh = checkContinuationDestination(boundPolicy(), destination({ account: "unapproved" }), observation());
		expect(chooseContinuationAction(input).kind).toBe("stop");
	});

	it("never overrides manual pause or unsettled effects with a cheaper candidate", () => {
		const input = actionInput();
		input.costs!.actions.fresh = actionCost();
		input.admission = { kind: "stop", attention: false, reason: "operator pause" };
		expect(chooseContinuationAction(input)).toEqual(input.admission);
		input.admission = {
			kind: "handoff-required",
			reason: "quota exhausted",
			provider: "anthropic",
			account: "source",
		};
		input.effectsSettled = false;
		expect(chooseContinuationAction(input).kind).toBe("defer");
	});
});
