/**
 * Provider-free continuation trial evaluator.
 *
 * Consumes independent fixture observations and usage-shaped session
 * measurements supplied by the caller. It does not issue requests, fetch
 * telemetry, register runtime hooks, or write report artifacts. Semantic
 * quality and economic savings are out of scope: those remain Gate C.
 *
 * A continuity pass is scripted-control evidence only. It is not a quality
 * or savings result. Missing or unsupported captures yield `incomplete`;
 * independently observed failures yield `reject`.
 *
 * Do not import this module from continuation-policy.ts, or the reverse.
 */

export const CONTINUATION_EVALUATION_VERSION = 1 as const;

/**
 * Proposed Gate C comparison parameters. Approval must bind the exact model
 * revisions and temporary accounts before execution; this object authorizes nothing.
 */
export const CONTINUATION_GATE_C_COMPARISON_SPEC = {
	status: "not-authorized",
	requiresSeparateApproval: true,
	baselines: ["ordinary-continuation", "focused-fresh-handoff", "compatible-full-history-fallback"],
	workloads: ["sdd-pending-review", "unfinished-investigation", "long-wait-cache-reusable"],
	cacheConditions: {
		retentionSettings: "unchanged",
		source: "same recorded work snapshot and observed cache state for matched baselines",
		destination: "fresh provider session; record actual cache usage rather than assuming cold",
		missingCacheTelemetry: "exclude from cache-specific conclusions, retain in overall report",
	},
	repetitions: 3,
	qualityNonInferiority: {
		safetyViolations: 0,
		lostOrContradictedProtectedFacts: 0,
		replayedCompletedWork: 0,
		missedRequiredReviews: 0,
		workAcceptance: "all fixed workload checks pass",
		scoring: "blind human review; no unbudgeted model judge",
	},
	worthwhileImprovement: {
		minimumMedianFirstUsefulActionImprovementPercent: 15,
		maximumTotalBilledCostIncreasePercent: 0,
		requireQualityNonInferiority: true,
		availabilitySuccess: "reported separately; not an economic win",
	},
	budgets: {
		matchedRuns: 81,
		maxCallsIncludingWarmupAndFailedAttempts: 405,
		maxBilledUsd: 50,
		maxInputTokensPerCall: 16_384,
		maxOutputTokensPerCall: 2_048,
		maxWallClockMinutes: 120,
		stop: "first safety violation, provider allowance refusal, or any exhausted budget",
	},
	budgetLimitedRuns: "report-incomplete-do-not-exclude",
	allowanceAttribution: "unknown-when-missing-or-incomparable",
	tokenReductionAlone: "does-not-pass",
	candidateModels: [
		{ provider: "openai", model: "gpt-5.5" },
		{ provider: "google", model: "gemini-3.1-pro-preview" },
		{ provider: "xai", model: "grok-4.6" },
	],
	sourceDestinationPairs: [
		{ source: "openai/gpt-5.5", destination: "google/gemini-3.1-pro-preview" },
		{ source: "google/gemini-3.1-pro-preview", destination: "xai/grok-4.6" },
		{ source: "xai/grok-4.6", destination: "openai/gpt-5.5" },
	],
	additionalProviderFreeCertification: ["google-generative-ai"],
	ranking: "proposed frontier shortlist from the pinned catalog, not a measured ranking",
	anthropic: "excluded; no Anthropic inference is proposed or authorized",
} as const;

export type ContinuationEvaluationErrorCode = "invalid-input" | "unsupported-version";

export class ContinuationEvaluationError extends Error {
	readonly code: ContinuationEvaluationErrorCode;
	readonly details: Record<string, unknown> | undefined;

	constructor(code: ContinuationEvaluationErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ContinuationEvaluationError";
		this.code = code;
		this.details = details;
	}
}

/**
 * Usage-shaped measurements accepted from `SessionStats.tokens` or catalog `Usage`.
 * `total` (session stats) and `totalTokens` (Usage) are both recognized.
 * `reasoning` / `reasoningTokens` stay unknown when omitted; they are never coerced to 0.
 * Dollar `cost` is ignored so token/cache accounting cannot be presented as savings.
 */
export interface ContinuationUsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	total?: number;
	reasoning?: number;
	reasoningTokens?: number;
}

export interface ContinuationTokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	/** Unknown when the capture omitted reasoning; not a zero fill. */
	reasoningTokens: number | null;
}

export type ContinuationKnowledgeKind = "constraint" | "finding" | "decision" | "rejected-approach" | "next-action";

/** Independently observed artifact/fact. Model self-assurance is not this type. */
export interface ContinuationKnowledgeObservation {
	id: string;
	kind: ContinuationKnowledgeKind;
	/** Exact recorded evidence (fingerprint, marker, or verbatim protected text). */
	evidence: string;
}

export type ContinuationOperationKind =
	| "completed-task"
	| "investigation"
	| "implementation"
	| "verification"
	| "review";

/** Independently observed operation/effect, not a model's claim that work succeeded. */
export interface ContinuationOperationObservation {
	id: string;
	kind: ContinuationOperationKind;
}

export type ContinuationObligationKind = "review" | "landing" | "verification" | "escalation";

export interface ContinuationObligationObservation {
	id: string;
	kind: ContinuationObligationKind;
}

export type ContinuationAttemptKind = "source" | "destination";

export type ContinuationAttemptOutcome = "succeeded" | "failed" | "rejected" | "budget-limited" | "not-started";

/**
 * One source or destination attempt. Failed and budget-limited attempts stay
 * in the report; omitting them would hide transfer cost.
 */
export interface ContinuationAttemptObservation {
	id: string;
	kind: ContinuationAttemptKind;
	outcome: ContinuationAttemptOutcome;
	sessionId?: string;
	provider?: string;
	account?: string;
	model?: string;
	/** Observed session role string; not destination-policy authorization. */
	sessionRole?: "primary" | "advisor" | "worker" | "maintenance";
	reason?: string;
	usage?: ContinuationUsageLike;
	requestCount?: number;
	briefingTokens?: number;
	contextLoadedTokens?: number;
	rePrimingRequests?: number;
	/** Independently observed useful destination work, epoch ms. */
	firstUsefulActionAtMs?: number;
	briefingBytes?: number;
	contextLoadedBytes?: number;
	transferOverheadBytes?: number;
	reconstructionOverheadBytes?: number;
}

/**
 * One provider/account/window sample. Keep rows separate. Missing or
 * cross-window/account/provider/epoch samples cannot be added into a quota percent.
 */
export interface ContinuationAllowanceObservation {
	provider: string;
	account: string;
	windowId: string;
	epochId?: string;
	used?: number;
	limit?: number;
	unit?: string;
	observedAtMs?: number;
	competingConsumers?: string[];
	sampleAgeMs?: number;
}

export interface ContinuationTrialLineage {
	runId: string;
	sourceSessionId: string;
	successorSessionIds: string[];
}

export type ContinuationCaptureStatus = "captured" | "missing" | "unsupported";

/**
 * Caller-declared collection coverage. Empty observation arrays are not
 * evidence that a dimension was inspected unless that dimension is `captured`.
 */
export interface ContinuationObservationCapture {
	knowledge: ContinuationCaptureStatus;
	operations: ContinuationCaptureStatus;
	obligations: ContinuationCaptureStatus;
	attempts: ContinuationCaptureStatus;
	successors: ContinuationCaptureStatus;
	costs: ContinuationCaptureStatus;
	allowance: ContinuationCaptureStatus;
}

/** This evaluator only accepts scripted-control measurements. */
export type ContinuationMeasurementScope = "scripted-control";

export interface ContinuationTrialInput {
	version: typeof CONTINUATION_EVALUATION_VERSION;
	trialId: string;
	lineage: ContinuationTrialLineage;
	/** Declared collection coverage for each observation dimension. */
	capture: ContinuationObservationCapture;
	/** Scripted fixtures only; never a provider-quality or savings claim. */
	measurementScope: ContinuationMeasurementScope;
	/** Protected facts that destination observations must preserve exactly. */
	requiredKnowledge: ContinuationKnowledgeObservation[];
	/** Destination-side independent observations of those facts. */
	observedKnowledge: ContinuationKnowledgeObservation[];
	/** Source-completed operations that destination work must not replay. */
	completedOperations: ContinuationOperationObservation[];
	/** Destination-side independent operation observations. */
	observedOperations: ContinuationOperationObservation[];
	requiredObligations: ContinuationObligationObservation[];
	observedObligations: ContinuationObligationObservation[];
	/**
	 * Optional allow-list of destination operation ids whose independently
	 * observed `kind` is `"verification"`. Constrains which verifications are
	 * counted; never rewrites a non-verification observation.
	 */
	expectedVerifications?: ContinuationOperationObservation[];
	attempts: ContinuationAttemptObservation[];
	allowanceObservations?: ContinuationAllowanceObservation[];
	sourceExhaustedAtMs?: number;
	sourceRolloverAtMs?: number;
}

export type ContinuationFindingKind =
	| "preserved-knowledge"
	| "lost-knowledge"
	| "contradicted-knowledge"
	| "replayed-completed-operation"
	| "missed-obligation"
	| "targeted-verification";

export interface ContinuationContinuityFinding {
	kind: ContinuationFindingKind;
	id: string;
	reason: string;
}

export type ContinuationTrialVerdict =
	| { result: "pass"; reasons: string[] }
	| { result: "reject"; reasons: string[] }
	| { result: "incomplete"; reasons: string[] };

export interface ContinuationAttemptCost {
	attemptId: string;
	kind: ContinuationAttemptKind;
	outcome: ContinuationAttemptOutcome;
	sessionId: string | null;
	provider: string | null;
	account: string | null;
	model: string | null;
	sessionRole: "primary" | "advisor" | "worker" | "maintenance" | null;
	reason: string | null;
	usage: ContinuationTokenUsage | null;
	requestCount: number | null;
	briefingTokens: number | null;
	contextLoadedTokens: number | null;
	rePrimingRequests: number | null;
	firstUsefulActionAtMs: number | null;
	coldCache: boolean | null;
	briefingBytes: number | null;
	contextLoadedBytes: number | null;
	transferOverheadBytes: number | null;
	reconstructionOverheadBytes: number | null;
	/** Present streamed usage is scripted/synthetic; omitted usage stays unknown. */
	usageKind: "synthetic" | null;
}

export interface ContinuationCostDimensionComplete {
	usage: boolean;
	requestCount: boolean;
	briefingTokens: boolean;
	contextLoadedTokens: boolean;
	rePrimingRequests: boolean;
	reasoningTokens: boolean;
}

export type ContinuationCostValueKind = "measured" | "synthetic" | "unknown";

/** Provenance of each cost dimension. Missing values are unknown, never a silent zero. */
export interface ContinuationCostDimensionKind {
	usage: ContinuationCostValueKind;
	requestCount: ContinuationCostValueKind;
	briefingTokens: ContinuationCostValueKind;
	briefingBytes: ContinuationCostValueKind;
	contextLoadedTokens: ContinuationCostValueKind;
	contextLoadedBytes: ContinuationCostValueKind;
	rePrimingRequests: ContinuationCostValueKind;
	reasoningTokens: ContinuationCostValueKind;
	transferOverheadBytes: ContinuationCostValueKind;
	reconstructionOverheadBytes: ContinuationCostValueKind;
	firstUsefulActionLatencyMs: ContinuationCostValueKind;
}

export interface ContinuationCostReport {
	attempts: ContinuationAttemptCost[];
	sourceUsage: ContinuationTokenUsage | null;
	sourceRequestCount: number | null;
	destinationUsage: ContinuationTokenUsage | null;
	destinationRequestCount: number | null;
	knownTotals: ContinuationTokenUsage | null;
	knownRequestCount: number | null;
	totalsComplete: boolean;
	dimensionComplete: ContinuationCostDimensionComplete;
	unknownUsageAttemptIds: string[];
	briefingTokens: number | null;
	contextLoadedTokens: number | null;
	rePrimingRequests: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	firstUsefulActionLatencyMs: number | null;
	usefulWorkBeforeSourceRollover: boolean | null;
	/**
	 * Scripted-control streamed usage is synthetic. This labels the regime; omitted
	 * attempt usage remains `null` / `unknownUsageAttemptIds`, never a zero fill.
	 */
	scriptedUsage: "synthetic";
	dimensionKind: ContinuationCostDimensionKind;
	briefingBytes: number | null;
	contextLoadedBytes: number | null;
	transferOverheadBytes: number | null;
	reconstructionOverheadBytes: number | null;
}

export type ContinuationAllowanceAttribution =
	| {
			status: "observed";
			provider: string;
			account: string;
			windowId: string;
			epochId: string | null;
			used: number;
			limit: number;
			unit: string;
			observedAtMs: number;
			competingConsumers: string[] | null;
			sampleAgeMs: number | null;
	  }
	| {
			status: "unknown";
			reason: "missing" | "incomplete-identity" | "incomplete-measurement";
			provider: string | null;
			account: string | null;
			windowId: string | null;
	  };

export interface ContinuationInferenceLimits {
	providerFree: true;
	independentObservationsOnly: true;
	modelSelfAssurance: "ignored";
	semanticQuality: "not-evaluated";
	economicSavings: "not-evaluated";
	quotaPercentage: "not-computed";
	gateC: "not-run";
}

export interface ContinuationEvaluationResult {
	version: typeof CONTINUATION_EVALUATION_VERSION;
	trialId: string;
	lineage: ContinuationTrialLineage;
	verdict: ContinuationTrialVerdict;
	findings: ContinuationContinuityFinding[];
	/** Echo of declared collection coverage; missing data is not treated as observed. */
	coverage: ContinuationObservationCapture;
	/** Scripted-control evidence; a continuity pass is not quality or savings. */
	measurementScope: ContinuationMeasurementScope;
	costs: ContinuationCostReport;
	allowance: ContinuationAllowanceAttribution[];
	inferenceLimits: ContinuationInferenceLimits;
	gateCComparison: typeof CONTINUATION_GATE_C_COMPARISON_SPEC;
}

const INFERENCE_LIMITS: ContinuationInferenceLimits = {
	providerFree: true,
	independentObservationsOnly: true,
	modelSelfAssurance: "ignored",
	semanticQuality: "not-evaluated",
	economicSavings: "not-evaluated",
	quotaPercentage: "not-computed",
	gateC: "not-run",
};

const REJECTING_FINDINGS: Record<ContinuationFindingKind, boolean> = {
	"preserved-knowledge": false,
	"lost-knowledge": true,
	"contradicted-knowledge": true,
	"replayed-completed-operation": true,
	"missed-obligation": true,
	"targeted-verification": false,
};

const CAPTURE_KEYS = [
	"knowledge",
	"operations",
	"obligations",
	"attempts",
	"successors",
	"costs",
	"allowance",
] as const;

const CONTINUITY_CAPTURE_KEYS = [
	"knowledge",
	"operations",
	"obligations",
	"attempts",
	"successors",
] as const satisfies readonly (keyof ContinuationObservationCapture)[];

export function normalizeContinuationUsage(usage: ContinuationUsageLike): ContinuationTokenUsage {
	assertFiniteNumber(usage.input, "usage.input");
	assertFiniteNumber(usage.output, "usage.output");
	assertFiniteNumber(usage.cacheRead, "usage.cacheRead");
	assertFiniteNumber(usage.cacheWrite, "usage.cacheWrite");
	const totalTokens =
		typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)
			? usage.totalTokens
			: typeof usage.total === "number" && Number.isFinite(usage.total)
				? usage.total
				: usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const reasoningTokens =
		typeof usage.reasoningTokens === "number" && Number.isFinite(usage.reasoningTokens)
			? usage.reasoningTokens
			: typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning)
				? usage.reasoning
				: null;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens,
		reasoningTokens,
	};
}

export function evaluateContinuationTrial(input: ContinuationTrialInput): ContinuationEvaluationResult {
	validateInput(input);

	const coverage: ContinuationObservationCapture = { ...input.capture };
	const findings: ContinuationContinuityFinding[] = [];

	if (coverage.knowledge === "captured") {
		const observedKnowledge = indexById(input.observedKnowledge, "observedKnowledge");
		for (const required of input.requiredKnowledge) {
			const observed = observedKnowledge.get(required.id);
			if (!observed) {
				findings.push({
					kind: "lost-knowledge",
					id: required.id,
					reason: `lost-knowledge:${required.kind}:${required.id}`,
				});
				continue;
			}
			if (observed.kind !== required.kind || observed.evidence !== required.evidence) {
				findings.push({
					kind: "contradicted-knowledge",
					id: required.id,
					reason: `contradicted-knowledge:${required.kind}:${required.id}`,
				});
				continue;
			}
			findings.push({
				kind: "preserved-knowledge",
				id: required.id,
				reason: `preserved-knowledge:${required.kind}:${required.id}`,
			});
		}
	}

	const expectedVerificationIds =
		input.expectedVerifications === undefined
			? null
			: new Set(
					input.expectedVerifications.map(item => {
						assertNonEmptyString(item.id, "expectedVerifications.id");
						return item.id;
					}),
				);

	if (coverage.operations === "captured") {
		const observedOperations = indexById(input.observedOperations, "observedOperations");
		for (const completed of input.completedOperations) {
			const observed = observedOperations.get(completed.id);
			if (!observed) continue;
			if (
				observed.kind === "verification" &&
				(expectedVerificationIds === null || expectedVerificationIds.has(observed.id))
			) {
				findings.push({
					kind: "targeted-verification",
					id: completed.id,
					reason: `targeted-verification:${completed.id}`,
				});
				continue;
			}
			findings.push({
				kind: "replayed-completed-operation",
				id: completed.id,
				reason: `replayed-completed-operation:${completed.kind}:${completed.id}`,
			});
		}

		for (const observed of input.observedOperations) {
			if (
				observed.kind !== "verification" ||
				(expectedVerificationIds !== null && !expectedVerificationIds.has(observed.id))
			) {
				continue;
			}
			if (findings.some(finding => finding.kind === "targeted-verification" && finding.id === observed.id)) {
				continue;
			}
			findings.push({
				kind: "targeted-verification",
				id: observed.id,
				reason: `targeted-verification:${observed.id}`,
			});
		}
	}

	if (coverage.obligations === "captured") {
		const observedObligations = indexById(input.observedObligations, "observedObligations");
		for (const required of input.requiredObligations) {
			const observed = observedObligations.get(required.id);
			if (observed && observed.kind === required.kind) continue;
			findings.push({
				kind: "missed-obligation",
				id: required.id,
				reason: `missed-obligation:${required.kind}:${required.id}`,
			});
		}
	}

	const costs = evaluateCosts(input);
	const allowance = evaluateAllowance(input.allowanceObservations, coverage.allowance);

	const rejectReasons: string[] = [];
	const incompleteReasons: string[] = [];
	const seenReasons: Record<string, true> = {};

	for (const finding of findings) {
		if (!REJECTING_FINDINGS[finding.kind] || seenReasons[finding.reason]) continue;
		seenReasons[finding.reason] = true;
		rejectReasons.push(finding.reason);
	}

	for (const key of CONTINUITY_CAPTURE_KEYS) {
		const reason =
			coverage[key] === "missing"
				? `missing-capture:${key}`
				: coverage[key] === "unsupported"
					? `unsupported-measurement:${key}`
					: null;
		if (!reason || seenReasons[reason]) continue;
		seenReasons[reason] = true;
		incompleteReasons.push(reason);
	}

	if (coverage.attempts === "captured" && coverage.successors === "captured") {
		const boundSuccessors = boundSuccessfulDestinations(costs.attempts, input.lineage);
		if (boundSuccessors.length === 0) {
			const succeededDestination = costs.attempts.some(
				attempt => attempt.kind === "destination" && attempt.outcome === "succeeded",
			);
			const reason = succeededDestination ? "no-distinct-recorded-successor" : "no-successful-destination";
			if (!seenReasons[reason]) {
				seenReasons[reason] = true;
				rejectReasons.push(reason);
			}
		} else if (optionalFinite(input.sourceRolloverAtMs) !== null) {
			if (costs.usefulWorkBeforeSourceRollover === false && !seenReasons["useful-work-after-source-rollover"]) {
				seenReasons["useful-work-after-source-rollover"] = true;
				rejectReasons.push("useful-work-after-source-rollover");
			} else if (costs.usefulWorkBeforeSourceRollover === null && !seenReasons["missing-useful-work-observation"]) {
				seenReasons["missing-useful-work-observation"] = true;
				incompleteReasons.push("missing-useful-work-observation");
			}
		}
	}

	const verdict: ContinuationTrialVerdict =
		rejectReasons.length > 0
			? { result: "reject", reasons: rejectReasons }
			: incompleteReasons.length > 0
				? { result: "incomplete", reasons: incompleteReasons }
				: { result: "pass", reasons: [] };

	return {
		version: CONTINUATION_EVALUATION_VERSION,
		trialId: input.trialId,
		lineage: {
			runId: input.lineage.runId,
			sourceSessionId: input.lineage.sourceSessionId,
			successorSessionIds: [...input.lineage.successorSessionIds],
		},
		verdict,
		findings,
		coverage,
		measurementScope: "scripted-control",
		costs,
		allowance,
		inferenceLimits: { ...INFERENCE_LIMITS },
		gateCComparison: CONTINUATION_GATE_C_COMPARISON_SPEC,
	};
}

function boundSuccessfulDestinations(
	attempts: readonly ContinuationAttemptCost[],
	lineage: ContinuationTrialLineage,
): ContinuationAttemptCost[] {
	const successorIds = new Set(lineage.successorSessionIds);
	return attempts.filter(
		attempt =>
			attempt.kind === "destination" &&
			attempt.outcome === "succeeded" &&
			attempt.sessionId !== null &&
			attempt.sessionId !== lineage.sourceSessionId &&
			successorIds.has(attempt.sessionId),
	);
}

function evaluateCosts(input: ContinuationTrialInput): ContinuationCostReport {
	const attempts: ContinuationAttemptCost[] = input.attempts.map(attempt => {
		const usage = attempt.usage ? normalizeContinuationUsage(attempt.usage) : null;
		const requestCount = optionalFinite(attempt.requestCount);
		return {
			attemptId: attempt.id,
			kind: attempt.kind,
			outcome: attempt.outcome,
			sessionId: optionalString(attempt.sessionId),
			provider: optionalString(attempt.provider),
			account: optionalString(attempt.account),
			model: optionalString(attempt.model),
			sessionRole: attempt.sessionRole ?? null,
			reason: optionalString(attempt.reason),
			usage,
			requestCount,
			briefingTokens: optionalFinite(attempt.briefingTokens),
			contextLoadedTokens: optionalFinite(attempt.contextLoadedTokens),
			rePrimingRequests: optionalFinite(attempt.rePrimingRequests),
			firstUsefulActionAtMs: optionalFinite(attempt.firstUsefulActionAtMs),
			coldCache:
				attempt.kind === "destination" && usage !== null && requestCount !== null && requestCount > 0
					? usage.cacheRead === 0
					: null,
			briefingBytes: optionalFinite(attempt.briefingBytes),
			contextLoadedBytes: optionalFinite(attempt.contextLoadedBytes),
			transferOverheadBytes: optionalFinite(attempt.transferOverheadBytes),
			reconstructionOverheadBytes: optionalFinite(attempt.reconstructionOverheadBytes),
			usageKind: usage === null ? null : "synthetic",
		};
	});

	const source = attempts.filter(attempt => attempt.kind === "source");
	const destinations = attempts.filter(attempt => attempt.kind === "destination");
	const unknownUsageAttemptIds = attempts.filter(attempt => attempt.usage === null).map(attempt => attempt.attemptId);
	const costCaptured = input.capture.attempts === "captured" && input.capture.costs === "captured";

	const sourceUsage = sumUsage(source.map(attempt => attempt.usage));
	const destinationUsage = sumUsage(destinations.map(attempt => attempt.usage));
	const knownTotals = sumUsage(attempts.map(attempt => attempt.usage));
	const sourceRequestCount = sumKnown(source.map(attempt => attempt.requestCount));
	const destinationRequestCount = sumKnown(destinations.map(attempt => attempt.requestCount));
	const knownRequestCount = sumKnown(attempts.map(attempt => attempt.requestCount));
	const briefingTokens = sumKnown(destinations.map(attempt => attempt.briefingTokens));
	const contextLoadedTokens = sumKnown(destinations.map(attempt => attempt.contextLoadedTokens));
	const rePrimingRequests = sumKnown(attempts.map(attempt => attempt.rePrimingRequests));
	const briefingBytes = sumKnown(destinations.map(attempt => attempt.briefingBytes));
	const contextLoadedBytes = sumKnown(attempts.map(attempt => attempt.contextLoadedBytes));
	const transferOverheadBytes = sumKnown(attempts.map(attempt => attempt.transferOverheadBytes));
	const reconstructionOverheadBytes = sumKnown(attempts.map(attempt => attempt.reconstructionOverheadBytes));
	const cacheRead = knownTotals?.cacheRead ?? null;
	const cacheWrite = knownTotals?.cacheWrite ?? null;

	const boundSuccessors = boundSuccessfulDestinations(attempts, input.lineage);
	const usefulTimes = boundSuccessors
		.map(attempt => attempt.firstUsefulActionAtMs)
		.filter((value): value is number => value !== null);
	const firstUsefulActionAtMs = usefulTimes.length > 0 ? Math.min(...usefulTimes) : null;
	const originMs = optionalFinite(input.sourceExhaustedAtMs);
	const firstUsefulActionLatencyMs =
		firstUsefulActionAtMs !== null && originMs !== null ? firstUsefulActionAtMs - originMs : null;
	const rolloverMs = optionalFinite(input.sourceRolloverAtMs);
	const usefulWorkBeforeSourceRollover =
		firstUsefulActionAtMs !== null && rolloverMs !== null ? firstUsefulActionAtMs < rolloverMs : null;

	const usageComplete = costCaptured && unknownUsageAttemptIds.length === 0;
	const requestComplete =
		costCaptured && attempts.length > 0 && attempts.every(attempt => attempt.requestCount !== null);
	const briefingComplete = costCaptured && destinations.length > 0 && briefingTokens !== null;
	const contextComplete = costCaptured && destinations.length > 0 && contextLoadedTokens !== null;
	const reprimingComplete = costCaptured && attempts.length > 0 && rePrimingRequests !== null;
	const reasoningComplete =
		costCaptured &&
		attempts.length > 0 &&
		attempts.every(attempt => attempt.usage !== null && attempt.usage.reasoningTokens !== null);
	const dimensionComplete: ContinuationCostDimensionComplete = {
		usage: usageComplete,
		requestCount: requestComplete,
		briefingTokens: briefingComplete,
		contextLoadedTokens: contextComplete,
		rePrimingRequests: reprimingComplete,
		reasoningTokens: reasoningComplete,
	};
	const briefingBytesComplete = costCaptured && destinations.length > 0 && briefingBytes !== null;
	const contextBytesComplete = costCaptured && attempts.length > 0 && contextLoadedBytes !== null;
	const transferComplete = costCaptured && attempts.length > 0 && transferOverheadBytes !== null;
	const reconstructionComplete = costCaptured && attempts.length > 0 && reconstructionOverheadBytes !== null;
	const latencyComplete = firstUsefulActionLatencyMs !== null;
	const dimensionKind: ContinuationCostDimensionKind = {
		usage: usageComplete ? "synthetic" : "unknown",
		requestCount: requestComplete ? "measured" : "unknown",
		briefingTokens: briefingComplete ? "measured" : "unknown",
		briefingBytes: briefingBytesComplete ? "measured" : "unknown",
		contextLoadedTokens: contextComplete ? "measured" : "unknown",
		contextLoadedBytes: contextBytesComplete ? "measured" : "unknown",
		rePrimingRequests: reprimingComplete ? "measured" : "unknown",
		reasoningTokens: reasoningComplete ? "synthetic" : "unknown",
		transferOverheadBytes: transferComplete ? "measured" : "unknown",
		reconstructionOverheadBytes: reconstructionComplete ? "measured" : "unknown",
		firstUsefulActionLatencyMs: latencyComplete ? "measured" : "unknown",
	};

	return {
		attempts,
		sourceUsage,
		sourceRequestCount,
		destinationUsage,
		destinationRequestCount,
		knownTotals,
		knownRequestCount,
		totalsComplete:
			usageComplete &&
			requestComplete &&
			briefingComplete &&
			contextComplete &&
			reprimingComplete &&
			reasoningComplete,
		dimensionComplete,
		unknownUsageAttemptIds,
		briefingTokens,
		contextLoadedTokens,
		rePrimingRequests,
		cacheRead,
		cacheWrite,
		firstUsefulActionLatencyMs,
		usefulWorkBeforeSourceRollover,
		scriptedUsage: "synthetic",
		dimensionKind,
		briefingBytes,
		contextLoadedBytes,
		transferOverheadBytes,
		reconstructionOverheadBytes,
	};
}

function evaluateAllowance(
	observations: readonly ContinuationAllowanceObservation[] | undefined,
	capture: ContinuationCaptureStatus,
): ContinuationAllowanceAttribution[] {
	if (capture !== "captured" || !observations || observations.length === 0) {
		return [{ status: "unknown", reason: "missing", provider: null, account: null, windowId: null }];
	}
	return observations.map(observation => {
		const provider = optionalString(observation.provider);
		const account = optionalString(observation.account);
		const windowId = optionalString(observation.windowId);
		if (!provider || !account || !windowId) {
			return {
				status: "unknown",
				reason: "incomplete-identity",
				provider,
				account,
				windowId,
			};
		}
		const used = optionalFinite(observation.used);
		const limit = optionalFinite(observation.limit);
		const unit = optionalString(observation.unit);
		const observedAtMs = optionalFinite(observation.observedAtMs);
		if (used === null || limit === null || unit === null || observedAtMs === null) {
			return {
				status: "unknown",
				reason: "incomplete-measurement",
				provider,
				account,
				windowId,
			};
		}
		return {
			status: "observed",
			provider,
			account,
			windowId,
			epochId: optionalString(observation.epochId),
			used,
			limit,
			unit,
			observedAtMs,
			competingConsumers: observation.competingConsumers === undefined ? null : [...observation.competingConsumers],
			sampleAgeMs: optionalFinite(observation.sampleAgeMs),
		};
	});
}

function validateInput(input: ContinuationTrialInput): void {
	if (!input || typeof input !== "object") {
		throw new ContinuationEvaluationError("invalid-input", "Continuation trial input is required.");
	}
	if (input.version !== CONTINUATION_EVALUATION_VERSION) {
		throw new ContinuationEvaluationError(
			"unsupported-version",
			`Unsupported continuation evaluation version ${String(input.version)}.`,
			{ version: input.version },
		);
	}
	assertNonEmptyString(input.trialId, "trialId");
	if (input.measurementScope !== "scripted-control") {
		throw new ContinuationEvaluationError("invalid-input", "measurementScope must be scripted-control.", {
			measurementScope: input.measurementScope,
		});
	}
	assertCapture(input.capture);
	if (!input.lineage || typeof input.lineage !== "object") {
		throw new ContinuationEvaluationError("invalid-input", "lineage is required.");
	}
	assertNonEmptyString(input.lineage.runId, "lineage.runId");
	assertNonEmptyString(input.lineage.sourceSessionId, "lineage.sourceSessionId");
	assertStringArray(input.lineage.successorSessionIds, "lineage.successorSessionIds");
	assertObservationArray(input.requiredKnowledge, "requiredKnowledge");
	assertObservationArray(input.observedKnowledge, "observedKnowledge");
	assertObservationArray(input.completedOperations, "completedOperations");
	assertObservationArray(input.observedOperations, "observedOperations");
	assertObservationArray(input.requiredObligations, "requiredObligations");
	assertObservationArray(input.observedObligations, "observedObligations");
	assertObservationArray(input.attempts, "attempts");
	if (input.expectedVerifications !== undefined) {
		assertObservationArray(input.expectedVerifications, "expectedVerifications");
	}
	if (input.allowanceObservations !== undefined) {
		assertObservationArray(input.allowanceObservations, "allowanceObservations");
	}
	indexById(input.requiredKnowledge, "requiredKnowledge");
	indexById(input.completedOperations, "completedOperations");
	indexById(input.requiredObligations, "requiredObligations");
	indexById(input.attempts, "attempts");
	for (const item of input.requiredKnowledge) {
		assertNonEmptyString(item.id, "requiredKnowledge.id");
		assertNonEmptyString(item.kind, "requiredKnowledge.kind");
		assertNonEmptyString(item.evidence, "requiredKnowledge.evidence");
	}
	for (const item of input.observedKnowledge) {
		assertNonEmptyString(item.id, "observedKnowledge.id");
		assertNonEmptyString(item.kind, "observedKnowledge.kind");
		assertNonEmptyString(item.evidence, "observedKnowledge.evidence");
	}
	for (const item of input.completedOperations) {
		assertNonEmptyString(item.id, "completedOperations.id");
		assertNonEmptyString(item.kind, "completedOperations.kind");
	}
	for (const item of input.observedOperations) {
		assertNonEmptyString(item.id, "observedOperations.id");
		assertNonEmptyString(item.kind, "observedOperations.kind");
	}
	for (const item of input.requiredObligations) {
		assertNonEmptyString(item.id, "requiredObligations.id");
		assertNonEmptyString(item.kind, "requiredObligations.kind");
	}
	for (const item of input.observedObligations) {
		assertNonEmptyString(item.id, "observedObligations.id");
		assertNonEmptyString(item.kind, "observedObligations.kind");
	}
	for (const attempt of input.attempts) {
		assertNonEmptyString(attempt.id, "attempts.id");
		if (attempt.kind !== "source" && attempt.kind !== "destination") {
			throw new ContinuationEvaluationError("invalid-input", `Invalid attempt kind on ${attempt.id}.`, {
				attemptId: attempt.id,
				kind: attempt.kind,
			});
		}
		if (!isAttemptOutcome(attempt.outcome)) {
			throw new ContinuationEvaluationError("invalid-input", `Invalid attempt outcome on ${attempt.id}.`, {
				attemptId: attempt.id,
				outcome: attempt.outcome,
			});
		}
		if (attempt.usage) normalizeContinuationUsage(attempt.usage);
	}
}

function assertCapture(
	capture: ContinuationObservationCapture | undefined,
): asserts capture is ContinuationObservationCapture {
	if (!capture || typeof capture !== "object") {
		throw new ContinuationEvaluationError("invalid-input", "capture is required.");
	}
	for (const key of CAPTURE_KEYS) {
		const value = capture[key];
		if (value !== "captured" && value !== "missing" && value !== "unsupported") {
			throw new ContinuationEvaluationError(
				"invalid-input",
				`capture.${key} must be captured, missing, or unsupported.`,
				{ key, value },
			);
		}
	}
}

function isAttemptOutcome(value: unknown): value is ContinuationAttemptOutcome {
	return (
		value === "succeeded" ||
		value === "failed" ||
		value === "rejected" ||
		value === "budget-limited" ||
		value === "not-started"
	);
}

function indexById<T extends { id: string }>(items: readonly T[], label: string): Map<string, T> {
	const index = new Map<string, T>();
	for (const item of items) {
		assertNonEmptyString(item.id, `${label}.id`);
		if (index.has(item.id)) {
			throw new ContinuationEvaluationError("invalid-input", `Duplicate id in ${label}: ${item.id}.`, {
				label,
				id: item.id,
			});
		}
		index.set(item.id, item);
	}
	return index;
}

function sumUsage(usages: readonly (ContinuationTokenUsage | null)[]): ContinuationTokenUsage | null {
	const known = usages.filter((usage): usage is ContinuationTokenUsage => usage !== null);
	if (known.length === 0) return null;
	const reasoningKnown = known.every(usage => usage.reasoningTokens !== null);
	return {
		input: known.reduce((sum, usage) => sum + usage.input, 0),
		output: known.reduce((sum, usage) => sum + usage.output, 0),
		cacheRead: known.reduce((sum, usage) => sum + usage.cacheRead, 0),
		cacheWrite: known.reduce((sum, usage) => sum + usage.cacheWrite, 0),
		totalTokens: known.reduce((sum, usage) => sum + usage.totalTokens, 0),
		reasoningTokens: reasoningKnown ? known.reduce((sum, usage) => sum + (usage.reasoningTokens ?? 0), 0) : null,
	};
}

function sumKnown(values: readonly (number | null)[]): number | null {
	if (values.length === 0) return null;
	let sum = 0;
	for (const value of values) {
		if (value === null) return null;
		sum += value;
	}
	return sum;
}

function optionalString(value: string | undefined): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalFinite(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ContinuationEvaluationError("invalid-input", `${label} must be a finite number.`, { label, value });
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ContinuationEvaluationError("invalid-input", `${label} must be a non-empty string.`, { label, value });
	}
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
		throw new ContinuationEvaluationError("invalid-input", `${label} must be an array of strings.`, { label });
	}
}

function assertObservationArray(value: unknown, label: string): asserts value is unknown[] {
	if (!Array.isArray(value)) {
		throw new ContinuationEvaluationError("invalid-input", `${label} must be an array.`, { label });
	}
}
