import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { streamSimple, type FetchImpl } from "@oh-my-pi/pi-ai";
import { type } from "@oh-my-pi/omptype";
import type { AdmissionOutcome, ContinuationSessionBinding } from "../../../src/session/continuation-binding";
import { openContinuationRun, type ContinuationRun } from "../../../src/session/continuation-controller";
import type { ContinuationHandoffInputs } from "../../../src/session/continuation-handoff";
import type { ContinuationPolicyV1 } from "../../../src/session/continuation-policy";
import { bindContinuationStream, ContinuationAdmissionError } from "../../../src/session/continuation-request";
import {
	createNodeDurableIo,
	sha256Bytes,
	type ContinuationDurableIo,
	type DurableFrontier,
	type OperatorIntent,
} from "../../../src/session/continuation-store";
import type { WorkProjectionV1 } from "../../../src/session/continuation-work";
import { SessionManager } from "../../../src/session/session-manager";
import { continuationModel, CURRENT_TASK_BRIEF } from "../../helpers/continuation-fixture";
import { makeAssistantMessage } from "../../session-manager/helpers";

export const CRASH_PLAN =
	"# Controller Implementation Plan\n\n## Global Constraints\n\n- PROTECTED_CONSTRAINT\n\n### Task 1: Completed work\nDo not repeat.\n\n### Task 2: Review\nResolve OPEN_FINDING without REJECTED_APPROACH.\n";
export const CRASH_EFFECT_TEXT = "KNOWN_COMPLETED_EFFECT";

export type CrashMode = "f1-evidence-before-frontier" | "f5-effect-before-result" | "reload-paused";

export interface CrashProcessConfig {
	mode: CrashMode;
	root: string;
	enrolledPath?: string;
	readyPath: string;
	resultPath: string;
	sessionFile?: string;
	recoverRunId?: string;
}

export interface CrashEnrolledPayload {
	runId: string;
	sessionId: string;
	sessionFile: string;
	generation: number;
	intent: OperatorIntent;
	frontier: DurableFrontier;
	pendingEffectIds: string[];
	committedEventCount: number;
	committedTransitionCount: number;
}

export interface CrashReadyPayload {
	crashedAt: "after-evidence-before-frontier" | "after-effect-before-result";
	pid: number;
	evidencePaths: string[];
	targetPath: string;
}

export interface PausedReloadAdmission {
	kind: string;
	reason?: string;
	attention?: boolean;
	provider?: string;
	account?: string;
}

export interface PausedReloadAttempt {
	name: string;
	message: string;
	outcomeKind?: string;
}

export interface PausedReloadHandoff {
	refused: boolean;
	reason?: string;
	kind?: string;
	candidateCount?: number;
}

export interface PausedReloadPayload {
	ok: boolean;
	pid: number;
	runId?: string;
	sessionId?: string;
	sessionFile?: string;
	generation?: number;
	intent?: OperatorIntent;
	owner?: { sessionId: string; sessionFile: string; generation: number };
	startup?: PausedReloadAdmission;
	maintenance?: PausedReloadAdmission;
	quotaRecovery?: PausedReloadAdmission;
	handoff?: PausedReloadHandoff;
	primaryStream?: PausedReloadAttempt;
	maintenanceStream?: PausedReloadAttempt;
	localhostInferenceAttempts: number;
	localhostServerHits: number;
	error?: { name?: string; message: string };
}

interface LocalhostInferenceListener {
	stop(): void;
}

export function crashEffectPath(root: string): string {
	return path.join(root, "actual-effect.txt");
}

export function crashToolCallsPath(root: string): string {
	return path.join(root, "tool-calls.json");
}

function crashProjection(root: string): WorkProjectionV1 {
	const brief = {
		kind: "regenerated" as const,
		task: 2,
		text: CURRENT_TASK_BRIEF,
		byteLength: Buffer.byteLength(CURRENT_TASK_BRIEF, "utf8"),
		sha256: sha256Bytes(CURRENT_TASK_BRIEF),
	};
	return {
		version: 1,
		plan: { root, relativePath: "plan.md", sha256: sha256Bytes(CRASH_PLAN) },
		workflow: "inline",
		execution: { provider: "session", completion: "landed" },
		revision: 1,
		constraints: ["PROTECTED_CONSTRAINT"],
		current: { task: 2, phase: "review", round: 1, nextAction: "Resolve OPEN_FINDING" },
		tasks: [
			{
				number: 1,
				title: "Completed work",
				state: "complete",
				phase: "complete",
				round: null,
				nextAction: null,
				brief: null,
				report: null,
				reviewPackage: null,
				claim: null,
				commits: { base: null, head: null },
			},
			{
				number: 2,
				title: "Review",
				state: "review",
				phase: "review",
				round: 1,
				nextAction: "Resolve OPEN_FINDING",
				brief,
				report: null,
				reviewPackage: null,
				claim: null,
				commits: { base: null, head: null },
			},
		],
		findings: [{ id: "finding", task: 2, status: "open", summary: "OPEN_FINDING", evidence: [] }],
		decisions: [],
		rejectedApproaches: [
			{
				id: "rejected",
				task: 2,
				summary: "REJECTED_APPROACH",
				reason: "Violates PROTECTED_CONSTRAINT",
				evidence: [],
			},
		],
		evidence: [],
		claims: [],
		todos: [
			{ id: "done", content: "Completed work", status: "completed" },
			{ id: "review", content: "Resolve OPEN_FINDING", status: "in_progress" },
		],
		recovery: { eligible: true, status: "eligible", blockers: [], capabilities: ["fresh-handoff"] },
	};
}

function crashPolicy(): ContinuationPolicyV1 {
	return {
		version: 1,
		revision: "fixture-policy",
		roles: ["primary", "worker", "advisor", "maintenance"],
		dataScope: "fixture",
		candidates: [
			{
				provider: continuationModel.provider,
				account: "fixture-account",
				model: continuationModel.id,
				endpoint: continuationModel.baseUrl,
				roles: ["primary", "worker", "advisor", "maintenance"],
				settings: {},
				dataScope: "fixture",
			},
		],
		unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
		attemptBudget: 2,
		restrictedAccounts: [],
	};
}

export async function openCrashContinuationRun(args: {
	root: string;
	sessionManager: SessionManager;
	io?: ContinuationDurableIo;
	recoverRunId?: string;
}): Promise<ContinuationRun> {
	const projection = crashProjection(args.root);
	const policy = crashPolicy();
	return openContinuationRun({
		sessionManager: args.sessionManager,
		planPath: "plan.md",
		policy,
		source: policy.candidates[0]!,
		workflow: { id: "fixture", exportProjection: async () => structuredClone(projection) },
		observeRequest: async () => ({
			account: "fixture-account",
			dataScope: "fixture",
			contextTokens: 100,
			allowances: [
				{
					provider: continuationModel.provider,
					account: "fixture-account",
					window: "fixture-window",
					headroom: "healthy",
				},
			],
		}),
		recoverRunId: args.recoverRunId,
		ownerOptions: args.io ? { io: args.io } : undefined,
	});
}

function writeJsonSync(filePath: string, payload: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`);
	const fd = fs.openSync(filePath, "r");
	fs.fsyncSync(fd);
	fs.closeSync(fd);
}

function terminateAtBoundary(readyPath: string, payload: CrashReadyPayload): never {
	writeJsonSync(readyPath, payload);
	process.kill(process.pid, "SIGKILL");
	throw new Error("SIGKILL did not terminate the crash child");
}

function enrolledPayload(run: ContinuationRun, sessionManager: SessionManager): CrashEnrolledPayload {
	const state = run.getState();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Crash child requires a file-backed session");
	return {
		runId: state.run.id,
		sessionId: sessionManager.getSessionId(),
		sessionFile,
		generation: state.owner.generation,
		intent: state.intent,
		frontier: state.frontier,
		pendingEffectIds: state.pendingEffects.map(effect => effect.id),
		committedEventCount: state.committedEvents.length,
		committedTransitionCount: state.committedTransitions.length,
	};
}

function serializeAdmission(outcome: AdmissionOutcome): PausedReloadAdmission {
	if (outcome.kind === "allow") return { kind: "allow" };
	if (outcome.kind === "handoff-required") {
		return { kind: "handoff-required", reason: outcome.reason, provider: outcome.provider, account: outcome.account };
	}
	if (outcome.kind === "defer") return { kind: "defer", reason: outcome.reason };
	return { kind: "stop", reason: outcome.reason, attention: outcome.attention };
}

async function captureAdmission(work: () => Promise<unknown>): Promise<PausedReloadAdmission> {
	try {
		await work();
		return { kind: "allow" };
	} catch (error) {
		if (error instanceof ContinuationAdmissionError) return serializeAdmission(error.outcome);
		return { kind: "unexpected-throw", reason: error instanceof Error ? error.message : String(error) };
	}
}

async function capturePausedStream(
	binding: ContinuationSessionBinding,
	fetch: FetchImpl,
): Promise<PausedReloadAttempt> {
	const stream = bindContinuationStream(streamSimple, binding.requestBoundary, binding.role);
	try {
		const events = await stream(
			continuationModel,
			{ messages: [{ role: "user", content: "paused-reload", timestamp: 1 }] },
			{ apiKey: "paused-reload-must-not-send", fetch },
		);
		await events.result();
		return { name: "Completed", message: "stream completed without admission denial" };
	} catch (error) {
		return {
			name: error instanceof Error ? error.name : "ThrownValue",
			message: error instanceof Error ? error.message : String(error),
			outcomeKind: error instanceof ContinuationAdmissionError ? error.outcome.kind : undefined,
		};
	}
}

async function reloadPausedOwner(config: CrashProcessConfig): Promise<boolean> {
	if (!config.sessionFile || !config.recoverRunId) {
		throw new Error("reload-paused requires sessionFile and recoverRunId");
	}
	let localhostInferenceAttempts = 0;
	let localhostServerHits = 0;
	let server: LocalhostInferenceListener | undefined;
	const endpoint = new URL(continuationModel.baseUrl);
	try {
		server = Bun.serve({
			hostname: endpoint.hostname,
			port: endpoint.port ? Number(endpoint.port) : 0,
			fetch() {
				localhostServerHits++;
				return new Response(JSON.stringify({ error: "paused owner must not infer" }), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			},
		});
	} catch {
		server = undefined;
	}
	const countingFetch: FetchImpl = async (input, init) => {
		localhostInferenceAttempts++;
		return globalThis.fetch(input as string | URL | Request, init);
	};
	let manager: SessionManager | undefined;
	let run: ContinuationRun | undefined;
	try {
		const sessionManager = await SessionManager.open(
			config.sessionFile,
			path.join(config.root, "sessions"),
			undefined,
			{
				initialCwd: config.root,
				suppressBreadcrumb: true,
			},
		);
		manager = sessionManager;
		run = await openCrashContinuationRun({
			root: config.root,
			sessionManager,
			recoverRunId: config.recoverRunId,
		});
		const state = run.getState();
		writeJsonSync(config.readyPath, {
			ok: true,
			pid: process.pid,
			runId: state.run.id,
			sessionId: state.owner.sessionId,
			generation: state.owner.generation,
			intent: state.intent,
		});
		const primary = run.bindSession(sessionManager, "primary");
		const maintenance = primary.forRole("maintenance", "maintenance");
		const startup = serializeAdmission(await primary.beforeRecovery());
		const quotaRecovery = serializeAdmission(await primary.beforeRecovery());
		const maintenanceAdmission = await captureAdmission(() =>
			maintenance.requestBoundary.admit({
				role: "maintenance",
				model: continuationModel,
				context: { messages: [{ role: "user", content: "paused-reload-maintenance", timestamp: 1 }] },
				options: { sessionId: sessionManager.getSessionId() },
			}),
		);
		const primaryStream = await capturePausedStream(primary, countingFetch);
		const maintenanceStream = await capturePausedStream(maintenance, countingFetch);
		let handoff: PausedReloadHandoff = { refused: true };
		try {
			if (!primary.handoff) throw new Error("paused primary is missing handoff");
			const candidates = await primary.handoff.candidates();
			handoff = { refused: true, candidateCount: candidates.length };
			await primary.handoff.begin();
			handoff = { refused: false, candidateCount: candidates.length, reason: "begin succeeded" };
		} catch (error) {
			if (error instanceof ContinuationAdmissionError) {
				handoff = {
					refused: true,
					kind: error.outcome.kind,
					reason: error.outcome.reason,
					candidateCount: handoff.candidateCount,
				};
			} else {
				throw error;
			}
		}
		const after = run.getState();
		const ok =
			after.intent.kind === "pause" &&
			startup.kind === "defer" &&
			quotaRecovery.kind === "defer" &&
			maintenanceAdmission.kind === "defer" &&
			primaryStream.outcomeKind === "defer" &&
			maintenanceStream.outcomeKind === "defer" &&
			handoff.refused === true &&
			localhostInferenceAttempts === 0 &&
			localhostServerHits === 0 &&
			after.owner.sessionId === state.owner.sessionId &&
			after.run.id === config.recoverRunId;
		writeJsonSync(config.resultPath, {
			ok,
			pid: process.pid,
			runId: after.run.id,
			sessionId: sessionManager.getSessionId(),
			sessionFile: sessionManager.getSessionFile() ?? undefined,
			generation: after.owner.generation,
			intent: after.intent,
			owner: after.owner,
			startup,
			maintenance: maintenanceAdmission,
			quotaRecovery,
			handoff,
			primaryStream,
			maintenanceStream,
			localhostInferenceAttempts,
			localhostServerHits,
		} satisfies PausedReloadPayload);
		return ok;
	} catch (error) {
		writeJsonSync(config.resultPath, {
			ok: false,
			pid: process.pid,
			localhostInferenceAttempts,
			localhostServerHits,
			error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
		} satisfies PausedReloadPayload);
		if (!fs.existsSync(config.readyPath)) writeJsonSync(config.readyPath, { ok: false, pid: process.pid });
		return false;
	} finally {
		await run?.close().catch(() => undefined);
		await manager?.close().catch(() => undefined);
		server?.stop();
	}
}

if (import.meta.main) {
	const configPath = Bun.argv[2];
	if (!configPath) throw new Error("run-crash-process requires a config path");
	const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as CrashProcessConfig;
	if (config.mode === "reload-paused") {
		const ok = await reloadPausedOwner(config);
		process.exit(ok ? 0 : 1);
	}
	const enrolledPath = config.enrolledPath;
	if (!enrolledPath) throw new Error("crash modes require enrolledPath");
	const realIo = createNodeDurableIo();
	let armed = false;
	let evidenceSynced = false;
	let effectApplied = false;
	const evidencePaths: string[] = [];
	const io: ContinuationDurableIo = {
		...realIo,
		async writeFileExclusive(filePath, data, options) {
			if (armed) evidencePaths.push(filePath);
			if (
				config.mode === "f5-effect-before-result" &&
				armed &&
				effectApplied &&
				path.basename(filePath).startsWith("effect-result-")
			) {
				terminateAtBoundary(config.readyPath, {
					crashedAt: "after-effect-before-result",
					pid: process.pid,
					evidencePaths: [...evidencePaths],
					targetPath: filePath,
				});
			}
			return realIo.writeFileExclusive(filePath, data, options);
		},
		async fsyncFile(filePath) {
			await realIo.fsyncFile(filePath);
			if (armed) evidenceSynced = true;
		},
		async rename(from, to) {
			if (
				config.mode === "f1-evidence-before-frontier" &&
				armed &&
				evidenceSynced &&
				path.basename(to) === "state.json"
			) {
				terminateAtBoundary(config.readyPath, {
					crashedAt: "after-evidence-before-frontier",
					pid: process.pid,
					evidencePaths: [...evidencePaths],
					targetPath: to,
				});
			}
			return realIo.rename(from, to);
		},
	};

	const planPath = path.join(config.root, "plan.md");
	if (!fs.existsSync(planPath)) fs.writeFileSync(planPath, CRASH_PLAN);
	let sessionManager = SessionManager.create(config.root, path.join(config.root, "sessions"));
	sessionManager.appendMessage(makeAssistantMessage());
	await sessionManager.ensureOnDisk();
	const run = await openCrashContinuationRun({ root: config.root, sessionManager, io });
	if (config.mode === "f5-effect-before-result") {
		const handoff = run.bindSession(sessionManager, "primary").handoff!;
		const inputs: ContinuationHandoffInputs = {
			model: continuationModel,
			context: { messages: [] },
			retainedInstructions: ["Do not repeat completed work."],
			roleObligations: ["Finish the review."],
			discoveries: [],
			queuedMessages: [],
			draft: null,
			maxBriefingBytes: 256_000,
			services: [],
		};
		const ticket = await handoff.begin();
		const staged = await handoff.prepare(ticket, inputs);
		const activated = await handoff.commit(staged, inputs);
		await sessionManager.close();
		sessionManager = await SessionManager.open(activated.sessionFile, path.join(config.root, "sessions"));
		handoff.adopt(sessionManager);
	}
	writeJsonSync(enrolledPath, enrolledPayload(run, sessionManager));
	armed = true;

	try {
		if (config.mode === "f1-evidence-before-frontier") {
			await run.setIntent({ kind: "pause", reason: "f1-unpublished" });
			writeJsonSync(config.resultPath, { ok: true, error: "F1 child published the frontier instead of crashing" });
			await run.close();
			process.exit(1);
		}

		const calls: string[] = [];
		const makeTool = (name: string): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: type({}),
			concurrency: "exclusive",
			execute: async () => {
				calls.push(name);
				writeJsonSync(crashToolCallsPath(config.root), calls);
				await fs.promises.writeFile(crashEffectPath(config.root), CRASH_EFFECT_TEXT);
				effectApplied = true;
				return { content: [{ type: "text", text: CRASH_EFFECT_TEXT }], details: { effect: name } };
			},
		});
		const agent = new Agent({
			initialState: {
				model: continuationModel,
				systemPrompt: ["Fixture"],
				tools: [makeTool("first"), makeTool("second")],
				messages: [
					{
						...makeAssistantMessage(),
						api: continuationModel.api,
						provider: continuationModel.provider,
						model: continuationModel.id,
						stopReason: "toolUse",
						content: [
							{ type: "toolCall", id: "first-call", name: "first", arguments: {} },
							{ type: "toolCall", id: "second-call", name: "second", arguments: {} },
						],
					},
				],
			},
			toolExecutionBoundary: run.bindSession(sessionManager, "primary").toolBoundary,
			streamFn: async () => {
				throw new Error("No model call belongs in this failed tool batch");
			},
		});
		await agent.continue();
		writeJsonSync(config.resultPath, {
			ok: true,
			error: "F5 child settled the destination effect instead of crashing",
		});
		await run.close();
		process.exit(1);
	} catch (error) {
		writeJsonSync(config.resultPath, {
			ok: false,
			error: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) },
		});
		await run.close().catch(() => undefined);
		process.exit(1);
	}
}
