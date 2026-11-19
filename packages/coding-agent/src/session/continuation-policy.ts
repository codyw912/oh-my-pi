/**
 * Explicit, serializable destination policy for continuation handoff.
 * Check and select are pure: they never issue a request, fetch telemetry,
 * mutate settings, or treat registry presence as authorization.
 */
import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Effort, ServiceTier, ServiceTierFamily } from "@oh-my-pi/pi-ai";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { isServiceTierFamily, isServiceTierForFamily } from "../config/service-tier";
import type { AdmissionOutcome } from "./continuation-binding";

export const CONTINUATION_POLICY_VERSION = 1 as const;

export const CONTINUATION_ROLES = ["primary", "advisor", "worker", "maintenance"] as const;
export type ContinuationRole = (typeof CONTINUATION_ROLES)[number];

export const CONTINUATION_MODALITIES = ["text", "image"] as const;
export type ContinuationModality = (typeof CONTINUATION_MODALITIES)[number];

export const CONTINUATION_HEADROOM_STATES = ["healthy", "exhausted", "unknown"] as const;
export type ContinuationHeadroomState = (typeof CONTINUATION_HEADROOM_STATES)[number];

const SERVICE_TIERS: readonly ServiceTier[] = ["auto", "default", "flex", "scale", "priority"];

export type ContinuationRejectionCode =
	| "policy-revision-mismatch"
	| "destination-not-approved"
	| "role-unauthorized"
	| "provider-unauthorized"
	| "account-unauthorized"
	| "model-unauthorized"
	| "endpoint-unauthorized"
	| "data-scope-unauthorized"
	| "settings-unsupported"
	| "tools-unsupported"
	| "modality-unsupported"
	| "context-exceeded"
	| "account-restricted"
	| "headroom-unknown"
	| "headroom-exhausted"
	| "attempt-budget-exhausted"
	| "unknown-headroom-budget-exhausted"
	| "candidate-already-rejected";

export type ContinuationPolicyErrorCode = "invalid-policy" | "unsupported-version";

export class ContinuationPolicyError extends Error {
	readonly code: ContinuationPolicyErrorCode;

	constructor(code: ContinuationPolicyErrorCode, message: string) {
		super(message);
		this.name = "ContinuationPolicyError";
		this.code = code;
	}
}

/** Approved reasoning/service settings. Absent fields are not authorized. */
export interface ContinuationDestinationSettings {
	thinkingLevel?: ResolvedThinkingLevel;
	serviceTier?: ServiceTier;
	maxTokens?: number;
	temperature?: number;
}

/**
 * Exact approved inference destination. Identity is provider/account/model
 * plus optional endpoint; model aliases are not an alternate identity.
 */
export interface ContinuationDestination {
	provider: string;
	account: string;
	model: string;
	endpoint?: string;
	roles: ContinuationRole[];
	settings: ContinuationDestinationSettings;
	dataScope: string;
}

/** Provider/account/window that is not independent allowance. */
export interface ContinuationAccountRestriction {
	provider: string;
	account: string;
	window: string;
}

/**
 * Unknown telemetry is not healthy. Only this explicit bound may permit a
 * first useful request without measured headroom.
 */
export interface ContinuationUnknownHeadroomPolicy {
	allowFirstUsefulRequest: boolean;
	maxFirstUsefulRequests: number;
}

export interface ContinuationPolicyV1 {
	version: 1;
	revision: string;
	candidates: ContinuationDestination[];
	roles: ContinuationRole[];
	dataScope: string;
	unknownHeadroom: ContinuationUnknownHeadroomPolicy;
	attemptBudget: number;
	restrictedAccounts: ContinuationAccountRestriction[];
}

/** Resolved capabilities supplied by Main; not catalog authorization. */
export interface ContinuationModelCapabilities {
	provider: string;
	id: string;
	account: string;
	endpoint?: string;
	/** `false` is unsupported; `true` and `undefined` may use tools. */
	supportsTools?: boolean;
	input: readonly ContinuationModality[];
	contextWindow: number | null;
	reasoning: boolean;
	supportedEfforts: readonly Effort[];
	serviceTierFamily?: ServiceTierFamily;
}

export interface ContinuationRequiredCapabilities {
	tools: boolean;
	modalities: readonly ContinuationModality[];
	/** Complete required context, including system/tool overhead. */
	contextTokens: number;
	settings: ContinuationDestinationSettings;
	dataScope: string;
}

export interface ContinuationAllowanceObservation {
	provider: string;
	account: string;
	window: string;
	headroom: ContinuationHeadroomState;
}

export interface ContinuationDestinationObservation {
	policyRevision: string;
	role: ContinuationRole;
	model: ContinuationModelCapabilities;
	required: ContinuationRequiredCapabilities;
	allowances: readonly ContinuationAllowanceObservation[];
	attemptsUsed: number;
	unknownHeadroomRequestsUsed: number;
	rejectedKeys: readonly string[];
}

export interface ContinuationDestinationSelectionInput {
	policyRevision: string;
	role: ContinuationRole;
	required: ContinuationRequiredCapabilities;
	allowances: readonly ContinuationAllowanceObservation[];
	models: readonly ContinuationModelCapabilities[];
	attemptsUsed: number;
	unknownHeadroomRequestsUsed: number;
	rejectedKeys: readonly string[];
}

export interface ContinuationRejection {
	code: ContinuationRejectionCode;
	reason: string;
	destination?: ContinuationDestination;
}

export type ContinuationDestinationDecision =
	| {
			eligible: true;
			destination: ContinuationDestination;
			unknownHeadroomAllowed: boolean;
	  }
	| {
			eligible: false;
			rejection: ContinuationRejection;
	  };

export interface ContinuationDestinationSelection {
	destination: ContinuationDestination | null;
	unknownHeadroomAllowed: boolean;
	rejected: ContinuationRejection[];
}

export function continuationDestinationKey(
	destination: Pick<ContinuationDestination, "provider" | "account" | "model" | "endpoint">,
): string {
	return [destination.provider, destination.account, destination.model, destination.endpoint ?? ""].join("\u001f");
}

export function validateContinuationPolicy(value: unknown): ContinuationPolicyV1 {
	const record = requireObject(value, "policy");
	if (record.version !== CONTINUATION_POLICY_VERSION) {
		throw new ContinuationPolicyError(
			"unsupported-version",
			`ContinuationPolicy version ${String(record.version)} is not supported`,
		);
	}
	const revision = requireNonemptyString(record.revision, "revision");
	const dataScope = requireNonemptyString(record.dataScope, "dataScope");
	const roles = requireRoleList(record.roles, "roles");
	const attemptBudget = requireNonnegativeInteger(record.attemptBudget, "attemptBudget");
	const unknownHeadroom = parseUnknownHeadroom(record.unknownHeadroom);
	const restrictedAccounts = requireArray(record.restrictedAccounts, "restrictedAccounts").map((item, index) =>
		parseAccountRestriction(item, `restrictedAccounts[${index}]`),
	);
	const candidates = requireArray(record.candidates, "candidates").map((item, index) =>
		parseDestination(item, `candidates[${index}]`),
	);
	const seen = new Set<string>();
	for (const candidate of candidates) {
		const key = continuationDestinationKey(candidate);
		if (seen.has(key)) {
			throw new ContinuationPolicyError(
				"invalid-policy",
				`Duplicate destination ${candidate.provider}/${candidate.account}/${candidate.model}`,
			);
		}
		seen.add(key);
		if (candidate.dataScope !== dataScope) {
			throw new ContinuationPolicyError(
				"invalid-policy",
				`Destination ${candidate.provider}/${candidate.model} data scope is not the policy data scope`,
			);
		}
		for (const role of candidate.roles) {
			if (!roles.includes(role)) {
				throw new ContinuationPolicyError(
					"invalid-policy",
					`Destination ${candidate.provider}/${candidate.model} role ${role} is not authorized on the policy`,
				);
			}
		}
	}
	return {
		version: 1,
		revision,
		candidates,
		roles,
		dataScope,
		unknownHeadroom,
		attemptBudget,
		restrictedAccounts,
	};
}

export function checkContinuationDestination(
	policy: ContinuationPolicyV1,
	destination: ContinuationDestination,
	observation: ContinuationDestinationObservation,
): ContinuationDestinationDecision {
	const rejection = eligibilityRejection(policy, destination, observation);
	if (rejection) return { eligible: false, rejection };
	return {
		eligible: true,
		destination,
		unknownHeadroomAllowed:
			accountHeadroom(destination, observation.allowances) === "unknown" &&
			policy.unknownHeadroom.allowFirstUsefulRequest,
	};
}

export function selectContinuationDestination(
	policy: ContinuationPolicyV1,
	input: ContinuationDestinationSelectionInput,
): ContinuationDestinationSelection {
	const rejected: ContinuationRejection[] = [];
	if (input.policyRevision !== policy.revision) {
		rejected.push({
			code: "policy-revision-mismatch",
			reason: `Policy revision ${input.policyRevision} does not match bound revision ${policy.revision}`,
		});
		return { destination: null, unknownHeadroomAllowed: false, rejected };
	}
	if (input.attemptsUsed >= policy.attemptBudget) {
		rejected.push({
			code: "attempt-budget-exhausted",
			reason: `Attempt budget ${policy.attemptBudget} is exhausted`,
		});
		return { destination: null, unknownHeadroomAllowed: false, rejected };
	}

	for (const destination of policy.candidates) {
		const model = input.models.find(
			candidate =>
				candidate.provider === destination.provider &&
				candidate.id === destination.model &&
				candidate.account === destination.account &&
				(candidate.endpoint ?? "") === (destination.endpoint ?? ""),
		);
		if (!model) {
			rejected.push({
				code: "model-unauthorized",
				reason: `No resolved capabilities were supplied for ${destination.provider}/${destination.account}/${destination.model}`,
				destination,
			});
			continue;
		}
		const decision = checkContinuationDestination(policy, destination, {
			policyRevision: input.policyRevision,
			role: input.role,
			model,
			required: input.required,
			allowances: input.allowances,
			attemptsUsed: input.attemptsUsed,
			unknownHeadroomRequestsUsed: input.unknownHeadroomRequestsUsed,
			rejectedKeys: input.rejectedKeys,
		});
		if (!decision.eligible) {
			rejected.push(decision.rejection);
			continue;
		}
		return {
			destination,
			unknownHeadroomAllowed: decision.unknownHeadroomAllowed,
			rejected,
		};
	}

	return { destination: null, unknownHeadroomAllowed: false, rejected };
}

function eligibilityRejection(
	policy: ContinuationPolicyV1,
	destination: ContinuationDestination,
	observation: ContinuationDestinationObservation,
): ContinuationRejection | undefined {
	if (observation.policyRevision !== policy.revision) {
		return reject(
			"policy-revision-mismatch",
			`Policy revision ${observation.policyRevision} does not match bound revision ${policy.revision}`,
			destination,
		);
	}
	if (observation.attemptsUsed >= policy.attemptBudget) {
		return reject("attempt-budget-exhausted", `Attempt budget ${policy.attemptBudget} is exhausted`, destination);
	}
	if (observation.rejectedKeys.includes(continuationDestinationKey(destination))) {
		return reject(
			"candidate-already-rejected",
			`Destination ${destination.provider}/${destination.account}/${destination.model} was already rejected in this evaluation`,
			destination,
		);
	}
	if (!policy.candidates.some(candidate => destinationsEqual(candidate, destination))) {
		return reject(
			"destination-not-approved",
			`Destination ${destination.provider}/${destination.account}/${destination.model} is not an approved candidate`,
			destination,
		);
	}
	if (!isContinuationRole(observation.role) || !policy.roles.includes(observation.role)) {
		return reject("role-unauthorized", `Role ${observation.role} is not authorized by this policy`, destination);
	}
	if (!destination.roles.includes(observation.role)) {
		return reject(
			"role-unauthorized",
			`Role ${observation.role} is not authorized on ${destination.provider}/${destination.model}`,
			destination,
		);
	}
	if (observation.model.provider !== destination.provider) {
		return reject(
			"provider-unauthorized",
			`Resolved provider ${observation.model.provider} is not ${destination.provider}`,
			destination,
		);
	}
	if (observation.model.account !== destination.account) {
		return reject(
			"account-unauthorized",
			`Resolved account ${observation.model.account} is not ${destination.account}`,
			destination,
		);
	}
	if (observation.model.id !== destination.model) {
		return reject(
			"model-unauthorized",
			`Resolved model ${observation.model.id} is not approved model ${destination.model}`,
			destination,
		);
	}
	if ((destination.endpoint ?? "") !== (observation.model.endpoint ?? "")) {
		return reject(
			"endpoint-unauthorized",
			`Resolved endpoint ${observation.model.endpoint ?? "(default)"} is not approved endpoint ${destination.endpoint ?? "(default)"}`,
			destination,
		);
	}
	if (destination.dataScope !== policy.dataScope || observation.required.dataScope !== destination.dataScope) {
		return reject(
			"data-scope-unauthorized",
			`Required data scope ${observation.required.dataScope} is not authorized for ${destination.dataScope}`,
			destination,
		);
	}

	const rejectedSettings = settingsRejection(destination, observation);
	if (rejectedSettings) return rejectedSettings;

	if (observation.required.tools && observation.model.supportsTools === false) {
		return reject(
			"tools-unsupported",
			`Destination ${destination.provider}/${destination.model} does not support required tools`,
			destination,
		);
	}
	for (const modality of observation.required.modalities) {
		if (!isContinuationModality(modality) || !observation.model.input.includes(modality)) {
			return reject(
				"modality-unsupported",
				`Destination ${destination.provider}/${destination.model} does not support required modality ${modality}`,
				destination,
			);
		}
	}
	if (
		!Number.isSafeInteger(observation.required.contextTokens) ||
		observation.required.contextTokens < 0 ||
		observation.model.contextWindow === null ||
		!Number.isFinite(observation.model.contextWindow) ||
		observation.model.contextWindow < observation.required.contextTokens
	) {
		return reject(
			"context-exceeded",
			`Required context ${observation.required.contextTokens} including overhead does not fit destination window ${String(observation.model.contextWindow)}`,
			destination,
		);
	}

	if (isAccountRestricted(policy, destination)) {
		return reject(
			"account-restricted",
			`Provider/account ${destination.provider}/${destination.account} shares a restricted window`,
			destination,
		);
	}

	const headroom = accountHeadroom(destination, observation.allowances);
	if (headroom === "exhausted") {
		return reject(
			"headroom-exhausted",
			`Provider/account ${destination.provider}/${destination.account} has no remaining allowance`,
			destination,
		);
	}
	if (headroom === "unknown") {
		if (!policy.unknownHeadroom.allowFirstUsefulRequest) {
			return reject(
				"headroom-unknown",
				`Unknown headroom for ${destination.provider}/${destination.account} is not authorized`,
				destination,
			);
		}
		if (observation.unknownHeadroomRequestsUsed >= policy.unknownHeadroom.maxFirstUsefulRequests) {
			return reject(
				"unknown-headroom-budget-exhausted",
				`Unknown-headroom first-useful-request budget ${policy.unknownHeadroom.maxFirstUsefulRequests} is exhausted`,
				destination,
			);
		}
	}
	return undefined;
}

function settingsRejection(
	destination: ContinuationDestination,
	observation: ContinuationDestinationObservation,
): ContinuationRejection | undefined {
	const required = observation.required.settings;
	const approved = destination.settings;
	if (!settingsAuthorized(approved, required)) {
		return reject(
			"settings-unsupported",
			`Required settings are not exactly authorized on ${destination.provider}/${destination.model}`,
			destination,
		);
	}
	if (required.thinkingLevel !== undefined && required.thinkingLevel !== "off") {
		const effort = THINKING_EFFORTS.find(candidate => candidate === required.thinkingLevel);
		if (
			effort === undefined ||
			!observation.model.reasoning ||
			!observation.model.supportedEfforts.includes(effort)
		) {
			return reject(
				"settings-unsupported",
				`Thinking level ${required.thinkingLevel} is not supported by ${destination.provider}/${destination.model}`,
				destination,
			);
		}
	}
	if (required.serviceTier !== undefined) {
		const family = observation.model.serviceTierFamily;
		if (!family || !isServiceTierFamily(family) || !isServiceTierForFamily(family, required.serviceTier)) {
			return reject(
				"settings-unsupported",
				`Service tier ${required.serviceTier} is not supported by ${destination.provider}/${destination.model}`,
				destination,
			);
		}
	}
	return undefined;
}

function settingsAuthorized(
	approved: ContinuationDestinationSettings,
	required: ContinuationDestinationSettings,
): boolean {
	return (
		required.thinkingLevel === approved.thinkingLevel &&
		required.serviceTier === approved.serviceTier &&
		required.maxTokens === approved.maxTokens &&
		required.temperature === approved.temperature
	);
}

function isAccountRestricted(policy: ContinuationPolicyV1, destination: ContinuationDestination): boolean {
	return policy.restrictedAccounts.some(
		restriction => restriction.provider === destination.provider && restriction.account === destination.account,
	);
}

function accountHeadroom(
	destination: ContinuationDestination,
	allowances: readonly ContinuationAllowanceObservation[],
): ContinuationHeadroomState {
	const matched = allowances.filter(
		allowance => allowance.provider === destination.provider && allowance.account === destination.account,
	);
	if (matched.length === 0) return "unknown";
	if (matched.some(allowance => allowance.headroom === "exhausted")) return "exhausted";
	if (matched.some(allowance => allowance.headroom === "unknown")) return "unknown";
	if (matched.every(allowance => allowance.headroom === "healthy")) return "healthy";
	return "unknown";
}

function destinationsEqual(a: ContinuationDestination, b: ContinuationDestination): boolean {
	return (
		continuationDestinationKey(a) === continuationDestinationKey(b) &&
		a.dataScope === b.dataScope &&
		a.roles.length === b.roles.length &&
		a.roles.every((role, index) => role === b.roles[index]) &&
		a.settings.thinkingLevel === b.settings.thinkingLevel &&
		a.settings.serviceTier === b.settings.serviceTier &&
		a.settings.maxTokens === b.settings.maxTokens &&
		a.settings.temperature === b.settings.temperature
	);
}

function reject(
	code: ContinuationRejectionCode,
	reason: string,
	destination: ContinuationDestination,
): ContinuationRejection {
	return { code, reason, destination };
}

function parseDestination(value: unknown, label: string): ContinuationDestination {
	const record = requireObject(value, label);
	const destination: ContinuationDestination = {
		provider: requireNonemptyString(record.provider, `${label}.provider`),
		account: requireNonemptyString(record.account, `${label}.account`),
		model: requireNonemptyString(record.model, `${label}.model`),
		roles: requireRoleList(record.roles, `${label}.roles`),
		settings: parseSettings(record.settings, `${label}.settings`),
		dataScope: requireNonemptyString(record.dataScope, `${label}.dataScope`),
	};
	if (record.endpoint !== undefined) {
		destination.endpoint = requireNonemptyString(record.endpoint, `${label}.endpoint`);
	}
	return destination;
}

function parseSettings(value: unknown, label: string): ContinuationDestinationSettings {
	const record = requireObject(value, label);
	for (const key of Object.keys(record)) {
		if (!["thinkingLevel", "serviceTier", "maxTokens", "temperature"].includes(key)) {
			throw new ContinuationPolicyError("invalid-policy", `${label}.${key} is not a supported approved setting`);
		}
	}
	const settings: ContinuationDestinationSettings = {};
	if (record.thinkingLevel !== undefined) {
		settings.thinkingLevel = requireThinkingLevel(record.thinkingLevel, `${label}.thinkingLevel`);
	}
	if (record.serviceTier !== undefined) {
		settings.serviceTier = requireServiceTier(record.serviceTier, `${label}.serviceTier`);
	}
	if (record.maxTokens !== undefined) {
		settings.maxTokens = requireNonnegativeInteger(record.maxTokens, `${label}.maxTokens`);
		if (settings.maxTokens < 1)
			throw new ContinuationPolicyError("invalid-policy", `${label}.maxTokens must be positive`);
	}
	if (record.temperature !== undefined) {
		if (
			typeof record.temperature !== "number" ||
			!Number.isFinite(record.temperature) ||
			record.temperature < 0 ||
			record.temperature > 2
		) {
			throw new ContinuationPolicyError("invalid-policy", `${label}.temperature must be between zero and two`);
		}
		settings.temperature = record.temperature;
	}
	return settings;
}

function parseUnknownHeadroom(value: unknown): ContinuationUnknownHeadroomPolicy {
	const record = requireObject(value, "unknownHeadroom");
	if (typeof record.allowFirstUsefulRequest !== "boolean") {
		throw new ContinuationPolicyError("invalid-policy", "unknownHeadroom.allowFirstUsefulRequest must be a boolean");
	}
	const maxFirstUsefulRequests = requireNonnegativeInteger(
		record.maxFirstUsefulRequests,
		"unknownHeadroom.maxFirstUsefulRequests",
	);
	if (record.allowFirstUsefulRequest && maxFirstUsefulRequests < 1) {
		throw new ContinuationPolicyError(
			"invalid-policy",
			"unknownHeadroom.maxFirstUsefulRequests must be >= 1 when first useful requests are allowed",
		);
	}
	return {
		allowFirstUsefulRequest: record.allowFirstUsefulRequest,
		maxFirstUsefulRequests,
	};
}

function parseAccountRestriction(value: unknown, label: string): ContinuationAccountRestriction {
	const record = requireObject(value, label);
	return {
		provider: requireNonemptyString(record.provider, `${label}.provider`),
		account: requireNonemptyString(record.account, `${label}.account`),
		window: requireNonemptyString(record.window, `${label}.window`),
	};
}

function requireThinkingLevel(value: unknown, label: string): ResolvedThinkingLevel {
	if (value === "off") return "off";
	const effort = THINKING_EFFORTS.find(candidate => candidate === value);
	if (effort === undefined) {
		throw new ContinuationPolicyError("invalid-policy", `${label} must be an explicit supported thinking level`);
	}
	return effort;
}

function requireServiceTier(value: unknown, label: string): ServiceTier {
	const tier = SERVICE_TIERS.find(candidate => candidate === value);
	if (tier === undefined) {
		throw new ContinuationPolicyError("invalid-policy", `${label} must be an explicit service tier`);
	}
	return tier;
}

function requireRoleList(value: unknown, label: string): ContinuationRole[] {
	const roles = requireArray(value, label).map((item, index) => {
		if (!isContinuationRole(item)) {
			throw new ContinuationPolicyError("invalid-policy", `${label}[${index}] is not a supported continuation role`);
		}
		return item;
	});
	if (roles.length === 0) {
		throw new ContinuationPolicyError("invalid-policy", `${label} must not be empty`);
	}
	const seen = new Set<ContinuationRole>();
	for (const role of roles) {
		if (seen.has(role)) {
			throw new ContinuationPolicyError("invalid-policy", `${label} must not contain duplicate roles`);
		}
		seen.add(role);
	}
	return roles;
}

function isContinuationRole(value: unknown): value is ContinuationRole {
	return typeof value === "string" && (CONTINUATION_ROLES as readonly string[]).includes(value);
}

function isContinuationModality(value: unknown): value is ContinuationModality {
	return typeof value === "string" && (CONTINUATION_MODALITIES as readonly string[]).includes(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ContinuationPolicyError("invalid-policy", `${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new ContinuationPolicyError("invalid-policy", `${label} must be an array`);
	}
	return value;
}

function requireNonemptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ContinuationPolicyError("invalid-policy", `${label} must be a nonempty string`);
	}
	return value;
}

function requireNonnegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new ContinuationPolicyError("invalid-policy", `${label} must be a nonnegative integer`);
	}
	return value;
}

export type ContinuationAction = "continue" | "compact" | "fresh";

/** All components use the evidence's stated unit; no token-to-quota conversion. */
export interface ContinuationActionCost {
	maintenance: number | null;
	transfer: number | null;
	cacheRead: number | null;
	cachePopulation: number | null;
	reconstruction: number | null;
	advisorRepriming: number | null;
	remainingWork: number | null;
}

export interface ContinuationCostEvidence {
	workRevision: string;
	unit: "usd" | "milliseconds" | "bytes";
	/** Scripted measurements certify arbitration, not savings or model quality. */
	kind: "scripted-control" | "calibrated";
	actions: Partial<Record<ContinuationAction, ContinuationActionCost>>;
}

export interface ContinuationActionInput {
	admission: AdmissionOutcome;
	effectsSettled: boolean;
	/** Result of the existing destination authorization/capability check. */
	fresh?: ContinuationDestinationDecision;
	compactionAllowed: boolean;
	workRevision: string;
	costs?: ContinuationCostEvidence;
}

export type ContinuationActionDecision =
	| Extract<AdmissionOutcome, { kind: "defer" | "stop" }>
	| {
			kind: ContinuationAction;
			reason: "availability" | "missing-or-stale-costs" | "lowest-total-cost";
			destination?: ContinuationDestination;
			totals?: Partial<Record<ContinuationAction, number>>;
			unit?: ContinuationCostEvidence["unit"];
			evidenceKind?: ContinuationCostEvidence["kind"];
	  };

/**
 * Read-only arbitration after mandatory admission. A recommendation is not
 * execution authority: handoff/compaction must still pass their live fences.
 * Automatic economic rotation remains disabled pending approved Gate C evidence.
 */
export function chooseContinuationAction(input: ContinuationActionInput): ContinuationActionDecision {
	const { admission, fresh } = input;
	if (admission.kind === "stop" || admission.kind === "defer") return admission;
	if (!input.effectsSettled) return { kind: "defer", reason: "Continuation maintenance requires settled effects" };
	if (admission.kind === "handoff-required") {
		return fresh?.eligible
			? { kind: "fresh", reason: "availability", destination: fresh.destination }
			: { kind: "stop", attention: true, reason: "No approved usable continuation destination" };
	}

	const costs = input.costs;
	if (!costs || !input.workRevision || costs.workRevision !== input.workRevision) {
		return { kind: "continue", reason: "missing-or-stale-costs" };
	}
	const candidates: ContinuationAction[] = ["continue"];
	if (input.compactionAllowed) candidates.push("compact");
	if (fresh?.eligible) candidates.push("fresh");
	const totals: Partial<Record<ContinuationAction, number>> = {};
	for (const action of candidates) {
		const total = totalContinuationActionCost(costs.actions[action]);
		if (total === null) return { kind: "continue", reason: "missing-or-stale-costs" };
		totals[action] = total;
	}
	let chosen: ContinuationAction = "continue";
	for (const action of candidates) {
		if (totals[action]! < totals[chosen]!) chosen = action;
	}
	return {
		kind: chosen,
		reason: "lowest-total-cost",
		...(chosen === "fresh" && fresh?.eligible ? { destination: fresh.destination } : {}),
		totals,
		unit: costs.unit,
		evidenceKind: costs.kind,
	};
}

function totalContinuationActionCost(cost: ContinuationActionCost | undefined): number | null {
	if (!cost) return null;
	let total = 0;
	for (const value of [
		cost.maintenance,
		cost.transfer,
		cost.cacheRead,
		cost.cachePopulation,
		cost.reconstruction,
		cost.advisorRepriming,
		cost.remainingWork,
	]) {
		if (value === null || !Number.isFinite(value) || value < 0) return null;
		total += value;
	}
	return Number.isFinite(total) ? total : null;
}
