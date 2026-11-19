/**
 * Shared PT-00 portable-session fixture. Workflow helpers come from
 * CONTINUATION_SJUJPERPOWERS_SOURCE; missing source fails closed.
 * Scripted localhost Anthropic Messages only — not model competence.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, ThinkingLevel, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { streamSimple, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { openContinuationRun, type ContinuationRun } from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import type { ContinuationPolicyV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-policy";
import { sha256Bytes, type ContinuationDurableIo } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";
import { anthropicSse } from "./scripted-providers";
import { recordRecovery } from "../../../../../.continuation-workflow/skills/tracking-providers/scripts/record-recovery.mjs";
import { exportRecovery } from "../../../../../.continuation-workflow/skills/tracking-providers/scripts/export-recovery.mjs";

export const PLAN_RELATIVE = "docs/project/plans/feature.md";
export const SOURCE_HISTORY_MARKER = "SOURCE_HISTORY_MUST_NOT_REPLAY";
export const PROTECTED_CONSTRAINT = "PROTECTED_CONSTRAINT";
export const OPEN_FINDING = "OPEN_FINDING";
export const REJECTED_APPROACH = "REJECTED_APPROACH";
export const REJECTED_REASON = "Violates PROTECTED_CONSTRAINT";
export const NEXT_ACTION = "Resume Task 2 review and address OPEN_FINDING without REJECTED_APPROACH";
export const QUEUED_INSTRUCTION = "QUEUED_SUBMITTED_INSTRUCTION";
export const ROLE_OBLIGATION = "ROLE_OBLIGATION_REVIEWER";
export const RETAINED_INSTRUCTION = "RETAINED_INSTRUCTION_NO_PUBLISH";
export const DRAFT_TEXT = "UNSENT_DESTINATION_DRAFT_MUST_NOT_TRANSMIT";
export const DISCOVERY_SUMMARY = "DISCOVERY_REVIEW_BASE_PRESERVED";
export const FIXTURE_ACCOUNT = "fixture-account";
export const FIXTURE_SCOPE = "fixture";
export const REQUEST_CAP = 32;
export const CASE_TIMEOUT_MS = 30_000;
export const COMPLETE_TASK_TOOL = "complete_task_1";
export const REVIEW_TASK_TOOL = "review_unfinished";

export const PLAN = `# Portable Session Continuation Implementation Plan

**Spec:** \`docs/project/specs/portable.md\`

**Source:** plane:PT-00

## Global Constraints

- ${PROTECTED_CONSTRAINT}
- Exact next action is ${NEXT_ACTION}

---

### Task 1: Completed unlanded work

Task 1 produced the reviewed base. Do not redispatch. Landing remains outstanding.

### Task 2: Review unfinished work

${NEXT_ACTION}

### Task 3: Pending follow-on

Task 3 stays pending until Task 2 review lands.
`;

export interface RecoveryHelpers {
	recordRecovery: typeof recordRecovery;
	exportRecovery: typeof exportRecovery;
	source: string;
}

export interface ToolEffects {
	completeTask1: number;
	reviewUnfinished: number;
}

export interface ScriptedEndpoint {
	origin: string;
	requests: number;
	bodies: string[];
	stop(): Promise<void>;
	rejectNext(status: number, body: string): void;
	respondNext(response: Response): void;
}

export interface PortableHarness {
	root: string;
	sessionsDir: string;
	planPath: string;
	model: Model;
	policy: ContinuationPolicyV1;
	effects: ToolEffects;
	endpoint: ScriptedEndpoint;
	manager: SessionManager;
	run: ContinuationRun;
	session: AgentSession;
	authStorage: AuthStorage;
	discoveryRef: { kind: "file"; path: string; byteLength: number; sha256: string };
	cleanup(): Promise<void>;
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

export function requireWorkflowSource(): string {
	const source = process.env.CONTINUATION_SJUJPERPOWERS_SOURCE;
	if (!source || source.trim() === "") {
		throw new Error("CONTINUATION_SJUJPERPOWERS_SOURCE is required; refusing to substitute a fixture projection");
	}
	return source;
}

let helpers: RecoveryHelpers | undefined;

export async function loadSjujperpowersRecovery(): Promise<RecoveryHelpers> {
	if (helpers) return helpers;
	const source = requireWorkflowSource();
	helpers = { recordRecovery, exportRecovery, source };
	return helpers;
}

export function anthropicToolUseSse(name: string, args: Record<string, unknown>): Response {
	const json = JSON.stringify(args);
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_cont_tool",
				usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_review", name, input: {} },
		},
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 1 },
		},
		{ type: "message_stop" },
	];
	return new Response(
		`${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": "req_cont_tool" },
		},
	);
}

export function startScriptedEndpoint(firstTool = REVIEW_TASK_TOOL): ScriptedEndpoint {
	const bodies: string[] = [];
	let requests = 0;
	let nextResponse: Response | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			requests += 1;
			if (requests > REQUEST_CAP) {
				return new Response("PT-00 request cap exceeded", { status: 429 });
			}
			const body = await request.text();
			bodies.push(body);
			let parsed: { messages?: unknown[] } = {};
			try {
				parsed = JSON.parse(body) as { messages?: unknown[] };
			} catch {
				return new Response("invalid json", { status: 400 });
			}
			if (nextResponse) {
				const response = nextResponse;
				nextResponse = undefined;
				return response;
			}
			const encoded = JSON.stringify(parsed.messages ?? []);
			if (encoded.includes("tool_result") || encoded.includes("toolu_review")) {
				return anthropicSse("scripted-unfinished-ack");
			}
			return anthropicToolUseSse(requests === 1 ? firstTool : REVIEW_TASK_TOOL, {});
		},
	});
	const origin = server.url.origin;
	return {
		origin,
		get requests() {
			return requests;
		},
		bodies,
		rejectNext(status, body) {
			nextResponse = new Response(body, { status, headers: { "content-type": "application/json" } });
		},
		respondNext(response) {
			nextResponse = response;
		},
		async stop() {
			await server.stop(true);
		},
	};
}

function makeTool(name: string, label: string, onRun: (signal?: AbortSignal) => void | Promise<void>): AgentTool {
	return {
		name,
		label,
		description: label,
		parameters: type({}),
		execute: async (_id, _params, signal) => {
			await onRun(signal);
			return { content: [{ type: "text", text: `${name}-effect` }] };
		},
	};
}

export function payloadText(bodies: readonly string[]): string {
	return bodies.join("\n");
}

export function evidenceDir(): string | undefined {
	const dir = process.env.CONTINUATION_PT00_EVIDENCE_DIR ?? process.env.CONTINUATION_EVIDENCE_DIR;
	return dir && dir.trim() !== "" ? dir : undefined;
}

export async function writeCaseEvidence(name: string, evidence: Record<string, unknown>): Promise<void> {
	const dir = evidenceDir();
	if (!dir) return;
	await fs.mkdir(dir, { recursive: true });
	const body = {
		...evidence,
		competenceClaim: false,
		note: "Scripted localhost Anthropic Messages; not a semantic model evaluation.",
	};
	await fs.writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`);
}

export async function openPortableHarness(
	ownerIo?: ContinuationDurableIo,
	options: { foregroundWrite?: (signal?: AbortSignal) => Promise<void>; asyncJobs?: boolean } = {},
): Promise<PortableHarness> {
	const { recordRecovery, exportRecovery } = await loadSjujperpowersRecovery();
	const dir = TempDir.createSync("pt00-portable-session");
	const root = await fs.realpath(dir.path());
	const sessionsDir = path.join(root, "sessions");
	const planPath = path.join(root, PLAN_RELATIVE);
	await fs.mkdir(path.dirname(planPath), { recursive: true });
	await fs.writeFile(planPath, PLAN);
	const discoveryPath = path.join(root, "docs/project/evidence/discovery.txt");
	await fs.mkdir(path.dirname(discoveryPath), { recursive: true });
	const discoveryBytes = Buffer.from(`${DISCOVERY_SUMMARY}\n`, "utf8");
	await fs.writeFile(discoveryPath, discoveryBytes);
	const discoveryRef = {
		kind: "file" as const,
		path: await fs.realpath(discoveryPath),
		byteLength: discoveryBytes.byteLength,
		sha256: sha256Bytes(discoveryBytes),
	};

	const recorded = await recordRecovery({
		root,
		planPath,
		config: sessionConfig(),
		event: {
			workflow: "inline",
			current: { task: 2, phase: "review", round: 1, nextAction: NEXT_ACTION },
			tasks: [
				{ number: 1, state: "complete", phase: "complete", round: null, nextAction: null },
				{ number: 2, state: "review", phase: "review", round: 1, nextAction: NEXT_ACTION },
				{ number: 3, state: "pending", phase: "execute", round: null, nextAction: null },
			],
			findings: [{ id: "finding-open", task: 2, status: "open", summary: OPEN_FINDING, evidence: [] }],
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
					contents: `open finding: ${OPEN_FINDING}\n`,
				},
			],
		},
	});
	if (!recorded.acknowledged) {
		throw new Error("recordRecovery did not acknowledge the current snapshot publication");
	}

	const effects: ToolEffects = { completeTask1: 0, reviewUnfinished: 0 };
	const endpoint = startScriptedEndpoint(options.foregroundWrite ? "foreground_write" : REVIEW_TASK_TOOL);
	const model = buildModel({
		provider: "anthropic",
		api: "anthropic-messages",
		id: "pt00-scripted-sonnet",
		name: "PT-00 scripted Anthropic",
		baseUrl: endpoint.origin,
		reasoning: false,
		input: ["text"],
		contextWindow: 32_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const policy: ContinuationPolicyV1 = {
		version: 1,
		revision: "pt00-policy",
		roles: ["primary", "worker", "advisor", "maintenance"],
		dataScope: FIXTURE_SCOPE,
		candidates: [
			{
				provider: model.provider,
				account: FIXTURE_ACCOUNT,
				model: model.id,
				endpoint: model.baseUrl,
				roles: ["primary", "worker", "advisor", "maintenance"],
				settings: { thinkingLevel: "off" },
				dataScope: FIXTURE_SCOPE,
			},
		],
		unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
		attemptBudget: 16,
		restrictedAccounts: [],
	};

	const manager = SessionManager.create(root, sessionsDir);
	manager.appendMessage({
		role: "user",
		content: SOURCE_HISTORY_MARKER,
		timestamp: 1,
	});
	await manager.ensureOnDisk();
	await manager.setSessionName("pt-00-source", "user");

	const run = await openContinuationRun({
		sessionManager: manager,
		ownerOptions: ownerIo ? { io: ownerIo } : undefined,
		planPath: PLAN_RELATIVE,
		policy,
		source: policy.candidates[0]!,
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
		observeRequest: async (_request, _sessionId) => ({
			account: FIXTURE_ACCOUNT,
			dataScope: FIXTURE_SCOPE,
			contextTokens: 8_192,
			allowances: [
				{
					provider: model.provider,
					account: FIXTURE_ACCOUNT,
					window: "fixture-window",
					headroom: "healthy" as const,
				},
			],
		}),
	});

	const completeTool = makeTool(COMPLETE_TASK_TOOL, "Completed Task 1", () => {
		effects.completeTask1 += 1;
	});
	const reviewTool = makeTool(REVIEW_TASK_TOOL, "Unfinished Task 2 review", () => {
		effects.reviewUnfinished += 1;
	});
	const tools = [completeTool, reviewTool];
	if (options.foregroundWrite) {
		tools.push(makeTool("foreground_write", "Finish an already-started foreground write", options.foregroundWrite));
	}
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "synthetic-local-fixture");
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"advisor.enabled": false,
		"retry.enabled": false,
		"memories.enabled": false,
		defaultThinkingLevel: "off",
	});
	const asyncJobManager = options.asyncJobs ? new AsyncJobManager({ onJobComplete: () => {} }) : undefined;
	const agent = new Agent({
		getApiKey: () => "synthetic-local-fixture",
		initialState: {
			model,
			systemPrompt: ["PT-00 portable continuation. Scripted endpoint only."],
			tools,
			messages: [],
		},
		convertToLlm,
		streamFn: streamSimple,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		thinkingLevel: ThinkingLevel.Off,
		agentId: asyncJobManager ? "pt00-owner" : undefined,
		ownedAsyncJobManager: asyncJobManager,
		continuationFactory: run,
		disableExtensionDiscovery: true,
	});
	await session.whenContinuationReady();

	let cleaned = false;
	return {
		root,
		sessionsDir,
		planPath,
		model,
		policy,
		effects,
		endpoint,
		manager,
		run,
		session,
		authStorage,
		discoveryRef,
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			try {
				await session.dispose();
			} catch {
				// Dispose still has to release the run lock below.
			}
			try {
				await run.close();
			} catch {
				//
			}
			try {
				await manager.close();
			} catch {
				//
			}
			authStorage.close();
			await endpoint.stop();
			await dir.remove();
		},
	};
}
