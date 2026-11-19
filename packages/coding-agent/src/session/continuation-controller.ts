import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import {
	type BeforeToolCallContext,
	type ToolExecutionAdmission,
	ToolExecutionBoundaryError,
} from "@oh-my-pi/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	serviceTierFamily,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { type } from "@oh-my-pi/omptype";
import type { DeliveryAcceptanceSnapshot, JobAdmissionSnapshot } from "../async/job-manager";
import type { ContinuationWorkflow } from "../extensibility/extensions/types";
import type { AdmissionOutcome, ContinuationBindingFactory, ContinuationSessionBinding } from "./continuation-binding";
import { buildContinuationBriefing } from "./continuation-briefing";
import {
	routeContinuationCompletions,
	verifyContinuationServices,
	type ContinuationActivatedHandoff,
	type ContinuationHandoffInputs,
	type ContinuationHandoffTicket,
	type ContinuationPreparedHandoff,
} from "./continuation-handoff";
import {
	checkContinuationDestination,
	continuationDestinationKey,
	validateContinuationPolicy,
	type ContinuationAllowanceObservation,
	type ContinuationDestination,
	type ContinuationDestinationSettings,
	type ContinuationPolicyV1,
	type ContinuationRole,
} from "./continuation-policy";
import {
	ContinuationAdmissionError,
	ContinuationDestinationRejection,
	type ContinuationRequestOutcome,
	type ContinuationRequestReceipt,
} from "./continuation-request";
import {
	checkpointPath,
	createNodeDurableIo,
	sha256Bytes,
	withContinuationOwner,
	writeImmutableJson,
	type ContinuationDurableIo,
	type ContinuationEvidenceRetention,
	type ContinuationOwner,
	type ContinuationOwnerOptions,
	type FileEvidenceRef,
	type OperatorIntent,
	type RunStatePatch,
	type RunStateV1,
} from "./continuation-store";
import type { SessionManager } from "./session-manager";
import { validateWorkProjection, workProjectionEvidence, type WorkProjectionV1 } from "./continuation-work";

const integer = type("number").divisibleBy(1).atLeast(0).atMost(Number.MAX_SAFE_INTEGER);
const nonempty = type("string").matching(/\S/);
const fileRef = type({
	kind: "'file'",
	path: nonempty,
	byteLength: integer,
	sha256: type("string").matching(/^[0-9a-f]{64}$/),
});
const actorRecord = type({
	id: nonempty,
	sessionId: nonempty,
	sessionFile: nonempty,
	generation: integer,
	role: "'primary' | 'advisor' | 'worker' | 'maintenance'",
	destination: "unknown",
	endpoint: nonempty.or("null"),
	api: nonempty.or("null"),
});
const transcriptRecord = type({ evidence: fileRef, cursor: { generation: integer, byteLength: integer } });
const controllerCheckpoint = type({
	kind: "'continuation-controller'",
	version: "1",
	runId: nonempty,
	generation: integer,
	previous: fileRef.or("null"),
	event: fileRef,
	policy: fileRef,
	projection: fileRef,
	actors: actorRecord.array(),
	transcripts: { "[string]": transcriptRecord },
	blocks: type({ provider: nonempty, account: nonempty, reason: nonempty }).array(),
	sourceDenials: type({
		sessionId: nonempty,
		generation: integer,
		provider: nonempty,
		account: nonempty,
		reason: nonempty,
		denied: { model: "boolean", tools: "boolean", workers: "boolean" },
		sourceResumeAllowed: "boolean",
	}).array(),
	acceptedJobs: { "[string]": nonempty },
	requestCount: integer,
	unknownRequestsUsed: integer,
	destinationAttempts: integer,
	transcriptBytesCopied: integer,
	transcriptBytesHashed: integer,
	rejectedDestinations: nonempty.array(),
	failedOwners: nonempty.array(),
	destinationSessions: nonempty.array(),
}).onDeepUndeclaredKey("reject");
type ControllerCheckpoint = typeof controllerCheckpoint.infer;
type Request = { role: ContinuationRole; model: Model; context: Context; options: SimpleStreamOptions | undefined };
interface Actor {
	id: string;
	manager: SessionManager;
	role: ContinuationRole;
	generation: number;
	sessionId: string;
	sessionFile: string;
	destination: ContinuationDestination | null;
	disposed: boolean;
	endpoint: string | null;
	api: string | null;
}

/** Nonsecret observations from the embedding's actual credential/capacity resolver, not model assurances. */
export interface ContinuationRequestObservation {
	account: string;
	dataScope: string;
	/** Conservative input bound including system, tools and images; reject unknown rather than inventing one. */
	contextTokens: number;
	allowances: readonly ContinuationAllowanceObservation[];
}
export interface ContinuationRunOptions {
	sessionManager: SessionManager;
	planPath: string;
	workflow: ContinuationWorkflow;
	policy: ContinuationPolicyV1;
	/** Approved destination of the initial primary, or the committed owner on relaunch. */
	source: ContinuationDestination;
	observeRequest(request: Request, sessionId: string): Promise<ContinuationRequestObservation>;
	/** Resolve configured destination capabilities without inference or global settings mutation. */
	resolveDestination?(destination: ContinuationDestination, sessionId: string): Promise<Model>;
	/** Explicit relaunch only. No discovery or implicit enrollment of an existing run. */
	recoverRunId?: string;
	ownerOptions?: ContinuationOwnerOptions;
}

/** Lifetime ownership is held until close(), including while no request is running. */
export async function openContinuationRun(options: ContinuationRunOptions): Promise<ContinuationRun> {
	const manager = options.sessionManager;
	await manager.ensureOnDisk();
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("Continuation enrollment requires a file-backed session");
	const entered = Promise.withResolvers<ContinuationRun>();
	const released = Promise.withResolvers<void>();
	const identity = { worktree: manager.getCwd(), planPath: options.planPath };
	const ownerTask = withContinuationOwner(
		options.recoverRunId
			? { action: "recover", identity, expectedRunId: options.recoverRunId }
			: {
					action: "enroll",
					identity,
					initial: { runId: randomUUID(), owner: { sessionId: manager.getSessionId(), sessionFile } },
				},
		async owner => {
			const run = new ContinuationRun(owner, options, () => released.resolve());
			await run.initialize();
			entered.resolve(run);
			await released.promise;
		},
		options.ownerOptions,
	);
	void ownerTask.catch(error => entered.reject(error));
	const run = await entered.promise;
	run.setOwnerCompletion(ownerTask);
	return run;
}

export class ContinuationRun implements ContinuationBindingFactory {
	readonly #io: ContinuationDurableIo;
	readonly #policy: ContinuationPolicyV1;
	#primaryDestination: ContinuationDestination;
	readonly #actors = new Map<string, Actor>();
	readonly #live = new Set<string>();
	#tail: Promise<unknown> = Promise.resolve();
	#fault: unknown;
	#failed = false;
	#closed = false;
	#ownerCompletion: Promise<void> = Promise.resolve();
	#checkpoint: ControllerCheckpoint | undefined;
	#checkpointRef: FileEvidenceRef | null = null;
	#projection: WorkProjectionV1 | undefined;
	#projectionFingerprint: string | undefined;
	#policyRef: FileEvidenceRef | undefined;
	#projectionRef: FileEvidenceRef | undefined;
	readonly #measurements: Array<{ event: string; milliseconds: number; bytes: number }> = [];
	readonly #prepared = new Map<
		string,
		{
			value: ContinuationPreparedHandoff;
			projectionFingerprint: string;
			sourceTranscript: FileEvidenceRef;
			ready: FileEvidenceRef;
			inputs: FileEvidenceRef;
			model: Model;
		}
	>();

	constructor(
		private readonly owner: ContinuationOwner,
		readonly options: ContinuationRunOptions,
		readonly releaseOwner: () => void,
	) {
		this.#io = options.ownerOptions?.io ?? createNodeDurableIo();
		this.#policy = validateContinuationPolicy(structuredClone(options.policy));
		this.#primaryDestination = this.#approvedDestination(options.source);
		if (!this.#primaryDestination.roles.includes("primary"))
			throw new Error("The enrolled source must be approved for the primary role");
	}

	setOwnerCompletion(completion: Promise<void>): void {
		this.#ownerCompletion = completion;
	}
	getState(): RunStateV1 {
		return this.owner.getState();
	}
	getPolicy(): ContinuationPolicyV1 {
		return structuredClone(this.#policy);
	}
	getProjection(): WorkProjectionV1 {
		if (!this.#projection) throw new Error("Continuation workflow has not been retained");
		return structuredClone(this.#projection);
	}
	getMeasurements(): ReadonlyArray<{ event: string; milliseconds: number; bytes: number }> {
		return structuredClone(this.#measurements);
	}

	async initialize(): Promise<void> {
		const state = this.owner.getState();
		if (
			state.owner.sessionId !== this.options.sessionManager.getSessionId() ||
			path.resolve(state.owner.sessionFile) !== path.resolve(this.options.sessionManager.getSessionFile() ?? "")
		) {
			throw new Error("Explicit relaunch must open the committed owner session, not create a replacement");
		}
		if (this.options.recoverRunId) {
			if (state.frontier.evidence.length !== 1)
				throw new Error("Committed controller checkpoint is missing or ambiguous");
			this.#checkpointRef = state.frontier.evidence[0];
			this.#checkpoint = controllerCheckpoint.assert(await this.#readJson(this.#checkpointRef));
			if (this.#checkpoint.runId !== state.run.id || this.#checkpoint.generation !== state.owner.generation)
				throw new Error("Controller checkpoint identity does not match committed owner");
			const storedPolicy = validateContinuationPolicy(await this.#readJson(this.#checkpoint.policy));
			if (JSON.stringify(storedPolicy) !== JSON.stringify(this.#policy))
				throw new Error("Relaunch policy differs from the committed policy");
			const committedPrimary = this.#checkpoint.actors.find(
				actor =>
					actor.sessionId === state.owner.sessionId && actor.role === "primary" && actor.id.endsWith(":session"),
			);
			if (
				committedPrimary?.destination &&
				JSON.stringify(committedPrimary.destination) !== JSON.stringify(this.#primaryDestination)
			)
				throw new Error("Relaunch source differs from the committed primary destination");
			this.#policyRef = this.#checkpoint.policy;
			this.#projectionRef = this.#checkpoint.projection;
			const plan = this.owner.getIdentity();
			this.#projection = validateWorkProjection(
				await this.#readJson(this.#projectionRef),
				plan,
				sha256Bytes(await fs.readFile(path.join(plan.root, plan.relativePath))),
			);
			for (const transcript of Object.values(this.#checkpoint.transcripts))
				await this.#verifyEvidence(transcript.evidence);
			for (const ref of workProjectionEvidence(this.#projection)) await this.#verifyEvidence(ref);
			this.#projectionFingerprint = sha256Bytes(JSON.stringify(this.#projection));
			await verifyContinuationServices(
				this.options.sessionManager.getCwd(),
				this.options.sessionManager.getContinuationServices(),
			);
			const routing = this.options.sessionManager.getContinuationCompletionRouting();
			if (routing && routing.successorSessionId === this.options.sessionManager.getSessionId()) {
				await routeContinuationCompletions(this.options.sessionManager.getCwd(), routing);
			}
			if (!state.run.terminal) {
				const actor = this.#actor(this.options.sessionManager, "primary", state.owner.generation);
				const pending = this.owner.getState().pendingHandoff;
				if (pending) {
					await this.#transition(
						"handoff-canceled",
						{
							id: pending.id,
							reason: "Pre-commit handoff recovered after controller death",
						},
						{ pendingHandoff: null },
						actor,
					);
					this.#prepared.delete(pending.id);
				}
				await this.#transition(
					"controller-takeover",
					{ sessionId: actor.sessionId },
					{},
					actor,
					[],
					draft => {
						for (const record of draft.actors) {
							if (record.sessionId === actor.sessionId) record.generation = actor.generation + 1;
						}
						for (const denial of draft.sourceDenials) {
							if (denial.sessionId === actor.sessionId && denial.generation === actor.generation) {
								draft.sourceDenials.push({ ...denial, generation: actor.generation + 1 });
							}
						}
					},
					{ kind: "takeover" },
				);
				this.#actors.clear();
			}
			return;
		}
		this.options.sessionManager.appendCustomEntry("omp-continuation", {
			version: 1,
			runId: state.run.id,
			planPath: this.options.planPath,
		});
		this.#policyRef = await this.#retain("policy", this.#policy);
		await this.#refreshProjection();
		const actor = this.#actor(this.options.sessionManager, "primary", state.owner.generation);
		await this.#transition("enroll", { actor: actor.id }, {}, actor);
	}

	bindSession(manager: SessionManager, role: ContinuationRole): ContinuationSessionBinding {
		const owner = this.owner.getState().owner;
		const sessionFile = manager.getSessionFile();
		if (
			!sessionFile ||
			manager.getSessionId() !== owner.sessionId ||
			path.resolve(sessionFile) !== path.resolve(owner.sessionFile)
		) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Direct continuation binding is limited to the committed owner session",
			});
		}
		return this.#binding(this.#actor(manager, role, owner.generation));
	}
	#actor(manager: SessionManager, role: ContinuationRole, generation: number, identity?: string): Actor {
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Continuation actors require file-backed session storage");
		const sessionId = manager.getSessionId();
		const id = `${sessionId}:${role}:${identity ?? "session"}`;
		let actor = this.#actors.get(id);
		if (actor) {
			if (actor.manager !== manager || actor.generation !== generation || actor.disposed)
				throw new Error("Continuation actor identity cannot be silently rebound");
			return actor;
		}
		const saved = this.#checkpoint?.actors.find(item => item.id === id);
		const destination =
			saved?.destination === null || saved?.destination === undefined
				? role === "primary" && sessionId === this.owner.getState().owner.sessionId
					? this.#primaryDestination
					: null
				: this.#approvedDestination(saved.destination);
		actor = {
			id,
			manager,
			role,
			generation,
			sessionId,
			sessionFile,
			destination,
			endpoint: saved?.endpoint ?? null,
			api: saved?.api ?? null,
			disposed: false,
		};
		this.#actors.set(id, actor);
		return actor;
	}
	#binding(actor: Actor): ContinuationSessionBinding {
		const factory: ContinuationBindingFactory = {
			bindSession: (manager, role) => this.#binding(this.#actor(manager, role, actor.generation)),
		};
		return {
			role: actor.role,
			factory,
			requestBoundary: { admit: (request, signal) => this.#admitRequest(actor, request, signal) },
			toolBoundary: { admit: (context, signal) => this.#admitTool(actor, context, signal) },
			admitJob: intent => this.#admitJob(actor, intent),
			acceptDeliveries: receipts => this.#acceptJobs(actor, receipts),
			handoff:
				actor.role === "primary"
					? {
							candidates: () =>
								this.#serialized(async () => {
									this.#assertActor(actor);
									this.#assertAuthorization();
									const candidates = this.#availableDestinations();
									await this.#stopWithoutDestination(actor, candidates);
									return structuredClone(candidates);
								}),
							begin: destination => this.#beginHandoff(actor, destination),
							prepare: (ticket, inputs) => this.#prepareHandoff(actor, ticket, inputs),
							commit: (prepared, inputs) => this.#commitHandoff(actor, prepared, inputs),
							cancel: (ticket, reason, rejectDestination = false) =>
								this.#serialized(async () => {
									this.#assertActor(actor);
									const state = this.owner.getState();
									if (
										ticket.runId !== state.run.id ||
										ticket.id !== state.pendingHandoff?.id ||
										ticket.sourceSessionId !== actor.sessionId ||
										ticket.sourceGeneration !== state.pendingHandoff.source.generation
									) {
										throw new ContinuationAdmissionError({
											kind: "stop",
											attention: true,
											reason: "Cannot cancel another transfer",
										});
									}
									await this.#transition(
										"handoff-canceled",
										{ id: ticket.id, reason },
										{
											pendingHandoff: null,
											...(rejectDestination
												? {
														rejectedAttempts: [
															...state.rejectedAttempts,
															{ id: ticket.id, reason, at: new Date().toISOString() },
														],
													}
												: {}),
										},
										actor,
										[],
										draft => {
											const key = continuationDestinationKey(ticket.destination);
											if (rejectDestination && !draft.rejectedDestinations.includes(key))
												draft.rejectedDestinations.push(key);
										},
									);
									this.#prepared.delete(ticket.id);
									if (rejectDestination)
										await this.#stopWithoutDestination(actor, this.#availableDestinations());
								}),
							adopt: manager => {
								const owner = this.owner.getState().owner;
								if (
									owner.generation <= actor.generation ||
									manager.getSessionId() !== owner.sessionId ||
									path.resolve(manager.getSessionFile() ?? "") !== path.resolve(owner.sessionFile)
								) {
									throw new ContinuationAdmissionError({
										kind: "stop",
										attention: true,
										reason: "Session is not the committed successor",
									});
								}
								return this.bindSession(manager, "primary");
							},
						}
					: undefined,
			forRole: (role, identity) => this.#binding(this.#actor(actor.manager, role, actor.generation, identity)),
			beforeRecovery: () => this.#serialized(async () => this.#outcome(actor)),
			barrier: () =>
				this.#serialized(async () => {
					this.#assertActor(actor);
					await this.#refreshProjection();
					await this.#transition("barrier", { actor: actor.id }, {}, actor);
				}),
			assertSessionTransition: (action, target) => {
				const owner = this.owner.getState().owner;
				if (
					action === "switch" &&
					target &&
					path.resolve(target) === path.resolve(owner.sessionFile) &&
					owner.generation > actor.generation
				)
					return;
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: `Enrolled session cannot ${action} outside a committed continuation transition`,
				});
			},
			dispose: async () => {
				actor.disposed = true;
				if (actor.role === "primary" && this.owner.getState().owner.sessionId === actor.sessionId)
					await this.close();
			},
		};
	}

	async close(): Promise<void> {
		if (!this.#closed) {
			this.#closed = true;
			await this.#tail.catch(() => undefined);
			this.releaseOwner();
		}
		await this.#ownerCompletion;
	}
	setIntent(intent: OperatorIntent): Promise<void> {
		return this.#serialized(async () => {
			await this.#transition("operator-intent", { intent }, { intent });
		});
	}
	#availableDestinations(): ContinuationDestination[] {
		if (this.#checkpoint!.destinationAttempts >= this.#policy.attemptBudget) return [];
		return this.#policy.candidates.filter(
			candidate =>
				candidate.roles.includes("primary") &&
				!this.#checkpoint!.rejectedDestinations.includes(continuationDestinationKey(candidate)) &&
				!this.#checkpoint!.blocks.some(
					block => block.provider === candidate.provider && block.account === candidate.account,
				),
		);
	}

	async #stopWithoutDestination(actor: Actor, candidates: readonly ContinuationDestination[]): Promise<void> {
		if (candidates.length || this.#outcome(actor).kind !== "handoff-required") return;
		const reason = "No approved usable continuation destination remains within the attempt budget";
		await this.#transition(
			"continuation-exhausted",
			{ reason },
			{
				stop: { kind: "exhausted", reason, at: new Date().toISOString() },
			},
			actor,
		);
	}

	#beginHandoff(actor: Actor, requested = this.#primaryDestination): Promise<ContinuationHandoffTicket> {
		return this.#serialized(async () => {
			this.#assertActor(actor);
			this.#assertAuthorization();
			const state = this.owner.getState();
			if (
				state.run.terminal ||
				state.stop ||
				state.intent.kind === "stop" ||
				state.intent.kind === "pause" ||
				state.pendingHandoff
			) {
				throw new ContinuationAdmissionError({ kind: "defer", reason: "Run is not available for a new handoff" });
			}
			const destination = this.#approvedDestination(requested);
			if (!destination.roles.includes("primary"))
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Destination lacks primary authorization",
				});
			if (
				this.#checkpoint!.destinationAttempts >= this.#policy.attemptBudget ||
				this.#checkpoint!.rejectedDestinations.includes(continuationDestinationKey(destination))
			) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Destination attempt budget exhausted or candidate already rejected",
				});
			}
			const ticket: ContinuationHandoffTicket = {
				runId: state.run.id,
				id: randomUUID(),
				sourceSessionId: actor.sessionId,
				sourceGeneration: actor.generation,
				destination,
			};
			await this.#transition(
				"handoff-preparing",
				ticket,
				{
					pendingHandoff: {
						id: ticket.id,
						phase: "preparing",
						source: { sessionId: actor.sessionId, sessionFile: actor.sessionFile, generation: actor.generation },
						destination: { provider: destination.provider, account: destination.account },
						policyRevision: this.#policy.revision,
					},
				},
				actor,
				[],
				draft => {
					draft.destinationAttempts++;
				},
			);
			return structuredClone(ticket);
		});
	}

	#assertTicket(actor: Actor, ticket: ContinuationHandoffTicket): void {
		this.#assertActor(actor);
		const state = this.owner.getState();
		if (
			ticket.runId !== state.run.id ||
			ticket.sourceSessionId !== actor.sessionId ||
			ticket.sourceGeneration !== actor.generation ||
			ticket.id !== state.pendingHandoff?.id ||
			state.pendingHandoff.policyRevision !== this.#policy.revision
		) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Stale or foreign handoff ticket",
			});
		}
		this.#approvedDestination(ticket.destination);
	}

	#assertQuiescent(): void {
		const state = this.owner.getState();
		if (state.run.terminal || state.stop || state.intent.kind === "stop" || state.intent.kind === "pause") {
			throw new ContinuationAdmissionError({
				kind: "defer",
				reason: "Operator intent or run stop prevents activation",
			});
		}
		if (
			state.pendingEffects.length ||
			state.accounting.workers.some(worker => worker.status === "live") ||
			this.#live.size
		) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Transfer requires settled effects and workers",
			});
		}
	}

	#prepareHandoff(
		actor: Actor,
		ticket: ContinuationHandoffTicket,
		inputs: ContinuationHandoffInputs,
	): Promise<ContinuationPreparedHandoff> {
		return this.#serialized(async () => {
			this.#assertTicket(actor, ticket);
			this.#assertQuiescent();
			if (this.owner.getState().pendingHandoff?.phase !== "preparing")
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Handoff is already staged",
				});
			await this.#refreshProjection();
			await this.#transition("handoff-source-retained", { id: ticket.id }, {}, actor);
			const transcript = this.#checkpoint!.transcripts[actor.sessionId]!.evidence;
			const captured = structuredClone(inputs);
			if (!Array.isArray(captured.services)) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Continuation handoff requires portable service handles",
				});
			}
			const briefing = await buildContinuationBriefing({
				projection: this.getProjection(),
				runId: ticket.runId,
				generation: actor.generation + 1,
				sourceSessionId: actor.sessionId,
				sourceTranscript: transcript,
				policyRevision: this.#policy.revision,
				destination: ticket.destination,
				roleObligations: captured.roleObligations,
				retainedInstructions: captured.retainedInstructions,
				discoveries: captured.discoveries,
				services: captured.services,
				maxBytes: captured.maxBriefingBytes,
			});
			const session = await actor.manager.stageContinuation({
				runId: ticket.runId,
				planPath: this.options.planPath,
				sourceSessionId: actor.sessionId,
				generation: actor.generation + 1,
				destination: ticket.destination,
				briefing,
				todos: this.getProjection().todos,
				queuedMessages: captured.queuedMessages,
				draft: captured.draft,
				roleObligations: captured.roleObligations,
				services: captured.services,
				evidencePath: path.join(this.owner.getControlDir(), "transcripts", `${randomUUID()}.jsonl`),
			});
			const model = this.options.resolveDestination
				? await this.options.resolveDestination(ticket.destination, session.sessionId)
				: captured.model;
			const candidate: Actor = {
				id: `${session.sessionId}:primary:session`,
				manager: actor.manager,
				role: "primary",
				generation: actor.generation + 1,
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				destination: ticket.destination,
				disposed: false,
				endpoint: null,
				api: null,
			};
			await this.#resolveRequest(
				candidate,
				this.#candidateRequest(model, ticket.destination, briefing.text, captured),
			);
			const inputFingerprint = sha256Bytes(JSON.stringify(captured));
			const inputRef = await this.#retain("handoff-inputs", captured);
			const value = {
				ticket: structuredClone(ticket),
				session,
				briefing,
				inputFingerprint,
				services: captured.services,
			};
			const ready = await this.#retain("handoff-staged", {
				version: 1,
				...value,
				inputs: inputRef,
				projection: this.#projectionRef,
			});
			await this.#transition(
				"handoff-staged",
				{ id: ticket.id, ready },
				{
					pendingHandoff: {
						...this.owner.getState().pendingHandoff!,
						phase: "staged",
						destination: {
							provider: ticket.destination.provider,
							account: ticket.destination.account,
							sessionId: session.sessionId,
							sessionFile: session.sessionFile,
							transcript: session.transcript,
							checkpoint: ready,
						},
					},
				},
				actor,
				[ready, inputRef, session.transcript, session.retainedTranscript, ...briefing.evidence],
			);
			this.#prepared.set(ticket.id, {
				value,
				projectionFingerprint: this.#projectionFingerprint!,
				sourceTranscript: transcript,
				ready,
				inputs: inputRef,
				model,
			});
			return structuredClone(value);
		});
	}

	#candidateRequest(
		model: Model,
		destination: ContinuationDestination,
		briefing: string,
		inputs: ContinuationHandoffInputs,
	): Request {
		const { thinkingLevel, ...settings } = destination.settings;
		return {
			role: "primary",
			model,
			context: {
				systemPrompt: inputs.context.systemPrompt,
				tools: inputs.context.tools,
				messages: [{ role: "user", content: briefing, timestamp: 0 }, ...inputs.queuedMessages],
			},
			options: {
				...settings,
				...(thinkingLevel === "off" ? { forceReasoningOff: true } : { reasoning: thinkingLevel }),
			},
		};
	}

	#commitHandoff(
		actor: Actor,
		prepared: ContinuationPreparedHandoff,
		inputs: ContinuationHandoffInputs,
	): Promise<ContinuationActivatedHandoff> {
		return this.#serialized(async () => {
			this.#assertTicket(actor, prepared.ticket);
			this.#assertAuthorization();
			this.#assertQuiescent();
			const record = this.#prepared.get(prepared.ticket.id);
			if (
				!record ||
				!isDeepStrictEqual(prepared, record.value) ||
				sha256Bytes(JSON.stringify(inputs)) !== record.value.inputFingerprint
			) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Handoff inputs changed or staged ticket is not owned by this controller",
				});
			}
			await this.#refreshProjection();
			if (record.projectionFingerprint !== this.#projectionFingerprint) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Workflow revision changed during preparation",
				});
			}
			if (!Array.isArray(inputs.services)) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Continuation handoff requires portable service handles",
				});
			}
			try {
				await verifyContinuationServices(actor.manager.getCwd(), inputs.services);
			} catch (error) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
			const sourceBytes = await fs.readFile(actor.sessionFile);
			if (
				sourceBytes.byteLength !== record.sourceTranscript.byteLength ||
				sha256Bytes(sourceBytes) !== record.sourceTranscript.sha256
			) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Source transcript changed during preparation",
				});
			}
			const { session, ticket, briefing } = record.value;
			const candidate: Actor = {
				id: `${session.sessionId}:primary:session`,
				manager: actor.manager,
				role: "primary",
				generation: actor.generation + 1,
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				destination: ticket.destination,
				disposed: false,
				endpoint: null,
				api: null,
			};
			const model = this.options.resolveDestination
				? await this.options.resolveDestination(ticket.destination, session.sessionId)
				: inputs.model;
			await this.#resolveRequest(
				candidate,
				this.#candidateRequest(model, ticket.destination, briefing.text, inputs),
			);
			await this.#transition(
				"handoff-activated",
				{ id: ticket.id, sourceSessionId: actor.sessionId, destinationSessionId: session.sessionId },
				{},
				actor,
				[record.ready, record.inputs, session.transcript, session.retainedTranscript, ...briefing.evidence],
				draft => {
					draft.actors.push({
						id: candidate.id,
						role: candidate.role,
						generation: candidate.generation,
						sessionId: candidate.sessionId,
						sessionFile: candidate.sessionFile,
						destination: candidate.destination,
						endpoint: candidate.endpoint,
						api: candidate.api,
					});
					draft.transcripts[session.sessionId] = {
						evidence: session.retainedTranscript,
						cursor: { generation: 0, byteLength: session.retainedTranscript.byteLength },
					};
					draft.destinationSessions.push(candidate.sessionId);
				},
				{ handoffId: ticket.id, sessionId: session.sessionId, sessionFile: session.sessionFile },
			);
			this.#primaryDestination = structuredClone(ticket.destination);
			this.#prepared.delete(ticket.id);
			return {
				runId: ticket.runId,
				id: ticket.id,
				generation: this.owner.getState().owner.generation,
				sourceSessionId: actor.sessionId,
				sessionId: session.sessionId,
				sessionFile: session.sessionFile,
				destination: structuredClone(ticket.destination),
				draft: inputs.draft,
			};
		});
	}
	#serialized<T>(work: () => Promise<T>): Promise<T> {
		const task = this.#tail.then(work, work).catch(error => {
			if (
				!(error instanceof ContinuationAdmissionError) &&
				!(error instanceof ToolExecutionBoundaryError && !error.persistent)
			) {
				this.#failed = true;
				this.#fault = error;
			}
			throw error;
		});
		this.#tail = task.catch(() => undefined);
		return task;
	}
	#assertActor(actor: Actor): void {
		if (this.#failed) throw this.#fault;
		if (this.#closed || actor.disposed)
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Continuation actor is closed",
			});
		const owner = this.owner.getState().owner;
		if (
			actor.generation !== owner.generation ||
			(actor.role === "primary" && actor.sessionId !== owner.sessionId) ||
			actor.sessionId !== actor.manager.getSessionId() ||
			path.resolve(actor.sessionFile) !== path.resolve(actor.manager.getSessionFile() ?? "")
		) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Continuation actor no longer has its admitted owner generation and session",
			});
		}
	}
	#outcome(actor: Actor, kind: "model" | "tools" | "workers" = "model"): AdmissionOutcome {
		try {
			this.#assertActor(actor);
		} catch (error) {
			return { kind: "stop", attention: true, reason: error instanceof Error ? error.message : String(error) };
		}
		const state = this.owner.getState();
		if (state.run.terminal || state.intent.kind === "stop")
			return {
				kind: "stop",
				attention: false,
				reason: state.intent.kind === "stop" ? state.intent.reason : "Run is terminal",
			};
		if (state.intent.kind === "pause")
			return { kind: "defer", reason: state.intent.reason ?? "Operator paused the run" };
		if (state.stop) return { kind: "stop", attention: state.stop.kind === "attention", reason: state.stop.reason };
		const block =
			actor.destination &&
			this.#checkpoint?.blocks.find(
				item => item.provider === actor.destination?.provider && item.account === actor.destination?.account,
			);
		if (block)
			return { kind: "handoff-required", provider: block.provider, account: block.account, reason: block.reason };
		const unresolved =
			state.pendingEffects.some(effect => !this.#live.has(effect.id)) ||
			state.accounting.workers.some(worker => worker.status === "live" && !this.#live.has(worker.identity));
		if (this.#checkpoint?.failedOwners.includes(state.owner.sessionId)) {
			if (unresolved) {
				return {
					kind: "stop",
					attention: true,
					reason: "Unresolved effects or surviving workers require explicit reconciliation",
				};
			}
			const remaining = this.#availableDestinations();
			if (remaining.length > 0 && actor.destination) {
				return {
					kind: "handoff-required",
					provider: actor.destination.provider,
					account: actor.destination.account,
					reason: "Committed destination rejected a settled request; another approved candidate remains",
				};
			}
			return {
				kind: "stop",
				attention: true,
				reason: "Committed destination failed; its owner and partial evidence are retained",
			};
		}
		const scope = this.#checkpoint?.sourceDenials.find(
			item => item.sessionId === actor.sessionId && item.generation === actor.generation,
		);
		if (scope?.denied[kind])
			return { kind: "handoff-required", provider: scope.provider, account: scope.account, reason: scope.reason };
		if (scope && !scope.sourceResumeAllowed)
			return { kind: "stop", attention: false, reason: "This exhausted source is not authorized to resume" };
		if (state.pendingHandoff || state.intent.kind === "handoff")
			return { kind: "defer", reason: "Continuation transfer has frozen new admission" };
		if (unresolved) {
			return {
				kind: "stop",
				attention: true,
				reason: "Unresolved effects or surviving workers require explicit reconciliation",
			};
		}
		return { kind: "allow" };
	}
	async #admission(actor: Actor, signal?: AbortSignal, kind: "model" | "tools" | "workers" = "model"): Promise<void> {
		this.#assertAuthorization();
		const outcome = this.#outcome(actor, kind);
		if (outcome.kind !== "allow") throw new ContinuationAdmissionError(outcome);
		if (signal?.aborted)
			throw new ContinuationAdmissionError({ kind: "defer", reason: "Operation was canceled before admission" });
		await this.#refreshProjection();
		this.#assertActor(actor);
		if (signal?.aborted)
			throw new ContinuationAdmissionError({ kind: "defer", reason: "Operation was canceled before admission" });
	}
	async #refreshProjection(): Promise<void> {
		const identity = this.owner.getIdentity();
		const planHash = sha256Bytes(await fs.readFile(path.join(identity.root, identity.relativePath)));
		const projection = validateWorkProjection(
			await this.options.workflow.exportProjection({ cwd: identity.root, planPath: identity.relativePath }),
			identity,
			planHash,
		);
		if (!projection.recovery.eligible)
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: `Workflow recovery is ${projection.recovery.status}: ${projection.recovery.blockers.join(", ")}`,
			});
		if (this.#projection && projection.revision < this.#projection.revision)
			throw new Error("Workflow revision moved backwards");
		for (const ref of workProjectionEvidence(projection)) await this.#verifyEvidence(ref);
		const fingerprint = sha256Bytes(JSON.stringify(projection));
		if (fingerprint !== this.#projectionFingerprint) {
			this.#projectionRef = await this.#retain("workflow", projection);
			this.#projection = structuredClone(projection);
			this.#projectionFingerprint = fingerprint;
		}
	}
	#approvedDestination(value: unknown): ContinuationDestination {
		const match = this.#policy.candidates.find(candidate => isDeepStrictEqual(candidate, value));
		if (!match) throw new Error("Persisted actor destination is not approved by the bound policy");
		return structuredClone(match);
	}
	#assertAuthorization(): void {
		if (!isDeepStrictEqual(validateContinuationPolicy(this.options.policy), this.#policy)) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Continuation authorization changed after enrollment",
			});
		}
	}
	async #resolveRequest(
		actor: Actor,
		request: Request,
	): Promise<{ destination: ContinuationDestination; unknown: boolean }> {
		this.#assertAuthorization();
		if (request.role !== actor.role) throw new Error("Request role differs from its actor binding");
		if (
			(actor.endpoint !== null && actor.endpoint !== request.model.baseUrl) ||
			(actor.api !== null && actor.api !== request.model.api)
		) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Actor endpoint or protocol changed without fresh ownership",
			});
		}
		const observed = await this.options.observeRequest(request, actor.sessionId);
		const options = request.options;
		if (actor.role === "maintenance" && options?.sessionId !== undefined && options.sessionId !== actor.sessionId) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Maintenance input belongs to an earlier session",
			});
		}
		let thinkingLevel: ContinuationDestinationSettings["thinkingLevel"];
		if (options?.disableReasoning || options?.forceReasoningOff) {
			thinkingLevel = "off";
		} else if (options?.reasoning === undefined) {
			thinkingLevel = undefined;
		} else {
			const effort = THINKING_EFFORTS.find(candidate => candidate === options.reasoning);
			if (effort === undefined) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Request contains settings not representable by the approved continuation policy",
				});
			}
			thinkingLevel = effort;
		}
		const settings: ContinuationDestinationSettings = {
			thinkingLevel,
			serviceTier: options?.serviceTier,
			maxTokens: options?.maxTokens,
			temperature: options?.temperature,
		};
		if (
			[
				options?.topP,
				options?.topK,
				options?.minP,
				options?.frequencyPenalty,
				options?.presencePenalty,
				options?.thinkingBudgets,
			].some(value => value !== undefined)
		) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Request contains settings not representable by the approved continuation policy",
			});
		}
		const destination = this.#policy.candidates.find(
			candidate =>
				candidate.provider === request.model.provider &&
				candidate.account === observed.account &&
				candidate.model === request.model.id &&
				candidate.roles.includes(actor.role) &&
				(candidate.endpoint ??
					getBundledModel(request.model.provider as GeneratedProvider, request.model.id)?.baseUrl) ===
					request.model.baseUrl,
		);
		if (
			!destination ||
			(actor.destination &&
				continuationDestinationKey(actor.destination) !== continuationDestinationKey(destination))
		) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason:
					"Request destination is not approved for this actor; model/provider changes require fresh ownership",
			});
		}
		if (options?.maxTokens !== undefined) {
			// A per-request output cap may narrow the approved limit, including the
			// approved model's inherited default. It cannot increase that limit.
			const approvedLimit = destination.settings.maxTokens ?? request.model.maxTokens;
			if (
				approvedLimit == null ||
				!Number.isSafeInteger(options.maxTokens) ||
				options.maxTokens <= 0 ||
				!Number.isSafeInteger(approvedLimit) ||
				approvedLimit <= 0 ||
				options.maxTokens > approvedLimit
			) {
				throw new ContinuationAdmissionError({
					kind: "stop",
					attention: true,
					reason: "Request output limit is not authorized for this destination",
				});
			}
			settings.maxTokens = destination.settings.maxTokens;
		}
		const block = this.#checkpoint?.blocks.find(
			item => item.provider === destination.provider && item.account === destination.account,
		);
		if (block)
			throw new ContinuationAdmissionError({
				kind: "handoff-required",
				provider: block.provider,
				account: block.account,
				reason: block.reason,
			});
		const modalities = new Set<"text" | "image">(["text"]);
		for (const message of request.context.messages) {
			if (Array.isArray(message.content) && message.content.some(part => part.type === "image"))
				modalities.add("image");
		}
		const result = checkContinuationDestination(this.#policy, destination, {
			policyRevision: this.#policy.revision,
			role: actor.role,
			model: {
				provider: request.model.provider,
				id: request.model.id,
				account: observed.account,
				endpoint: destination.endpoint,
				input: request.model.input,
				contextWindow: request.model.contextWindow,
				reasoning: request.model.reasoning,
				supportsTools: request.model.supportsTools,
				supportedEfforts: getSupportedEfforts(request.model),
				serviceTierFamily: serviceTierFamily(request.model),
			},
			required: {
				tools: (request.context.tools?.length ?? 0) > 0,
				modalities: [...modalities],
				contextTokens: observed.contextTokens,
				settings,
				dataScope: observed.dataScope,
			},
			allowances: observed.allowances,
			attemptsUsed:
				actor.generation > this.owner.getState().owner.generation
					? Math.max(0, this.#checkpoint!.destinationAttempts - 1)
					: 0,
			unknownHeadroomRequestsUsed: this.#checkpoint?.unknownRequestsUsed ?? 0,
			rejectedKeys:
				actor.generation > this.owner.getState().owner.generation
					? (this.#checkpoint?.rejectedDestinations ?? [])
					: [],
		});
		if (!result.eligible)
			throw new ContinuationDestinationRejection({ kind: "stop", attention: true, reason: result.rejection.reason });
		actor.destination = structuredClone(destination);
		actor.endpoint = request.model.baseUrl;
		actor.api = request.model.api;
		return { destination, unknown: result.unknownHeadroomAllowed };
	}

	#admitTool(actor: Actor, context: BeforeToolCallContext, signal?: AbortSignal): Promise<ToolExecutionAdmission> {
		return this.#serialized(async () => {
			try {
				await this.#admission(actor, signal, "tools");
			} catch (error) {
				if (error instanceof ContinuationAdmissionError) {
					throw new ToolExecutionBoundaryError(error.message, { cause: error, persistent: false });
				}
				throw error;
			}
			const id = randomUUID();
			const args = JSON.stringify(context.args);
			await this.#begin(actor, id, "tool", { toolCall: structuredClone(context.toolCall), args: JSON.parse(args) });
			if (JSON.stringify(context.args) !== args) {
				await this.#settle(
					actor,
					id,
					"tool",
					{ outcome: "not-started", reason: "Arguments changed during durable admission" },
					true,
				);
				throw new ToolExecutionBoundaryError("Tool arguments changed during durable admission", {
					persistent: false,
				});
			}
			return {
				settle: outcome =>
					this.#serialized(async () => {
						const known =
							outcome.outcome === "not-started" || (outcome.executed && outcome.outcome === "returned");
						await this.#settle(actor, id, "tool", outcome, known);
					}),
			};
		});
	}
	#admitJob(actor: Actor, intent: JobAdmissionSnapshot): Promise<void> {
		return this.#serialized(async () => {
			await this.#admission(actor, undefined, "workers");
			const id = `job-${intent.executionId}`;
			const state = this.owner.getState();
			await this.#begin(actor, id, "job", intent, {
				accounting: {
					...state.accounting,
					workers: [
						...state.accounting.workers,
						{ identity: id, status: "live", launchedAt: new Date(intent.startTime).toISOString() },
					],
				},
			});
		});
	}
	#acceptJobs(actor: Actor, receipts: readonly DeliveryAcceptanceSnapshot[]): Promise<void> {
		return this.#serialized(async () => {
			for (const receipt of receipts) {
				const id = `job-${receipt.executionId}`;
				const fingerprint = sha256Bytes(JSON.stringify(receipt));
				const accepted = this.#checkpoint?.acceptedJobs[receipt.executionId];
				if (accepted) {
					if (accepted !== fingerprint) throw new Error("Contradictory duplicate job settlement");
					continue;
				}
				const state = this.owner.getState();
				const resultRef = await this.#retain(
					`effect-result-${id}`,
					{ kind: "effect-result", runId: state.run.id, id, actor: actor.id, known: true, result: receipt },
					true,
				);
				await this.#transition(
					"job-accepted",
					{ id, result: resultRef },
					{
						pendingEffects: state.pendingEffects.filter(effect => effect.id !== id),
						accounting: {
							...state.accounting,
							workers: state.accounting.workers.map(worker =>
								worker.identity === id ? { ...worker, status: "settled" } : worker,
							),
						},
					},
					actor,
					[resultRef],
					draft => {
						draft.acceptedJobs[receipt.executionId] = fingerprint;
					},
				);
				this.#live.delete(id);
			}
		});
	}
	#admitRequest(actor: Actor, request: Request, signal?: AbortSignal): Promise<ContinuationRequestReceipt> {
		return this.#serialized(async () => {
			await this.#admission(actor, signal);
			const resolved = await this.#resolveRequest(actor, request);
			const id = randomUUID();
			const wireIds = new Set<string>();
			const responseStatuses = new Map<string, number>();
			const undispatched = new Set<string>();
			let finished = false;
			const instructions = await this.#retain("request-instructions", {
				systemPrompt: request.context.systemPrompt,
				tools: request.context.tools,
			});
			await this.#begin(
				actor,
				id,
				"request",
				{ destination: resolved.destination, api: request.model.api, instructions },
				{},
				[instructions],
			);
			return {
				admitHttp: (input, init) =>
					this.#serialized(async () => {
						if (finished) throw new Error("Model request is already settled");
						await this.#admission(actor, init?.signal ?? signal);
						await this.#resolveRequest(actor, request);
						const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
						const approvedUrl = new URL(resolved.destination.endpoint ?? request.model.baseUrl);
						if (
							url.origin !== approvedUrl.origin ||
							!(
								url.pathname === approvedUrl.pathname ||
								url.pathname.startsWith(`${approvedUrl.pathname.replace(/\/$/, "")}/`)
							)
						)
							throw new Error("HTTP request escaped its approved endpoint");
						const body =
							init?.body ?? (input instanceof globalThis.Request ? await input.clone().text() : undefined);
						if (typeof body !== "string" && !(body instanceof Uint8Array)) {
							throw new Error("Continuation requires a finite encoded JSON request body");
						}
						const wireId = randomUUID();
						const state = this.owner.getState();
						await this.#transition(
							"http-intent",
							{
								id: wireId,
								requestId: id,
								actor: actor.id,
								url: `${url.origin}${url.pathname}`,
								byteLength: Buffer.byteLength(body),
								sha256: sha256Bytes(body),
							},
							{
								pendingEffects: [
									...state.pendingEffects,
									{
										id: wireId,
										kind: "http",
										identity: actor.id,
										unresolved: true,
										launchedAt: new Date().toISOString(),
									},
								],
							},
							actor,
							[],
							draft => {
								draft.requestCount++;
								if (resolved.unknown) draft.unknownRequestsUsed++;
							},
						);
						wireIds.add(wireId);
						this.#live.add(wireId);
						return {
							received: async response => {
								const errorText = response.ok ? undefined : await boundedResponseText(response);
								const exhausted =
									errorText !== undefined &&
									AIError.isUsageLimit({ status: response.status, message: errorText }, request.model.api);
								await this.#serialized(async () => {
									responseStatuses.set(wireId, response.status);
									await this.#transition(
										"http-response",
										{
											id: wireId,
											requestId: id,
											status: response.status,
											errorBodySha256: errorText === undefined ? undefined : sha256Bytes(errorText),
											exhausted,
										},
										{},
										actor,
										[],
										draft => {
											if (exhausted) this.#recordAllowanceDenial(draft, actor, resolved.destination);
											if (
												!response.ok &&
												actor.role === "primary" &&
												draft.destinationSessions.includes(actor.sessionId)
											) {
												const key = continuationDestinationKey(resolved.destination);
												if (!draft.rejectedDestinations.includes(key)) draft.rejectedDestinations.push(key);
												if (!draft.failedOwners.includes(actor.sessionId))
													draft.failedOwners.push(actor.sessionId);
											}
										},
									);
								});
							},
							failed: (error, dispatched) =>
								this.#serialized(async () => {
									if (!dispatched) undispatched.add(wireId);
									const state = this.owner.getState();
									await this.#transition(
										dispatched ? "http-unknown" : "http-not-started",
										{ id: wireId, requestId: id, error: describeError(error) },
										{
											pendingEffects: dispatched
												? state.pendingEffects
												: state.pendingEffects.filter(effect => effect.id !== wireId),
										},
										actor,
									);
									this.#live.delete(wireId);
								}),
						};
					}),
				beforeRetryWait: retrySignal =>
					this.#serialized(async () => {
						await this.#admission(actor, retrySignal);
						await this.#resolveRequest(actor, request);
					}),
				settle: outcome =>
					this.#serialized(async () => {
						if (finished) return;
						finished = true;
						const dispatched = [...wireIds].filter(wireId => !undispatched.has(wireId));
						const known =
							!(outcome.kind === "threw" && outcome.unobservedTransport) &&
							(outcome.kind === "not-started" ||
								dispatched.length === 0 ||
								(outcome.kind === "returned" &&
									((outcome.message.stopReason !== "error" && outcome.message.stopReason !== "aborted") ||
										dispatched.every(wireId => (responseStatuses.get(wireId) ?? 0) >= 400))));
						const result = requestOutcome(outcome);
						const message = outcome.kind === "returned" ? outcome.message : undefined;
						const exhausted =
							message?.stopReason === "error" &&
							AIError.is(AIError.classifyMessage(message), AIError.Flag.UsageLimit);
						await this.#settle(actor, id, "request", result, known, [...wireIds], draft => {
							if (exhausted) this.#recordAllowanceDenial(draft, actor, resolved.destination);
						});
					}),
			};
		});
	}
	#recordAllowanceDenial(draft: ControllerCheckpoint, actor: Actor, destination: ContinuationDestination): void {
		const reason = "Provider reported an account allowance limit";
		if (!draft.blocks.some(block => block.provider === destination.provider && block.account === destination.account))
			draft.blocks.push({ provider: destination.provider, account: destination.account, reason });
		if (
			actor.role === "primary" &&
			actor.sessionId === this.owner.getState().owner.sessionId &&
			!draft.sourceDenials.some(
				source => source.sessionId === actor.sessionId && source.generation === actor.generation,
			)
		) {
			draft.sourceDenials.push({
				sessionId: actor.sessionId,
				generation: actor.generation,
				provider: destination.provider,
				account: destination.account,
				reason,
				denied: { model: true, tools: true, workers: true },
				sourceResumeAllowed: false,
			});
		}
	}
	async #begin(
		actor: Actor,
		id: string,
		kind: string,
		payload: unknown,
		patch: RunStatePatch = {},
		dependencies: FileEvidenceRef[] = [],
	): Promise<void> {
		const state = this.owner.getState();
		await this.#transition(
			"effect-intent",
			{ id, kind, actor: actor.id, payload },
			{
				...patch,
				pendingEffects: [
					...state.pendingEffects,
					{ id, kind, identity: actor.id, unresolved: true, launchedAt: new Date().toISOString() },
				],
			},
			actor,
			dependencies,
		);
		this.#live.add(id);
	}
	async #settle(
		actor: Actor,
		id: string,
		kind: string,
		result: unknown,
		known: boolean,
		related: string[] = [],
		update?: (draft: ControllerCheckpoint) => void,
		patch: RunStatePatch = {},
	): Promise<void> {
		const state = this.owner.getState();
		const resultRef = await this.#retain(
			`effect-result-${id}`,
			{ kind: "effect-result", runId: state.run.id, id, actor: actor.id, known, result },
			true,
		);
		const ids = new Set([id, ...related]);
		try {
			await this.#transition(
				"effect-settled",
				{ id, kind, known, result: resultRef },
				{
					...patch,
					pendingEffects: known
						? state.pendingEffects.filter(effect => !ids.has(effect.id))
						: state.pendingEffects,
				},
				actor,
				[resultRef],
				update,
			);
		} finally {
			for (const effectId of ids) this.#live.delete(effectId);
		}
	}

	async #transition(
		event: string,
		payload: unknown,
		patch: RunStatePatch,
		actor?: Actor,
		dependencies: FileEvidenceRef[] = [],
		update?: (draft: ControllerCheckpoint) => void,
		activation?: { handoffId: string; sessionId: string; sessionFile: string } | { kind: "takeover" },
	): Promise<void> {
		const started = performance.now();
		try {
			if (this.#failed) throw this.#fault;
			const state = this.owner.getState();
			if (!this.#policyRef || !this.#projectionRef) throw new Error("Controller authority is not initialized");
			const eventId = randomUUID();
			const eventRef = await this.#retain(`event-${event}`, {
				version: 1,
				eventId,
				event,
				runId: state.run.id,
				generation: state.owner.generation,
				at: new Date().toISOString(),
				payload,
			});
			const draft: ControllerCheckpoint = this.#checkpoint
				? structuredClone(this.#checkpoint)
				: {
						kind: "continuation-controller",
						version: 1,
						runId: state.run.id,
						generation: state.owner.generation,
						previous: null,
						event: eventRef,
						policy: this.#policyRef,
						projection: this.#projectionRef,
						actors: [],
						transcripts: {},
						blocks: [],
						sourceDenials: [],
						acceptedJobs: {},
						requestCount: 0,
						unknownRequestsUsed: 0,
						destinationAttempts: 0,
						rejectedDestinations: [],
						failedOwners: [],
						destinationSessions: [],
						transcriptBytesCopied: 0,
						transcriptBytesHashed: 0,
					};
			draft.previous = this.#checkpointRef;
			draft.event = eventRef;
			draft.policy = this.#policyRef;
			draft.projection = this.#projectionRef;
			draft.generation = state.owner.generation + (activation ? 1 : 0);
			if (actor) {
				const previous = draft.transcripts[actor.sessionId];
				const sameGeneration = previous?.cursor.generation === actor.manager.getContinuationEvidenceGeneration();
				const retained: ContinuationEvidenceRetention = await actor.manager.retainContinuationEvidence({
					destinationPath:
						sameGeneration && previous
							? previous.evidence.path
							: path.join(this.owner.getControlDir(), "transcripts", `${randomUUID()}.jsonl`),
					previous:
						sameGeneration && previous
							? { ...previous.cursor, path: previous.evidence.path, sha256: previous.evidence.sha256 }
							: undefined,
				});
				draft.transcripts[actor.sessionId] = { evidence: retained.evidence, cursor: retained.cursor };
				draft.transcriptBytesCopied += retained.metrics.bytesCopied;
				draft.transcriptBytesHashed += retained.metrics.bytesHashed;
				dependencies.push(retained.evidence);
				const record = {
					id: actor.id,
					role: actor.role,
					sessionId: actor.sessionId,
					sessionFile: actor.sessionFile,
					generation: actor.generation,
					destination: actor.destination,
					endpoint: actor.endpoint,
					api: actor.api,
				};
				const index = draft.actors.findIndex(item => item.id === actor.id);
				if (index === -1) draft.actors.push(record);
				else draft.actors[index] = record;
			}
			update?.(draft);
			const checkpoint = await this.#retain("controller", draft);
			if (activation && "kind" in activation) {
				await this.owner.takeOverController({
					expectedGeneration: state.owner.generation,
					expectedFrontier: state.frontier,
					transitionId: eventId,
					eventId,
					frontierEvidence: [checkpoint],
					checkpointDependencies: [checkpoint, eventRef, this.#policyRef, this.#projectionRef, ...dependencies],
				});
			} else if (activation) {
				await this.owner.activateOwner({
					handoffId: activation.handoffId,
					session: { sessionId: activation.sessionId, sessionFile: activation.sessionFile },
					expectedGeneration: state.owner.generation,
					expectedFrontier: state.frontier,
					expectedPolicyRevision: this.#policy.revision,
					transitionId: eventId,
					eventId,
					frontierEvidence: [checkpoint],
					checkpointDependencies: [checkpoint, eventRef, this.#policyRef, this.#projectionRef, ...dependencies],
				});
			} else {
				await this.owner.commit({
					expectedGeneration: state.owner.generation,
					transitionId: eventId,
					eventId,
					patch: {
						...patch,
						frontier: {
							lastCommittedTransitionId: eventId,
							lastCommittedEventId: eventId,
							evidence: [checkpoint],
						},
					},
					immutableDependencies: [checkpoint, eventRef, this.#policyRef, this.#projectionRef, ...dependencies],
				});
			}
			this.#checkpoint = draft;
			this.#checkpointRef = checkpoint;
			this.#measurements.push({
				event,
				milliseconds: performance.now() - started,
				bytes: checkpoint.byteLength + eventRef.byteLength,
			});
		} catch (error) {
			this.#failed = true;
			this.#fault = error;
			throw error;
		}
	}
	async #retain(label: string, value: unknown, stable = false): Promise<FileEvidenceRef> {
		return writeImmutableJson(
			checkpointPath(
				this.owner.getControlDir(),
				this.owner.getState().run.id,
				stable ? label : `${label}-${randomUUID()}`,
			),
			value,
			this.#io,
		);
	}
	async #verifyEvidence(ref: FileEvidenceRef): Promise<Buffer> {
		if ((await fs.realpath(ref.path)) !== path.resolve(ref.path))
			throw new Error("Continuation evidence path is not canonical");
		const bytes = await fs.readFile(ref.path);
		if (bytes.byteLength < ref.byteLength || sha256Bytes(bytes.subarray(0, ref.byteLength)) !== ref.sha256)
			throw new Error(`Missing or changed continuation evidence: ${ref.path}`);
		return bytes.subarray(0, ref.byteLength);
	}
	async #readJson(ref: FileEvidenceRef): Promise<unknown> {
		return JSON.parse((await this.#verifyEvidence(ref)).toString("utf8"));
	}
}

function describeError(error: unknown): { name: string; message: string } {
	return error instanceof Error
		? { name: error.name, message: error.message }
		: { name: "ThrownValue", message: String(error) };
}
function requestOutcome(outcome: ContinuationRequestOutcome): unknown {
	if (outcome.kind === "returned") {
		const message: AssistantMessage = outcome.message;
		return {
			kind: outcome.kind,
			message,
			usageKnown: message.stopReason !== "error" || message.usage.totalTokens > 0,
		};
	}
	if (outcome.kind === "not-started") return { kind: outcome.kind, reason: describeError(outcome.reason) };
	return { kind: outcome.kind, error: describeError(outcome.error), partial: outcome.partial, usageKnown: false };
}
async function boundedResponseText(response: Response): Promise<string> {
	const reader = response.clone().body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (length < 65_536) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = next.value.subarray(0, 65_536 - length);
			chunks.push(chunk);
			length += chunk.byteLength;
		}
	} finally {
		// Cancelling a tee branch may wait for its unread peer; do not deadlock provider parsing.
		void reader.cancel().catch(() => undefined);
	}
	return Buffer.concat(chunks, length).toString("utf8");
}
