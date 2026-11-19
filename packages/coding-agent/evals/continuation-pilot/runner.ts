import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Agent, ThinkingLevel, type AgentMessage, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { streamSimple, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { openContinuationRun, type ContinuationRun } from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import type { ContinuationPolicyV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-policy";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { registerContinuationTransport } from "../../src/session/continuation-request";
import { Database } from "bun:sqlite";
import type { PilotManifest, PilotModel, PilotStrategy, PilotWorkload } from "./contract";
import { createPilotWorkload } from "./workload";
import approvedLiveManifest from "./live-manifest.json";

const GATEWAY_ORIGIN = "http://pilot-gateway";
const DUMMY_API_KEY = "pilot-gateway-dummy-key";
const LIVE_DISPATCH_BLOCKED =
	"Live pilot requires the approved single-attempt direct Fireworks route and isolated launch authorization";

type Trial = { repetition: number; strategy: PilotStrategy; id: string };
type Json = Record<string, unknown>;

class StageBudget {
	readonly observations: Json[] = [];
	#calls = 0;
	#posts = 0;
	#nonce = "";
	#consumed = false;

	constructor(
		readonly label: string,
		private readonly deadline: number,
	) {}

	beforeDispatch(model: Model): void {
		if (this.#calls !== this.#posts) throw new Error("Previous model invocation did not issue exactly one POST");
		const observation = {
			at: new Date().toISOString(),
			stage: this.label,
			countBefore: this.#calls,
			model: `${model.provider}/${model.id}`,
		};
		this.observations.push(observation);
		if (Date.now() >= this.deadline) throw new Error("Pilot deadline expired before provider dispatch");
		this.#calls++;
		this.#nonce = crypto.randomUUID();
		this.#consumed = false;
	}

	get calls(): number {
		return this.#calls;
	}

	beforePost(): string {
		if (this.#posts >= this.#calls) throw new Error("Pilot refused a provider HTTP replay before dispatch");
		this.#posts++;
		return this.#nonce;
	}

	consumeWire(request: Request): void {
		if (this.#consumed || request.headers.get("x-pilot-invocation") !== this.#nonce || !this.#nonce) {
			throw new Error("Pilot refused unscoped or repeated wire dispatch");
		}
		this.#consumed = true;
	}

	verifyWire(wire: Json[]): void {
		const posts = wire.filter(entry => typeof entry.requestBody === "string").length;
		if (posts !== this.#calls || posts !== this.#posts) {
			throw new Error(
				`Pilot transport count mismatch: invocations=${this.#calls}, guarded=${this.#posts}, wire=${posts}`,
			);
		}
	}
}

function errorRecord(error: unknown): Json {
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
	};
}

function modelFrom(spec: PilotModel): Model {
	return buildModel({
		provider: spec.provider,
		api: spec.api,
		id: spec.id,
		name: spec.id,
		baseUrl: spec.api === "openai-responses" ? `${GATEWAY_ORIGIN}/v1` : GATEWAY_ORIGIN,
		reasoning: false,
		input: ["text"],
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}

function pilotSettings(): Settings {
	return Settings.isolated({
		"advisor.enabled": false,
		"compaction.enabled": false,
		"memories.enabled": false,
		"retry.enabled": false,
		"retry.maxRetries": 0,
		"retry.modelFallback": false,
		"retry.usageAwareFallback": false,
		"retry.waitForUsageReset": false,
		"todo.enabled": false,
		defaultThinkingLevel: "off",
	});
}

function unixGatewayFetch(
	nativeFetch: typeof fetch,
	socket: string,
	wire: Json[],
	budget: StageBudget,
	mode: PilotManifest["mode"],
): FetchImpl {
	return async (input, init) => {
		const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
		const url = new URL(request.url);
		if (url.origin !== GATEWAY_ORIGIN) throw new Error(`Pilot transport refused non-gateway origin: ${url.origin}`);
		if (request.method !== "POST" || (url.pathname !== "/v1/messages" && url.pathname !== "/v1/responses")) {
			throw new Error(`Pilot transport refused ${request.method} ${url.pathname}`);
		}
		budget.consumeWire(request);
		const body = await request.clone().text();
		wire.push({ at: new Date().toISOString(), method: request.method, path: url.pathname, requestBody: body });
		try {
			const response = await nativeFetch(request.url, {
				method: "POST",
				body,
				signal: request.signal,
				redirect: "error",
				headers: {
					"content-type": "application/json",
					"x-pilot-mode": mode,
					"x-pilot-stage": request.headers.get("x-pilot-stage")!,
					"x-pilot-invocation": request.headers.get("x-pilot-invocation")!,
				},
				unix: socket,
			} as RequestInit & { unix: string });
			wire.push({
				at: new Date().toISOString(),
				path: url.pathname,
				status: response.status,
				responseHeaders: Object.fromEntries(response.headers),
			});
			return response;
		} catch (error) {
			wire.push({ at: new Date().toISOString(), path: url.pathname, transportError: errorRecord(error) });
			throw error;
		}
	};
}

function auditedStream(budget: StageBudget, transport: FetchImpl): StreamFn {
	const stream: StreamFn = (model, context, options) => {
		budget.beforeDispatch(model);
		let posted = false;
		const abort = new AbortController();
		return streamSimple(model, context, {
			...options,
			signal: options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal,
			preferWebsockets: false,
			anthropicCacheRefresh: false,
			anthropicCacheRefreshRequest: false,
			cacheRetention: "none",
			apiKey: DUMMY_API_KEY,
			maxTokens: approvedLiveManifest.maxOutputTokens,
			disableReasoning: true,
			forceReasoningOff: true,
			statefulResponses: false,
			codexSseMaxAttempts: 1,
			acceptEmptyResponse: true,
			fetch: async (input, init) => {
				if (posted) {
					abort.abort();
					throw new Error("Pilot refused a second HTTP call in one model invocation");
				}
				posted = true;
				const request = input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
				request.headers.set("x-pilot-invocation", budget.beforePost());
				request.headers.set("x-pilot-stage", budget.label);
				// Preserve focused continuation's admitHttp/receipt wrapper.
				return (options?.fetch ?? transport)(request);
			},
		});
	};
	return registerContinuationTransport(stream);
}

function policy(manifest: PilotManifest, source: Model, destination: Model): ContinuationPolicyV1 {
	const candidate = (model: Model, account: string): ContinuationPolicyV1["candidates"][number] => ({
		provider: model.provider,
		account,
		model: model.id,
		endpoint: model.baseUrl,
		roles: ["primary", "worker", "advisor", "maintenance"],
		settings: { thinkingLevel: "off" },
		dataScope: "pilot-gateway",
	});
	return {
		version: 1,
		revision: `continuation-pilot-${manifest.id}`,
		roles: ["primary", "worker", "advisor", "maintenance"],
		dataScope: "pilot-gateway",
		candidates: [candidate(source, "pilot-source"), candidate(destination, "pilot-destination")],
		// ContinuationPolicyV1 requires numeric attemptBudget and maxFirstUsefulRequests.
		// Pilot observeRequest always reports unknown headroom, so a small first-useful
		// bound would become a model-request ceiling. attemptBudget is destination
		// rotation, not spend. MAX_SAFE_INTEGER satisfies the required fields without
		// a practical cutoff; dollar, deadline, and output/body limits still apply.
		unknownHeadroom: { allowFirstUsefulRequest: true, maxFirstUsefulRequests: Number.MAX_SAFE_INTEGER },
		attemptBudget: Number.MAX_SAFE_INTEGER,
		restrictedAccounts: [],
	};
}

function copyMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return structuredClone(messages) as AgentMessage[];
}

function appendTranscript(manager: SessionManager, messages: readonly AgentMessage[]): void {
	for (const message of messages) manager.appendMessage(message as never);
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(
		file,
		`${JSON.stringify(value, (_key, candidate) => (candidate instanceof Error ? errorRecord(candidate) : candidate), 2)}\n`,
	);
}

async function dispose(
	session: AgentSession | undefined,
	run: ContinuationRun | undefined,
	manager: SessionManager | undefined,
	auth: AuthStorage | undefined,
): Promise<Json[]> {
	const outcomes: Json[] = [];
	for (const [name, action] of [
		["session", () => session?.dispose()],
		["run", () => run?.close()],
		["manager", () => manager?.close()],
		["auth", () => auth?.close()],
	] as const) {
		try {
			await action();
			outcomes.push({ component: name, ok: true });
		} catch (error) {
			outcomes.push({ component: name, ok: false, error: errorRecord(error) });
		}
	}
	return outcomes;
}

async function createSession(args: {
	root: string;
	sessionsDir: string;
	model: Model;
	models: readonly Model[];
	systemPrompt: string;
	tools: PilotWorkload["tools"];
	messages: AgentMessage[];
	stream: StreamFn;
	deadline: number;
	continuationFactory?: ContinuationRun;
	manager?: SessionManager;
}): Promise<{ session: AgentSession; manager: SessionManager; auth: AuthStorage }> {
	const manager = args.manager ?? SessionManager.create(args.root, args.sessionsDir);
	if (!args.manager) appendTranscript(manager, args.messages);
	await manager.ensureOnDisk();
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	for (const model of args.models) auth.setRuntimeApiKey(model.provider, DUMMY_API_KEY);
	const settings = pilotSettings();
	const modelsPath = path.join(args.sessionsDir, "models.yml");
	await writeJson(modelsPath, {
		providers: Object.fromEntries(
			args.models.map(model => [
				model.provider,
				{
					baseUrl: model.baseUrl,
					api: model.api,
					apiKey: DUMMY_API_KEY,
					models: [
						{
							id: model.id,
							name: model.name,
							reasoning: model.reasoning,
							input: model.input,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
							cost: model.cost,
						},
					],
				},
			]),
		),
	});
	const agent = new Agent({
		getApiKey: () => DUMMY_API_KEY,
		initialState: {
			model: args.model,
			systemPrompt: [args.systemPrompt],
			tools: args.tools,
			messages: copyMessages(args.messages),
			disableReasoning: true,
		},
		convertToLlm,
		streamFn: args.stream,
		deadline: args.deadline,
		cwd: args.root,
	});
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(auth, modelsPath, {
			cacheDbPath: path.join(args.sessionsDir, "models.db"),
			settings,
		}),
		toolRegistry: new Map(args.tools.map(tool => [tool.name, tool])),
		thinkingLevel: ThinkingLevel.Off,
		autoApprove: true,
		disableExtensionDiscovery: true,
		continuationFactory: args.continuationFactory,
	});
	if (args.continuationFactory) await session.whenContinuationReady();
	return { session, manager, auth };
}

async function runTrial(args: {
	trial: Trial;
	manifest: PilotManifest;
	frozenWorkspace: string;
	outputRoot: string;
	transcript: AgentMessage[];
	source: Model;
	destination: Model;
	deadline: number;
}): Promise<{ stop: boolean }> {
	const resultRoot = path.join(args.outputRoot, "trials", args.trial.id);
	const workspace = path.join(args.outputRoot, "workspaces", args.trial.id);
	await fs.cp(args.frozenWorkspace, workspace, { recursive: true, errorOnExist: true });
	const workload = await createPilotWorkload(workspace);
	const budget = new StageBudget(args.trial.id, args.deadline);
	const wire: Json[] = [];
	const previousFetch = globalThis.fetch;
	const transport = unixGatewayFetch(previousFetch, args.manifest.gatewaySocket, wire, budget, args.manifest.mode);
	const stream = auditedStream(budget, transport);
	let session: AgentSession | undefined;
	let manager: SessionManager | undefined;
	let auth: AuthStorage | undefined;
	let run: ContinuationRun | undefined;
	let error: Json | undefined;
	let verification: unknown;
	let stop = false;
	const events: unknown[] = [];
	const startedAt = new Date().toISOString();
	try {
		globalThis.fetch = transport as typeof fetch;
		const sessionsDir = path.join(args.outputRoot, "sessions", args.trial.id);
		if (args.trial.strategy === "ordinary") {
			({ session, manager, auth } = await createSession({
				root: workspace,
				sessionsDir,
				model: args.source,
				systemPrompt: workload.systemPrompt,
				tools: workload.tools,
				messages: args.transcript,
				stream,
				deadline: args.deadline,
				models: [args.source, args.destination],
			}));
		} else if (args.trial.strategy === "full-history") {
			({ session, manager, auth } = await createSession({
				root: workspace,
				sessionsDir,
				model: args.destination,
				systemPrompt: workload.systemPrompt,
				tools: workload.tools,
				messages: args.transcript,
				stream,
				deadline: args.deadline,
				models: [args.source, args.destination],
			}));
		} else {
			const sourceManager = SessionManager.create(workspace, sessionsDir);
			appendTranscript(sourceManager, args.transcript);
			await sourceManager.ensureOnDisk();
			const runPolicy = policy(args.manifest, args.source, args.destination);
			run = await openContinuationRun({
				sessionManager: sourceManager,
				planPath: workload.planPath,
				workflow: workload.workflow,
				policy: runPolicy,
				source: runPolicy.candidates[0]!,
				observeRequest: async request => ({
					account: request.model.id === args.source.id ? "pilot-source" : "pilot-destination",
					dataScope: "pilot-gateway",
					contextTokens: args.manifest.maxRequestBodyBytes,
					allowances: [
						{
							provider: request.model.provider,
							account: request.model.id === args.source.id ? "pilot-source" : "pilot-destination",
							window: "subscription",
							headroom: "unknown",
						},
					],
				}),
				resolveDestination: async candidate => {
					if (candidate.model === args.destination.id && candidate.provider === args.destination.provider)
						return args.destination;
					if (candidate.model === args.source.id && candidate.provider === args.source.provider)
						return args.source;
					throw new Error(`Unapproved destination ${candidate.provider}/${candidate.model}`);
				},
			});
			const created = await createSession({
				root: workspace,
				sessionsDir,
				model: args.source,
				systemPrompt: workload.systemPrompt,
				tools: workload.tools,
				messages: args.transcript,
				stream,
				deadline: args.deadline,
				continuationFactory: run,
				manager: sourceManager,
				models: [args.source, args.destination],
			});
			session = created.session;
			manager = created.manager;
			auth = created.auth;
			const preparationStarted = performance.now();
			const prepared = await session.prepareContinuation({
				...workload.preparation,
				destination: runPolicy.candidates[1],
			});
			const preparedAt = performance.now();
			const activated = await session.activateContinuation(prepared);
			events.push({ type: "continuation-prepared", milliseconds: preparedAt - preparationStarted, prepared });
			events.push({ type: "continuation-activated", milliseconds: performance.now() - preparedAt, activated });
		}
		session.subscribe(event => events.push(event));
		await session.prompt(workload.continuationPrompt, {
			expandPromptTemplates: false,
			skipCompactionCheck: true,
			acceptTerminalEmptyStop: true,
		});
		await session.waitForIdle();
		if (session.agent.state.error) throw new Error(session.agent.state.error);
		budget.verifyWire(wire);
		verification = await workload.verify();
	} catch (caught) {
		error = errorRecord(caught);
		stop = true;
	} finally {
		const cleanup = await dispose(session, run, manager, auth);
		globalThis.fetch = previousFetch;
		await writeJson(path.join(resultRoot, "result.json"), {
			trial: args.trial,
			startedAt,
			finishedAt: new Date().toISOString(),
			stage: { calls: budget.calls, observations: budget.observations },
			wire,
			events,
			verification,
			error,
			cleanup,
			billing:
				args.manifest.mode === "live"
					? "See the direct relay's validated usage and exposure ledger."
					: "Synthetic transport; no paid inference.",
		});
	}
	return { stop };
}

export async function runPilot(manifest: PilotManifest, outputRoot: string): Promise<void> {
	if (manifest.mode !== "scripted" && manifest.mode !== "live") throw new Error(LIVE_DISPATCH_BLOCKED);
	if (manifest.version !== 1) throw new Error(`Unsupported pilot manifest version ${manifest.version}`);
	if (manifest.mode === "scripted" && manifest.gatewaySocket === approvedLiveManifest.gatewaySocket) {
		throw new Error("Scripted pilot cannot use the live relay socket");
	}
	for (const [key, expected] of Object.entries({
		maxPaidUsd: 5,
		paidFallback: false,
		maxOutputTokens: 16384,
		maxRequestBodyBytes: 524288,
		deadlineMinutes: 30,
		repetitions: 2,
	})) {
		if (manifest[key as keyof PilotManifest] !== expected) throw new Error(`Unapproved pilot limit: ${key}`);
	}
	if (
		manifest.mode === "live" &&
		(process.env.CONTINUATION_PILOT_LIVE_APPROVED !== "agent-13-fireworks-five-dollars" ||
			!isDeepStrictEqual({ ...manifest, gatewaySocket: approvedLiveManifest.gatewaySocket }, approvedLiveManifest) ||
			!path.isAbsolute(manifest.gatewaySocket))
	)
		throw new Error(LIVE_DISPATCH_BLOCKED);
	const root = path.resolve(outputRoot);
	await fs.mkdir(root, { recursive: false });
	await writeJson(path.join(root, "manifest.json"), manifest);
	const deadline = Date.now() + manifest.deadlineMinutes * 60_000;
	const source = modelFrom(manifest.source);
	const destination = modelFrom(manifest.destination);
	const primerWorkspace = path.join(root, "primer-workspace");
	const primerWorkload = await createPilotWorkload(primerWorkspace);
	const primerBudget = new StageBudget("primer", deadline);
	const primerWire: Json[] = [];
	const previousFetch = globalThis.fetch;
	const primerTransport = unixGatewayFetch(
		previousFetch,
		manifest.gatewaySocket,
		primerWire,
		primerBudget,
		manifest.mode,
	);
	const primerStream = auditedStream(primerBudget, primerTransport);
	let primerSession: AgentSession | undefined;
	let primerManager: SessionManager | undefined;
	let primerAuth: AuthStorage | undefined;
	let primerError: Json | undefined;
	let transcript: AgentMessage[] = [];
	try {
		globalThis.fetch = primerTransport as typeof fetch;
		({
			session: primerSession,
			manager: primerManager,
			auth: primerAuth,
		} = await createSession({
			root: primerWorkspace,
			sessionsDir: path.join(root, "sessions", "primer"),
			model: source,
			models: [source, destination],
			systemPrompt: primerWorkload.systemPrompt,
			tools: primerWorkload.tools,
			messages: [],
			stream: primerStream,
			deadline,
		}));
		const primerEvents: unknown[] = [];
		primerSession.subscribe(event => primerEvents.push(event));
		await primerSession.prompt(primerWorkload.sourcePrompt, {
			expandPromptTemplates: false,
			skipCompactionCheck: true,
			acceptTerminalEmptyStop: true,
		});
		await primerSession.waitForIdle();
		if (primerSession.agent.state.error) throw new Error(primerSession.agent.state.error);
		primerBudget.verifyWire(primerWire);
		transcript = copyMessages(primerSession.agent.state.messages);
		await writeJson(path.join(root, "primer.json"), {
			stage: { calls: primerBudget.calls, observations: primerBudget.observations },
			wire: primerWire,
			events: primerEvents,
			transcript,
		});
	} catch (caught) {
		primerError = errorRecord(caught);
	} finally {
		const cleanup = await dispose(primerSession, undefined, primerManager, primerAuth);
		globalThis.fetch = previousFetch;
		if (primerError)
			await writeJson(path.join(root, "primer.json"), {
				error: primerError,
				stage: primerBudget.observations,
				wire: primerWire,
				cleanup,
			});
	}
	if (primerError) throw new Error(`Primer failed: ${String(primerError.message)}`);
	const frozenWorkspace = path.join(root, "frozen-workspace");
	await fs.cp(primerWorkspace, frozenWorkspace, { recursive: true, errorOnExist: true });
	primerWorkload.resetObservations();
	const trials: Trial[] = [
		{ repetition: 1, strategy: "ordinary", id: "r1-ordinary" },
		{ repetition: 1, strategy: "focused", id: "r1-focused" },
		{ repetition: 1, strategy: "full-history", id: "r1-full-history" },
		{ repetition: 2, strategy: "full-history", id: "r2-full-history" },
		{ repetition: 2, strategy: "focused", id: "r2-focused" },
		{ repetition: 2, strategy: "ordinary", id: "r2-ordinary" },
	];
	for (const trial of trials) {
		if (Date.now() >= deadline) throw new Error("Pilot deadline expired before next trial");
		const outcome = await runTrial({
			trial,
			manifest,
			frozenWorkspace,
			outputRoot: root,
			transcript,
			source,
			destination,
			deadline,
		});
		if (outcome.stop) {
			await writeJson(path.join(root, "limits.json"), {
				status: "stopped",
				trial: trial.id,
				reason: "Infrastructure or admission failure; see retained trial evidence.",
			});
			throw new Error(`Pilot stopped at ${trial.id}; failed attempt retained without retry or fallback`);
		}
	}
	await writeJson(path.join(root, "limits.json"), {
		limits:
			"Fixed unfinished-review workload; constrained review tools; one source/destination pair; two repetitions.",
		route: manifest.route,
		billing:
			manifest.mode === "live"
				? "See the direct Fireworks relay ledger for conservative uncached exposure and validated usage; not an exact bill."
				: "Scripted transport; no paid inference.",
	});
}
