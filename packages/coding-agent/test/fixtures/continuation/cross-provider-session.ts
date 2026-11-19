/**
 * PT-01 v2 inline E2/E4 harness. Real AgentSession, owner store, Sjujperpowers
 * helpers and localhost scripted encoders. Missing workflow source fails closed.
 * Scripted usage is synthetic; this is not model competence or savings evidence.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, ThinkingLevel, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { streamSimple, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ContinuationWorkflow } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ContinuationPreparationOptions } from "@oh-my-pi/pi-coding-agent/session/continuation-handoff";
import { openContinuationRun, type ContinuationRun } from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import {
	CONTINUATION_EVALUATION_VERSION,
	evaluateContinuationTrial,
	type ContinuationEvaluationResult,
	type ContinuationKnowledgeObservation,
	type ContinuationObservationCapture,
} from "@oh-my-pi/pi-coding-agent/session/continuation-evaluation";
import type { ContinuationPolicyV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-policy";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	inspectCommittedRunState,
	sha256Bytes,
	type FileEvidenceRef,
} from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import { anthropicSse, openaiResponsesSse, openaiResponsesToolSse, quotaLimitResponse } from "./scripted-providers";
import {
	COMPLETE_TASK_TOOL,
	DISCOVERY_SUMMARY,
	DRAFT_TEXT,
	NEXT_ACTION,
	OPEN_FINDING,
	PROTECTED_CONSTRAINT,
	QUEUED_INSTRUCTION,
	REJECTED_APPROACH,
	REJECTED_REASON,
	RETAINED_INSTRUCTION,
	REVIEW_TASK_TOOL,
	ROLE_OBLIGATION,
	SOURCE_HISTORY_MARKER,
	anthropicToolUseSse,
	loadSjujperpowersRecovery,
	payloadText,
	requireWorkflowSource,
} from "./portable-session";

export const PLAN_RELATIVE = "docs/project/plans/feature.md";
export const OPEN_FINDING_FAILURE = "OPEN_FINDING_FAILURE";
export const RECORD_SOURCE_TOOL = "record_source_result";
export const SOURCE_RESULT_MARKER = "SOURCE_RESULT_PERSISTED";
export const QUEUED_DEVELOPER = "QUEUED_DEVELOPER_INSTRUCTION";
export const SOURCE_ACCOUNT = "fixture-source-account";
export const DEST_ACCOUNT = "fixture-dest-account";
export const FIXTURE_SCOPE = "fixture";
export const POLICY_REVISION = "pt01-policy-v2";
export const REQUEST_CAP = 64;
export const CASE_TIMEOUT_MS = 30_000;
export const SOURCE_ROLLOVER_MS = 1_200_000;
export const ANTHROPIC_MODEL_ID = "pt01-scripted-sonnet";
export const OPENAI_MODEL_ID = "pt01-scripted-responses";
const SCRIPTED_KEYS = { anthropic: "synthetic-anthropic-fixture", openai: "synthetic-openai-fixture" } as const;

export const PLAN = `# Cross-Provider Continuation Implementation Plan

**Spec:** \`docs/project/specs/portable.md\`

**Source:** plane:PT-01

## Global Constraints

- ${PROTECTED_CONSTRAINT}
- Exact next action is ${NEXT_ACTION}

---

### Task 1: Completed unlanded work

Task 1 produced the reviewed base. Do not redispatch. Landing remains outstanding.

### Task 2: Review unfinished work

${NEXT_ACTION}
Two findings: ${OPEN_FINDING}; ${OPEN_FINDING_FAILURE}.
Rejected: ${REJECTED_APPROACH} because ${REJECTED_REASON}.

### Task 3: Pending follow-on

Task 3 stays pending until Task 2 review lands.
`;

export type CrossProviderCaseId = "E1" | "E2" | "E3" | "E4";
export type CrossProviderDirection = "anthropic-to-openai-responses" | "openai-responses-to-anthropic";
export type CrossProviderInterleaving = "instruction-first" | "result-first";
export type CrossProviderWorkflowKind = "inline-session" | "sdd-kata";
export type CrossProviderHandoff = "automatic" | "manual";

export interface CrossProviderWorkflowContext {
	root: string;
	planRelativePath: string;
	planAbsolutePath: string;
	workflowSource: string;
}

export interface CrossProviderWorkflowBindings {
	workflow: ContinuationWorkflow;
	publishSnapshot(): Promise<{ acknowledged: boolean; discoveryRef: FileEvidenceRef }>;
	findings: readonly string[];
	rejectedApproach: string;
	rejectedReason: string;
	nextAction: string;
	protectedConstraint: string;
	discoveryRef: FileEvidenceRef;
	/** Absolute plan path; overrides ctx plan for run enrollment when set. */
	planPath?: string;
	cleanup(): Promise<void>;
	verify(): Promise<unknown>;
}

export interface CrossProviderCaseOptions {
	caseId: CrossProviderCaseId;
	direction: CrossProviderDirection;
	interleaving: CrossProviderInterleaving;
	workflowKind: CrossProviderWorkflowKind;
	/** Defaults to manual so Kata E1/E3 do not opt into automatic inference. */
	handoff?: CrossProviderHandoff;
	setupWorkflow?: (ctx: CrossProviderWorkflowContext) => Promise<CrossProviderWorkflowBindings>;
}

export interface CrossProviderCaseResult {
	caseId: CrossProviderCaseId;
	evaluation: ContinuationEvaluationResult;
	sourceRequests: number;
	destinationRequests: number;
	elapsedFirstUsefulActionMs: number;
	workflowVerification: unknown;
}

interface ProtocolEndpoint {
	origin: string;
	baseUrl: string;
	requests: number;
	bodies: string[];
	quotaRequests: number;
	stop(): Promise<void>;
}

interface ToolEffects {
	completeTask1: number;
	recordSourceResult: number;
	reviewUnfinished: number;
}

function sessionConfig() {
	return {
		version: 1,
		configPath: "/fixture/.sjujperpowers/config.json",
		docsRoot: "docs/project",
		roadmap: { provider: "file" },
		execution: { provider: "session", completion: "landed" },
	};
}

function enrollmentPlanPath(root: string, override?: string): string {
	if (!override) return PLAN_RELATIVE;
	return path.isAbsolute(override) ? path.relative(root, override) : override;
}

function hasNativeToolResult(body: string, api: "anthropic-messages" | "openai-responses"): boolean {
	if (api === "anthropic-messages") return body.includes("tool_result") || body.includes("toolu_");
	return body.includes("function_call_output") || body.includes("call_review") || body.includes("call_source");
}

function startProtocolEndpoint(
	api: "anthropic-messages" | "openai-responses",
	mode: "source" | "destination",
	onQuota?: () => void,
): ProtocolEndpoint {
	const bodies: string[] = [];
	let requests = 0;
	let quotaRequests = 0;
	const toolName = mode === "source" ? RECORD_SOURCE_TOOL : REVIEW_TASK_TOOL;
	const callId = mode === "source" ? "call_source" : "call_review";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests += 1;
			if (requests > REQUEST_CAP) {
				return new Response("PT-01 request cap exceeded", { status: 429 });
			}
			const body = await request.text();
			bodies.push(body);
			const key = api === "anthropic-messages" ? SCRIPTED_KEYS.anthropic : SCRIPTED_KEYS.openai;
			const authorization = request.headers.get("authorization");
			const apiKey = request.headers.get("x-api-key");
			if (
				(authorization === null && apiKey === null) ||
				(authorization !== null && authorization !== `Bearer ${key}`) ||
				(apiKey !== null && apiKey !== key)
			) {
				return new Response("Scripted destination received the wrong provider credential", { status: 401 });
			}
			if (mode === "source" && hasNativeToolResult(body, api)) {
				quotaRequests += 1;
				onQuota?.();
				return quotaLimitResponse();
			}
			if (mode === "destination" && hasNativeToolResult(body, api)) {
				return api === "anthropic-messages"
					? anthropicSse("scripted-unfinished-ack")
					: openaiResponsesSse("scripted-unfinished-ack");
			}
			if (api === "anthropic-messages") return anthropicToolUseSse(toolName, {});
			return openaiResponsesToolSse(toolName, {}, callId);
		},
	});
	const origin = server.url.origin;
	const baseUrl = api === "openai-responses" ? `${origin}/v1` : origin;
	return {
		origin,
		baseUrl,
		get requests() {
			return requests;
		},
		bodies,
		get quotaRequests() {
			return quotaRequests;
		},
		async stop() {
			await server.stop(true);
		},
	};
}

function makeTool(name: string, label: string, onRun: () => void | Promise<void>): AgentTool {
	return {
		name,
		label,
		description: label,
		parameters: type({}),
		execute: async () => {
			await onRun();
			return { content: [{ type: "text", text: `${name}-effect` }] };
		},
	};
}

function evidenceDir(): string | undefined {
	const dir = process.env.CONTINUATION_PT01_EVIDENCE_DIR ?? process.env.CONTINUATION_EVIDENCE_DIR;
	return dir && dir.trim() !== "" ? dir : undefined;
}

export async function writePt01Evidence(name: string, evidence: Record<string, unknown>): Promise<string | undefined> {
	const dir = evidenceDir();
	if (!dir) return undefined;
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `${name}.json`);
	await fs.writeFile(
		file,
		`${JSON.stringify(
			{
				...evidence,
				competenceClaim: false,
				note: "Scripted localhost Anthropic Messages / OpenAI Responses; not a semantic model evaluation.",
			},
			null,
			2,
		)}\n`,
	);
	return file;
}

function modelsYml(anthropicBase: string, openaiBase: string): string {
	return `providers:
  anthropic:
    baseUrl: ${anthropicBase}
    api: anthropic-messages
    apiKey: synthetic-local-fixture
    models:
      - id: ${ANTHROPIC_MODEL_ID}
        name: PT-01 scripted Anthropic
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 32000
        maxTokens: 4096
  openai:
    baseUrl: ${openaiBase}
    api: openai-responses
    apiKey: synthetic-local-fixture
    models:
      - id: ${OPENAI_MODEL_ID}
        name: PT-01 scripted OpenAI Responses
        reasoning: false
        input: [text]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 32000
        maxTokens: 4096
`;
}

function buildScriptedModel(api: "anthropic-messages" | "openai-responses", baseUrl: string): Model {
	if (api === "anthropic-messages") {
		return buildModel({
			provider: "anthropic",
			api: "anthropic-messages",
			id: ANTHROPIC_MODEL_ID,
			name: "PT-01 scripted Anthropic",
			baseUrl,
			reasoning: false,
			input: ["text"],
			contextWindow: 32_000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	}
	return buildModel({
		provider: "openai",
		api: "openai-responses",
		id: OPENAI_MODEL_ID,
		name: "PT-01 scripted OpenAI Responses",
		baseUrl,
		reasoning: false,
		input: ["text"],
		contextWindow: 32_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function destinationCandidate(model: Model, account: string): ContinuationPolicyV1["candidates"][number] {
	return {
		provider: model.provider,
		account,
		model: model.id,
		endpoint: model.baseUrl,
		roles: ["primary", "worker", "advisor", "maintenance"],
		settings: { thinkingLevel: "off" },
		dataScope: FIXTURE_SCOPE,
	};
}

async function setupInlineWorkflow(ctx: CrossProviderWorkflowContext): Promise<CrossProviderWorkflowBindings> {
	const { recordRecovery, exportRecovery } = await loadSjujperpowersRecovery();
	const discoveryPath = path.join(ctx.root, "docs/project/evidence/discovery.txt");
	await fs.mkdir(path.dirname(discoveryPath), { recursive: true });
	const discoveryBytes = Buffer.from(`${DISCOVERY_SUMMARY}\n`, "utf8");
	await fs.writeFile(discoveryPath, discoveryBytes);
	const discoveryRef: FileEvidenceRef = {
		kind: "file",
		path: await fs.realpath(discoveryPath),
		byteLength: discoveryBytes.byteLength,
		sha256: sha256Bytes(discoveryBytes),
	};
	await recordRecovery({
		root: ctx.root,
		planPath: ctx.planAbsolutePath,
		config: sessionConfig(),
		event: {
			workflow: "inline",
			current: { task: 2, phase: "execute", round: null, nextAction: NEXT_ACTION },
			tasks: [
				{ number: 1, state: "complete", phase: "complete", round: null, nextAction: null },
				{ number: 2, state: "in_progress", phase: "execute", round: null, nextAction: NEXT_ACTION },
				{ number: 3, state: "pending", phase: "execute", round: null, nextAction: null },
			],
			todos: [
				{ id: "t1", content: "Completed unlanded work", status: "completed" },
				{ id: "t2", content: NEXT_ACTION, status: "in_progress" },
				{ id: "t3", content: "Pending follow-on", status: "pending" },
			],
		},
	});
	return {
		workflow: {
			id: "sjujperpowers-inline",
			exportProjection: async ({ cwd, planPath: relative }) =>
				(await exportRecovery({
					root: cwd,
					planPath: relative,
					config: sessionConfig(),
					workflow: "inline",
				})) as never,
		},
		findings: [OPEN_FINDING, OPEN_FINDING_FAILURE],
		rejectedApproach: REJECTED_APPROACH,
		rejectedReason: REJECTED_REASON,
		nextAction: NEXT_ACTION,
		protectedConstraint: PROTECTED_CONSTRAINT,
		discoveryRef,
		async publishSnapshot() {
			const recorded = await recordRecovery({
				root: ctx.root,
				planPath: ctx.planAbsolutePath,
				config: sessionConfig(),
				event: {
					workflow: "inline",
					current: { task: 2, phase: "review", round: 1, nextAction: NEXT_ACTION },
					tasks: [
						{ number: 1, state: "complete", phase: "complete", round: null, nextAction: null },
						{ number: 2, state: "review", phase: "review", round: 1, nextAction: NEXT_ACTION },
						{ number: 3, state: "pending", phase: "execute", round: null, nextAction: null },
					],
					findings: [
						{ id: "finding-open", task: 2, status: "open", summary: OPEN_FINDING, evidence: [] },
						{ id: "finding-failure", task: 2, status: "open", summary: OPEN_FINDING_FAILURE, evidence: [] },
					],
					rejectedApproaches: [
						{
							id: "rejected-1",
							task: 2,
							summary: REJECTED_APPROACH,
							reason: REJECTED_REASON,
							evidence: [],
						},
					],
					todos: [
						{ id: "t1", content: "Completed unlanded work", status: "completed" },
						{ id: "t2", content: NEXT_ACTION, status: "in_progress" },
						{ id: "t3", content: "Pending follow-on", status: "pending" },
					],
					writeFiles: [
						{
							path: "docs/project/evidence/task-2-report.md",
							contents: `open finding: ${OPEN_FINDING}\nopen finding: ${OPEN_FINDING_FAILURE}\n`,
						},
					],
				},
			});
			if (!recorded.acknowledged) {
				throw new Error("recordRecovery did not acknowledge the current snapshot publication");
			}
			return { acknowledged: true, discoveryRef };
		},
		async cleanup() {},
		async verify() {
			return {
				workflow: "inline",
				findings: [OPEN_FINDING, OPEN_FINDING_FAILURE],
			};
		},
	};
}

function assertDestinationNative(api: "anthropic-messages" | "openai-responses", bodies: readonly string[]): void {
	const payload = payloadText(bodies);
	if (payload.includes(SOURCE_HISTORY_MARKER)) {
		throw new Error("Destination request replayed source history");
	}
	if (Object.values(SCRIPTED_KEYS).some(key => payload.includes(key))) {
		throw new Error("Destination request included source credentials");
	}
	if (payload.includes(DRAFT_TEXT)) {
		throw new Error("Destination request transmitted the unsent draft");
	}
	for (const encoded of bodies) {
		const body = JSON.parse(encoded) as Record<string, unknown>;
		const tools = body.tools as Array<Record<string, unknown>> | undefined;
		if (body.previous_response_id !== undefined) {
			throw new Error("Destination request required a source response-chain handle");
		}
		if (body.service_tier !== undefined) {
			throw new Error("Destination request included an unapproved service tier");
		}
		if (api === "openai-responses") {
			if (!tools?.some(tool => tool.type === "function" && tool.name === REVIEW_TASK_TOOL && tool.parameters)) {
				throw new Error("OpenAI destination request lacked destination-native tools");
			}
			const reasoning = body.reasoning as Record<string, unknown> | undefined;
			if (reasoning !== undefined && (reasoning.effort !== "none" || reasoning.mode !== undefined)) {
				throw new Error("OpenAI destination request did not preserve approved thinking off");
			}
			if (encoded.includes("toolu_") || encoded.includes("cache_control") || body.thinking !== undefined) {
				throw new Error("OpenAI destination request carried Anthropic-private state");
			}
		} else {
			if (!tools?.some(tool => tool.name === `_${REVIEW_TASK_TOOL}` && tool.input_schema)) {
				throw new Error("Anthropic destination request lacked destination-native tools");
			}
			const thinking = body.thinking as Record<string, unknown> | undefined;
			const outputConfig = body.output_config as Record<string, unknown> | undefined;
			if ((thinking !== undefined && thinking.type !== "disabled") || outputConfig?.effort !== undefined) {
				throw new Error("Anthropic destination request did not preserve approved thinking off");
			}
			if (encoded.includes("function_call_output") || body.reasoning !== undefined) {
				throw new Error("Anthropic destination request carried OpenAI-private state");
			}
		}
	}
}

function knowledgeFromPayload(
	payload: string,
	bindings: CrossProviderWorkflowBindings,
): ContinuationKnowledgeObservation[] {
	const required: ContinuationKnowledgeObservation[] = [
		{ id: "constraint-no-publish", kind: "constraint", evidence: bindings.protectedConstraint },
		{ id: "finding-open", kind: "finding", evidence: bindings.findings[0]! },
		{ id: "finding-failure", kind: "finding", evidence: bindings.findings[1] ?? bindings.findings[0]! },
		{ id: "rejected-approach", kind: "rejected-approach", evidence: bindings.rejectedApproach },
		{ id: "next-action", kind: "next-action", evidence: bindings.nextAction },
	];
	return required.filter(item => payload.includes(item.evidence));
}

const CAPTURE: ContinuationObservationCapture = {
	knowledge: "captured",
	operations: "captured",
	obligations: "captured",
	attempts: "captured",
	successors: "captured",
	costs: "captured",
	allowance: "unsupported",
};

const CONTINUATION_BRIEFING_CUSTOM_TYPE = "omp-continuation-briefing";

interface StreamedUsageAccumulator {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	reasoning?: number;
	reasoningKnown: boolean;
}

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isStreamedUsage(value: unknown): value is {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoningTokens?: number;
} {
	if (!value || typeof value !== "object") return false;
	const usage = value as Record<string, unknown>;
	return (
		typeof usage.input === "number" &&
		Number.isFinite(usage.input) &&
		typeof usage.output === "number" &&
		Number.isFinite(usage.output) &&
		typeof usage.cacheRead === "number" &&
		Number.isFinite(usage.cacheRead) &&
		typeof usage.cacheWrite === "number" &&
		Number.isFinite(usage.cacheWrite) &&
		typeof usage.totalTokens === "number" &&
		Number.isFinite(usage.totalTokens)
	);
}

function addStreamedUsage(
	bySession: Map<string, StreamedUsageAccumulator>,
	sessionId: string,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		reasoningTokens?: number;
	},
): void {
	const current = bySession.get(sessionId) ?? {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
		reasoningKnown: true,
	};
	const reasoningKnown =
		current.reasoningKnown && typeof usage.reasoningTokens === "number" && Number.isFinite(usage.reasoningTokens);
	bySession.set(sessionId, {
		input: current.input + usage.input,
		output: current.output + usage.output,
		cacheRead: current.cacheRead + usage.cacheRead,
		cacheWrite: current.cacheWrite + usage.cacheWrite,
		total: current.total + usage.totalTokens,
		reasoning: reasoningKnown ? (current.reasoning ?? 0) + (usage.reasoningTokens ?? 0) : undefined,
		reasoningKnown,
	});
}

function harvestStreamedUsage(
	messages: readonly { role?: string; usage?: unknown }[],
	sessionId: string,
	bySession: Map<string, StreamedUsageAccumulator>,
): void {
	if (bySession.has(sessionId)) return;
	for (const message of messages) {
		if (message.role !== "assistant" || !isStreamedUsage(message.usage)) continue;
		addStreamedUsage(bySession, sessionId, message.usage);
	}
}

function usageLikeFromAccumulator(
	acc: StreamedUsageAccumulator | undefined,
):
	| { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; reasoning?: number }
	| undefined {
	if (!acc) return undefined;
	return {
		input: acc.input,
		output: acc.output,
		cacheRead: acc.cacheRead,
		cacheWrite: acc.cacheWrite,
		total: acc.total,
		...(acc.reasoningKnown ? { reasoning: acc.reasoning } : {}),
	};
}

function partitionSourceBodyBytes(
	bodies: readonly string[],
	api: "anthropic-messages" | "openai-responses",
): { work: number; quota: number } {
	let work = 0;
	let quota = 0;
	for (const body of bodies) {
		const size = utf8Bytes(body);
		if (hasNativeToolResult(body, api)) quota += size;
		else work += size;
	}
	return { work, quota };
}

function briefingBytesFromSession(manager: SessionManager): number | undefined {
	let found = false;
	let total = 0;
	for (const entry of manager.getBranch()) {
		if (entry.type !== "custom_message" || entry.customType !== CONTINUATION_BRIEFING_CUSTOM_TYPE) continue;
		found = true;
		const content = entry.content;
		if (typeof content === "string") {
			total += utf8Bytes(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				total += utf8Bytes(block.text);
			}
		}
	}
	return found ? total : undefined;
}

export async function runCrossProviderCase(options: CrossProviderCaseOptions): Promise<CrossProviderCaseResult> {
	const workflowSource = requireWorkflowSource();
	const handoff = options.handoff ?? "manual";
	const dir = TempDir.createSync(`pt01-${options.caseId.toLowerCase()}`);
	const root = await fs.realpath(dir.path());
	const started = performance.now();
	const effects: ToolEffects = { completeTask1: 0, recordSourceResult: 0, reviewUnfinished: 0 };
	const cleanupErrors: string[] = [];
	const evidence: Record<string, unknown> = {
		case: options.caseId,
		direction: options.direction,
		interleaving: options.interleaving,
		handoff,
		trial: "PT-01",
		version: 2,
		logicalQuotaClockMs: 0,
	};
	const sourceApi = options.direction === "anthropic-to-openai-responses" ? "anthropic-messages" : "openai-responses";
	const destApi = options.direction === "anthropic-to-openai-responses" ? "openai-responses" : "anthropic-messages";
	let bindings: CrossProviderWorkflowBindings | undefined;
	let sourceEndpoint: ProtocolEndpoint | undefined;
	let destEndpoint: ProtocolEndpoint | undefined;
	let session: AgentSession | undefined;
	let run: ContinuationRun | undefined;
	let manager: SessionManager | undefined;
	let authStorage: AuthStorage | undefined;
	let result: CrossProviderCaseResult | undefined;
	let failure: unknown;
	let sourceExhausted = false;
	let sourceExhaustedAtMs: number | undefined;
	let elapsedSourceExhaustedAtMs: number | undefined;
	let quotaMonotonic: number | undefined;
	let firstUsefulActionAtMs: number | undefined;
	let elapsedFirstUsefulActionMs: number | undefined;

	try {
		const defaultPlanAbsolute = path.join(root, PLAN_RELATIVE);
		if (!options.setupWorkflow) {
			await fs.mkdir(path.dirname(defaultPlanAbsolute), { recursive: true });
			await fs.writeFile(defaultPlanAbsolute, PLAN);
		}
		const ctx: CrossProviderWorkflowContext = {
			root,
			planRelativePath: PLAN_RELATIVE,
			planAbsolutePath: defaultPlanAbsolute,
			workflowSource,
		};
		bindings = await (options.setupWorkflow ?? setupInlineWorkflow)(ctx);
		const planRelative = enrollmentPlanPath(root, bindings.planPath);
		const sessionsDir = path.join(root, "sessions");
		sourceEndpoint = startProtocolEndpoint(sourceApi, "source", () => {
			sourceExhausted = true;
			sourceExhaustedAtMs = 0;
			quotaMonotonic = performance.now();
			elapsedSourceExhaustedAtMs = quotaMonotonic - started;
		});
		destEndpoint = startProtocolEndpoint(destApi, "destination");
		const sourceModel = buildScriptedModel(sourceApi, sourceEndpoint.baseUrl);
		const destModel = buildScriptedModel(destApi, destEndpoint.baseUrl);
		const modelsPath = path.join(root, "models.yml");
		await fs.writeFile(
			modelsPath,
			modelsYml(
				sourceApi === "anthropic-messages" ? sourceEndpoint.baseUrl : destEndpoint.baseUrl,
				sourceApi === "openai-responses" ? sourceEndpoint.baseUrl : destEndpoint.baseUrl,
			),
		);
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", SCRIPTED_KEYS.anthropic);
		authStorage.setRuntimeApiKey("openai", SCRIPTED_KEYS.openai);
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath: path.join(root, "models.db"),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
				"advisor.enabled": false,
				"retry.enabled": false,
				"memories.enabled": false,
				defaultThinkingLevel: "off",
			}),
		});
		const policy: ContinuationPolicyV1 = {
			version: 1,
			revision: POLICY_REVISION,
			roles: ["primary", "worker", "advisor", "maintenance"],
			dataScope: FIXTURE_SCOPE,
			candidates: [destinationCandidate(sourceModel, SOURCE_ACCOUNT), destinationCandidate(destModel, DEST_ACCOUNT)],
			unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
			attemptBudget: 16,
			restrictedAccounts: [],
		};
		manager = SessionManager.create(root, sessionsDir);
		manager.appendMessage({ role: "user", content: SOURCE_HISTORY_MARKER, timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.setSessionName(`pt-01-${options.caseId.toLowerCase()}-source`, "user");
		run = await openContinuationRun({
			sessionManager: manager,
			planPath: planRelative,
			policy,
			source: policy.candidates[0]!,
			workflow: bindings.workflow,
			observeRequest: async (request, _sessionId) => {
				const isSource = request.model.provider === sourceModel.provider && request.model.id === sourceModel.id;
				return {
					account: isSource ? SOURCE_ACCOUNT : DEST_ACCOUNT,
					dataScope: FIXTURE_SCOPE,
					contextTokens: 8_192,
					allowances: [
						{
							provider: sourceModel.provider,
							account: SOURCE_ACCOUNT,
							window: "fixture-window",
							headroom: sourceExhausted ? "exhausted" : "healthy",
						},
						{
							provider: destModel.provider,
							account: DEST_ACCOUNT,
							window: "fixture-window",
							headroom: "healthy",
						},
					],
				};
			},
			resolveDestination: async destination => {
				if (destination.model === destModel.id && destination.account === DEST_ACCOUNT) return destModel;
				if (destination.model === sourceModel.id && destination.account === SOURCE_ACCOUNT) return sourceModel;
				throw new Error(
					`resolveDestination refused ${destination.provider}/${destination.account}/${destination.model}`,
				);
			},
		});
		const sourceResultPath = path.join(root, "source-result.txt");
		const completeTool = makeTool(COMPLETE_TASK_TOOL, "Completed Task 1", () => {
			effects.completeTask1 += 1;
		});
		const recordTool = makeTool(RECORD_SOURCE_TOOL, "Persist source result", async () => {
			effects.recordSourceResult += 1;
			await fs.writeFile(sourceResultPath, `${SOURCE_RESULT_MARKER}\n`);
			const published = await bindings!.publishSnapshot();
			if (!published.acknowledged) {
				throw new Error("recordRecovery did not acknowledge the current snapshot publication");
			}
		});
		const reviewTool = makeTool(REVIEW_TASK_TOOL, "Unfinished Task 2 review", () => {
			effects.reviewUnfinished += 1;
			const now = performance.now();
			elapsedFirstUsefulActionMs = now - started;
			if (quotaMonotonic !== undefined) {
				firstUsefulActionAtMs = now - quotaMonotonic;
			}
		});
		const preparation: Omit<ContinuationPreparationOptions, "destination"> = {
			retainedInstructions: [RETAINED_INSTRUCTION],
			roleObligations: [ROLE_OBLIGATION],
			discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [bindings.discoveryRef] }],
			readDraft: () => DRAFT_TEXT,
			maxBriefingBytes: 256_000,
			settlementTimeoutMs: 5_000,
		};
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"advisor.enabled": false,
			"retry.enabled": false,
			"memories.enabled": false,
			defaultThinkingLevel: "off",
		});
		const agent = new Agent({
			getApiKey: ({ provider }) => {
				if (provider === "anthropic") return SCRIPTED_KEYS.anthropic;
				if (provider === "openai") return SCRIPTED_KEYS.openai;
				throw new Error(`Unapproved scripted provider: ${provider}`);
			},
			initialState: {
				model: sourceModel,
				systemPrompt: ["PT-01 cross-provider continuation. Scripted endpoints only."],
				tools: [completeTool, recordTool, reviewTool],
				messages: [],
			},
			convertToLlm,
			streamFn: streamSimple,
		});
		const liveSession = new AgentSession({
			agent,
			sessionManager: manager,
			settings,
			modelRegistry,
			toolRegistry: new Map([
				[completeTool.name, completeTool],
				[recordTool.name, recordTool],
				[reviewTool.name, reviewTool],
			]),
			thinkingLevel: ThinkingLevel.Off,
			continuationFactory: run,
			disableExtensionDiscovery: true,
			...(handoff === "automatic" ? { continuationPreparation: preparation } : {}),
		});
		session = liveSession;
		const streamedUsageBySession = new Map<string, StreamedUsageAccumulator>();
		liveSession.subscribe(event => {
			if (event.type !== "message_end") return;
			const message = event.message as { role?: string; usage?: unknown };
			if (message.role !== "assistant" || !isStreamedUsage(message.usage)) return;
			addStreamedUsage(streamedUsageBySession, liveSession.sessionManager.getSessionId(), message.usage);
		});
		const sourceId = session.sessionManager.getSessionId();
		const sourceFile = session.sessionManager.getSessionFile();
		if (!sourceFile) throw new Error("file-backed source session is required");
		const sourceGeneration = run.getState().owner.generation;
		const sourceRunId = run.getState().run.id;

		if (options.interleaving === "instruction-first") {
			await session.sendUserMessage(QUEUED_INSTRUCTION, { deliverAs: "followUp" });
			await session.followUp(QUEUED_DEVELOPER, undefined, { synthetic: true, expandPromptTemplates: false });
		}

		try {
			await session.prompt("Persist the current result then continue Task 2 review.", {
				expandPromptTemplates: false,
				skipCompactionCheck: true,
			});
		} catch (error) {
			if (handoff === "automatic") throw error;
			evidence.sourcePromptError = error instanceof Error ? error.message : String(error);
		}
		await session.waitForIdle();
		if (sourceEndpoint.quotaRequests < 1) {
			throw new Error("Source quota was not recorded at the actual request boundary");
		}
		const sourceRequestsAfterQuota = sourceEndpoint.requests;
		if (session.sessionManager.getSessionId() === sourceId) {
			harvestStreamedUsage(session.agent.state.messages, sourceId, streamedUsageBySession);
		}

		if (options.interleaving === "result-first") {
			await session.sendUserMessage(QUEUED_INSTRUCTION, { deliverAs: "followUp" });
			await session.followUp(QUEUED_DEVELOPER, undefined, { synthetic: true, expandPromptTemplates: false });
		}

		if (handoff === "manual") {
			const activated = await session.continueOnApprovedDestination(preparation);
			if (activated.runId !== sourceRunId) throw new Error("Handoff changed run identity");
			if (activated.sessionId === sourceId) throw new Error("Handoff reused the source session");
			await session.prompt(bindings.nextAction, {
				expandPromptTemplates: false,
				skipCompactionCheck: true,
			});
			await session.waitForIdle();
		} else {
			await session.waitForIdle();
		}

		if (sourceEndpoint.requests !== sourceRequestsAfterQuota) {
			throw new Error("Exhausted source issued further requests after the quota receipt");
		}
		if (effects.completeTask1 !== 0) {
			throw new Error("Destination or source redispatched completed Task 1");
		}
		if (effects.recordSourceResult !== 1) {
			throw new Error("Source did not persist exactly one real result");
		}
		if (effects.reviewUnfinished !== 1) {
			throw new Error("Destination did not execute the unfinished review tool");
		}
		if (firstUsefulActionAtMs === undefined || elapsedFirstUsefulActionMs === undefined) {
			throw new Error("First useful destination action was not observed");
		}
		if (sourceExhaustedAtMs !== 0 || elapsedSourceExhaustedAtMs === undefined) {
			throw new Error("Source exhaustion was not captured at the quota request boundary");
		}
		if (destEndpoint.requests < 1 || destEndpoint.requests > REQUEST_CAP) {
			throw new Error(`Destination request count ${destEndpoint.requests} is outside bounds`);
		}
		if (sourceEndpoint.requests + destEndpoint.requests > REQUEST_CAP) {
			throw new Error("Combined scripted requests exceeded the per-case cap of 64");
		}

		const destPayload = payloadText(destEndpoint.bodies);
		assertDestinationNative(destApi, destEndpoint.bodies);
		if (!destPayload.includes(bindings.nextAction)) throw new Error("Destination missed next action");
		for (const finding of bindings.findings) {
			if (!destPayload.includes(finding)) throw new Error(`Destination missed finding ${finding}`);
		}
		if (!destPayload.includes(bindings.rejectedApproach)) throw new Error("Destination missed rejected approach");
		if (options.interleaving === "instruction-first" || handoff === "manual") {
			if (!destPayload.includes(QUEUED_INSTRUCTION))
				throw new Error("Queued instruction was not delivered to the destination");
		}

		const destSessionId = session.sessionManager.getSessionId();
		if (destSessionId === sourceId) throw new Error("Live session is still the source after continuation");
		if (session.model?.id !== destModel.id || session.model?.api !== destApi) {
			throw new Error("Live session model is not the destination after continuation");
		}
		const inspected = await inspectCommittedRunState({ worktree: root, planPath: planRelative });
		if (inspected.state.run.id !== sourceRunId) throw new Error("Committed run id changed");
		if (inspected.state.owner.sessionId !== destSessionId)
			throw new Error("Committed owner is not the destination session");
		if (inspected.state.owner.generation <= sourceGeneration) throw new Error("Owner generation did not advance");
		const sourceText = await fs.readFile(sourceFile, "utf8");
		if (!sourceText.includes(SOURCE_HISTORY_MARKER)) throw new Error("Predecessor transcript was not retained");
		const destText = await fs.readFile(session.sessionManager.getSessionFile()!, "utf8");
		if (destText.includes(SOURCE_HISTORY_MARKER)) throw new Error("Destination transcript dumped source history");
		const persisted = await fs.readFile(sourceResultPath, "utf8");
		if (!persisted.includes(SOURCE_RESULT_MARKER)) throw new Error("Independent source result evidence is missing");

		const workflowVerification = await bindings.verify();
		const observedKnowledge = knowledgeFromPayload(destPayload, bindings);
		const sourceWorkRequests = sourceEndpoint.requests - sourceEndpoint.quotaRequests;
		const sourceBodyBytes = partitionSourceBodyBytes(sourceEndpoint.bodies, sourceApi);
		const destContextBytes = destEndpoint.bodies.reduce((sum, body) => sum + utf8Bytes(body), 0);
		const destBriefingBytes = briefingBytesFromSession(session.sessionManager);
		harvestStreamedUsage(session.agent.state.messages, destSessionId, streamedUsageBySession);
		const sourceUsage = usageLikeFromAccumulator(streamedUsageBySession.get(sourceId));
		const destUsage = usageLikeFromAccumulator(streamedUsageBySession.get(destSessionId));
		const evaluation = evaluateContinuationTrial({
			version: CONTINUATION_EVALUATION_VERSION,
			trialId: `PT-01-${options.caseId}`,
			measurementScope: "scripted-control",
			capture: CAPTURE,
			lineage: {
				runId: sourceRunId,
				sourceSessionId: sourceId,
				successorSessionIds: [destSessionId],
			},
			requiredKnowledge: [
				{ id: "constraint-no-publish", kind: "constraint", evidence: bindings.protectedConstraint },
				{ id: "finding-open", kind: "finding", evidence: bindings.findings[0]! },
				{ id: "finding-failure", kind: "finding", evidence: bindings.findings[1] ?? bindings.findings[0]! },
				{ id: "rejected-approach", kind: "rejected-approach", evidence: bindings.rejectedApproach },
				{ id: "next-action", kind: "next-action", evidence: bindings.nextAction },
			],
			observedKnowledge,
			completedOperations: [{ id: "task-1", kind: "completed-task" }],
			observedOperations: [{ id: "task-2-review", kind: "review" }],
			requiredObligations: [{ id: "review-task-2", kind: "review" }],
			observedObligations: effects.reviewUnfinished === 1 ? [{ id: "review-task-2", kind: "review" }] : [],
			attempts: [
				{
					id: "source-work",
					kind: "source",
					outcome: "succeeded",
					sessionId: sourceId,
					provider: sourceModel.provider,
					account: SOURCE_ACCOUNT,
					model: sourceModel.id,
					sessionRole: "primary",
					requestCount: sourceWorkRequests,
					contextLoadedBytes: sourceBodyBytes.work,
					...(sourceUsage ? { usage: sourceUsage } : {}),
				},
				{
					id: "source-quota",
					kind: "source",
					outcome: "failed",
					sessionId: sourceId,
					provider: sourceModel.provider,
					account: SOURCE_ACCOUNT,
					model: sourceModel.id,
					sessionRole: "primary",
					reason: "usage-limit",
					requestCount: sourceEndpoint.quotaRequests,
					contextLoadedBytes: sourceBodyBytes.quota,
				},
				...run.getState().rejectedAttempts.map(rejected => ({
					id: `rejected-${rejected.id}`,
					kind: "destination" as const,
					outcome: "rejected" as const,
					reason: rejected.reason,
				})),
				{
					id: "destination",
					kind: "destination",
					outcome: "succeeded",
					sessionId: destSessionId,
					provider: destModel.provider,
					account: DEST_ACCOUNT,
					model: destModel.id,
					sessionRole: "primary",
					requestCount: destEndpoint.requests,
					firstUsefulActionAtMs,
					contextLoadedBytes: destContextBytes,
					...(destBriefingBytes === undefined ? {} : { briefingBytes: destBriefingBytes }),
					...(destUsage ? { usage: destUsage } : {}),
				},
			],
			sourceExhaustedAtMs,
			sourceRolloverAtMs: SOURCE_ROLLOVER_MS,
		});
		if (evaluation.verdict.result !== "pass") {
			throw new Error(
				`evaluateContinuationTrial ${evaluation.verdict.result}: ${evaluation.verdict.reasons.join("; ")}`,
			);
		}
		Object.assign(evidence, {
			runId: sourceRunId,
			sourceSessionId: sourceId,
			destinationSessionId: destSessionId,
			sourceGeneration,
			destinationGeneration: inspected.state.owner.generation,
			policyRevision: POLICY_REVISION,
			sourceRequests: sourceEndpoint.requests,
			sourceWorkRequests,
			destinationRequests: destEndpoint.requests,
			quotaRequests: sourceEndpoint.quotaRequests,
			sourceWorkBytes: sourceBodyBytes.work,
			sourceQuotaBytes: sourceBodyBytes.quota,
			destinationContextBytes: destContextBytes,
			destinationBriefingBytes: destBriefingBytes,
			sourceStreamedUsage: sourceUsage ?? null,
			destinationStreamedUsage: destUsage ?? null,
			rejectedAttempts: run.getState().rejectedAttempts,
			toolEffects: { ...effects },
			elapsedFirstUsefulActionMs,
			elapsedSourceExhaustedAtMs,
			sourceExhaustedAtMs,
			sourceRolloverAtMs: SOURCE_ROLLOVER_MS,
			workflowVerification,
			evaluation,
			destinationPayloadHasConstraint: destPayload.includes(bindings.protectedConstraint),
			destinationPayloadHasHistoryDump: destPayload.includes(SOURCE_HISTORY_MARKER),
			sourcePayloads: sourceEndpoint.bodies,
			destinationPayloads: destEndpoint.bodies,
		});
		result = {
			caseId: options.caseId,
			evaluation,
			sourceRequests: sourceEndpoint.requests,
			destinationRequests: destEndpoint.requests,
			elapsedFirstUsefulActionMs,
			workflowVerification,
		};
	} catch (error) {
		failure = error;
		evidence.failure =
			error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
		evidence.toolEffects = { ...effects };
		evidence.sourceRequests = sourceEndpoint?.requests;
		evidence.destinationRequests = destEndpoint?.requests;
		evidence.elapsedSourceExhaustedAtMs = elapsedSourceExhaustedAtMs;
		evidence.sourceExhaustedAtMs = sourceExhaustedAtMs;
		evidence.sourcePayloads = sourceEndpoint?.bodies;
		evidence.destinationPayloads = destEndpoint?.bodies;
		evidence.sessionError = session?.agent.state.error;
		evidence.sessionMessages = session?.agent.state.messages;
		evidence.ownerState = run?.getState();
	}

	const rememberCleanup = (label: string, error: unknown) => {
		cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
	};
	try {
		await bindings?.cleanup();
	} catch (error) {
		rememberCleanup("workflow", error);
	}
	try {
		const retained = evidenceDir();
		if (retained) {
			const artifacts = path.join(retained, `pt01-${options.caseId.toLowerCase()}-artifacts`);
			await fs.cp(root, artifacts, { recursive: true });
			const currentFile = run?.getState().owner.sessionFile;
			if (currentFile) {
				const currentBytes = await fs.readFile(currentFile);
				const retainedBytes = await fs.readFile(path.join(artifacts, path.relative(root, currentFile)));
				if (!currentBytes.equals(retainedBytes))
					throw new Error("Retained owner transcript differs from its source");
			}
			evidence.artifacts = { originalRoot: root, retainedRoot: artifacts };
		}
	} catch (error) {
		rememberCleanup("retaining-artifacts", error);
	}
	try {
		await session?.dispose();
	} catch (error) {
		rememberCleanup("session", error);
	}
	try {
		await run?.close();
	} catch (error) {
		rememberCleanup("run", error);
	}
	try {
		await manager?.close();
	} catch (error) {
		rememberCleanup("manager", error);
	}
	try {
		authStorage?.close();
	} catch (error) {
		rememberCleanup("auth", error);
	}
	try {
		await sourceEndpoint?.stop();
	} catch (error) {
		rememberCleanup("source-endpoint", error);
	}
	try {
		await destEndpoint?.stop();
	} catch (error) {
		rememberCleanup("destination-endpoint", error);
	}
	try {
		await dir.remove();
	} catch (error) {
		rememberCleanup("workdir", error);
	}
	evidence.cleanupErrors = cleanupErrors;
	await writePt01Evidence(`pt01-${options.caseId.toLowerCase()}`, evidence);
	if (failure) throw failure;
	if (cleanupErrors.length > 0) {
		throw new Error(`cleanup failed: ${cleanupErrors.join("; ")}`);
	}
	if (!result) throw new Error("case produced no result");
	return result;
}
