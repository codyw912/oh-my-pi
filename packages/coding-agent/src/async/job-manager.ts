import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { StructuredSubagentOutput } from "../task/types";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
/**
 * Extra delay after an `async-result` delivery settles (its `ASIDE_MESSAGE_COMMIT`
 * hook fires, resolving `enqueueWithReceipt()`) before retained artifacts are
 * removed. The commit hook fires when the follow-up is inserted into the
 * transcript, not after the model's next provider call has actually read it —
 * this window gives that round trip time to complete before the backing
 * `<id>.md`/`.json` files disappear out from under an advertised `agent://` URL.
 */
const RETAINED_ARTIFACTS_CLEANUP_GRACE_MS = 60_000;
/**
 * Upper bound on how long retained-artifacts cleanup waits for a hung
 * delivery sink before giving up and running cleanup anyway. Without this,
 * a sink that never settles (e.g. a yield-queue receipt whose owning
 * session is gone) would leak the temp directory for the process lifetime
 * (PR #10625 review). Matches {@link DEFAULT_RETENTION_MS}: by the time a
 * job would have been evicted anyway, there is no realistic path left for
 * the model to still read the advertised `agent://` pointer.
 */
const RETAINED_ARTIFACTS_CLEANUP_MAX_WAIT_MS = DEFAULT_RETENTION_MS;
const DEFAULT_MAX_RUNNING_JOBS = 15;
/** Abort reason used only when the owning session shuts down the entire manager. */
export const ASYNC_JOB_MANAGER_SHUTDOWN_REASON = Symbol("AsyncJobManager shutdown");

/**
 * Adaptive ("smart") `hub` poll-wait ladder (ms). A tight poll loop climbs
 * these rungs so each immediate re-poll backs off and stops spending turns on
 * "still running" frames; the floor (first rung) is the shortest wait and the
 * top rung is the longest a smart poll will ever block. Only used when
 * `async.pollWaitDuration` is set to `smart`; fixed durations wait verbatim.
 */
const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
/**
 * Going at least this long between poll calls means the agent stepped out of
 * the poll loop to do real work — the next poll drops back to the ladder floor.
 */
const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	/** Index into POLL_WAIT_LADDER_MS used for the most recent poll wait. */
	level: number;
	/** Timestamp (ms) when the most recent poll wait returned. */
	lastPollEndAt: number;
}

/** Kind of work a managed job runs; drives job-row badges and delivery labels. */
export type AsyncJobType = "bash" | "task" | "eval";

/** Settled job-body payload: delivery text plus its parsed structured output. */
export interface AsyncJobRunResult {
	text: string;
	structured?: StructuredSubagentOutput;
}

/**
 * Job-body failure that still carries the run's structured output, so a
 * strict-mode schema violation fails the job without dropping the parsed
 * (invalid) payload.
 */
export class AsyncJobError extends Error {
	constructor(
		message: string,
		readonly structured?: StructuredSubagentOutput,
	) {
		super(message);
	}
}

/** Progress metadata retained for renderers and multimodal completion delivery. */
export interface AsyncJobDetails extends Record<string, unknown> {
	/** Images recovered from command output, independent of text truncation. */
	images?: ImageContent[];
}

export interface AsyncJob {
	id: string;
	/**
	 * Stable identity for this registration. Distinct from {@link id}, which
	 * is a reusable job name: a frozen clock or a later job that reuses the
	 * same name cannot collapse two executions.
	 */
	executionId: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	/**
	 * Parsed structured completion for a job whose work selected an output
	 * schema. Set from the body's {@link AsyncJobRunResult} or from an
	 * {@link AsyncJobError}. The job row is the carrier — every delivery
	 * attempt, redelivery, and `hub` snapshot reads it from here.
	 */
	structured?: StructuredSubagentOutput;
	/** Latest tool-render details reported by the running job. */
	latestDetails?: AsyncJobDetails;
	/**
	 * Registry id of the agent that registered the job (e.g. "Main",
	 * "AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
	/**
	 * Registry id of the subagent this job runs (task/tan/vibe jobs). Lets
	 * job-view code link a job row to its AgentRegistry ref even when the job
	 * id differs from the agent id (vibe turn jobs, tan clones).
	 */
	agentId?: string;
	/**
	 * Job is registered but parked behind a caller-managed gate (e.g. a task
	 * batch semaphore). Queued jobs do not count toward the running-job limit
	 * until the caller invokes `markRunning()` from the run context.
	 */
	queued?: boolean;
	/**
	 * Disposal closure for a detached spawn's temporary artifacts directory
	 * that `runStructuredSubagent()` retained past completion (so a
	 * delayed `agent://<id>` handle in an `async-result` delivery still
	 * resolves). The manager invokes and clears this exactly once — on
	 * eviction or manager disposal — so the retained directory does not
	 * outlive the job row it was kept alive for.
	 */
	retainedArtifactsCleanup?: () => Promise<void>;
}

/** Delivery callback for a settled job's result text. */
export type AsyncJobDeliverySink = (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;

/**
 * Immutable snapshot of one settled execution, handed to a registered
 * {@link DeliveryAcceptanceHandler} before the manager marks the result
 * accepted, suppressed, or consumed.
 */
export interface DeliveryAcceptanceSnapshot {
	executionId: string;
	jobId: string;
	ownerId?: string;
	type: AsyncJobType;
	status: Exclude<AsyncJob["status"], "running">;
	label: string;
	resultText?: string;
	errorText?: string;
	structured?: StructuredSubagentOutput;
	startTime: number;
	agentId?: string;
	latestDetails?: AsyncJobDetails;
	/** True only after the registered run callback finished (cancel is not settlement). */
	executionSettled: true;
}

/**
 * Owner-scoped persistence hook. Invoked with frozen snapshots of the exact
 * executions being accepted. Throw to reject persistence: the manager leaves
 * results available and does not mark them accepted.
 */
export type DeliveryAcceptanceHandler = (receipts: readonly DeliveryAcceptanceSnapshot[]) => void | Promise<void>;

/** Launch-intent snapshot persisted before the registered run callback starts. */
export interface JobAdmissionSnapshot {
	executionId: string;
	jobId: string;
	ownerId?: string;
	type: AsyncJobType;
	label: string;
	startTime: number;
}

/**
 * Owner-scoped launch-intent hook. Invoked immediately before the registered
 * run callback. Throw to deny launch: the run is not invoked.
 */
export type JobAdmissionHandler = (intent: JobAdmissionSnapshot) => void | Promise<void>;

export interface AsyncJobManagerOptions {
	/**
	 * Delivery sink for UNOWNED completions (jobs registered without an
	 * `ownerId`). Owned deliveries route exclusively through
	 * {@link AsyncJobManager.registerDeliverySink}; when the owner has no live
	 * sink they are dead-lettered (dropped with a warning; the job row keeps
	 * the result text until retention eviction) — never routed here, which
	 * would leak one agent's result into another session.
	 */
	onJobComplete?: AsyncJobDeliverySink;
	maxRunningJobs?: number;
	retentionMs?: number;
	/**
	 * Delay after a job's `async-result` delivery settles before its retained
	 * artifacts are removed (see {@link RETAINED_ARTIFACTS_CLEANUP_GRACE_MS}).
	 * Defaults to that constant; tests override to `0` to assert cleanup
	 * without a real-time wait.
	 */
	retainedArtifactsCleanupGraceMs?: number;
	/**
	 * Upper bound on how long retained-artifacts cleanup waits for a job's
	 * delivery to settle before giving up and running cleanup anyway (see
	 * {@link RETAINED_ARTIFACTS_CLEANUP_MAX_WAIT_MS}). Defaults to that
	 * constant; tests override to a small value to assert the bound without
	 * a real-time wait.
	 */
	retainedArtifactsCleanupMaxWaitMs?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	executionId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
	/**
	 * Job-body metadata a sink needs to render the delivered result,
	 * snapshotted at enqueue time. `#deliverDelivery` falls back to
	 * reconstructing an `AsyncJob`-shaped record from this when the live job
	 * row has already been evicted (retention elapsed while delivery kept
	 * retrying) — without it, a recovered delivery would silently drop
	 * `structured` even though `text` survives on the delivery itself.
	 */
	jobSnapshot?: Pick<
		AsyncJob,
		| "executionId"
		| "type"
		| "status"
		| "startTime"
		| "label"
		| "structured"
		| "agentId"
		| "latestDetails"
		| "resultText"
		| "errorText"
	>;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobReapResult {
	settled: boolean;
	pendingJobIds: string[];
	completion: Promise<void>;
}

export interface AsyncJobRegisterOptions {
	id?: string;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Registry id of the subagent this job runs; see {@link AsyncJob.agentId}. */
	agentId?: string;
	onProgress?: (text: string, details?: AsyncJobDetails) => void | Promise<void>;
	/** Register the job in queued state; see {@link AsyncJob.queued}. */
	queued?: boolean;
}

/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "Main", "AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, AsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	/** Temporary foreground-wait suppression, keyed by execution id. */
	readonly #tempSuppressed = new Set<string>();
	/** Foreground acknowledge/consume suppression, keyed by execution id. */
	readonly #deliveryAcknowledged = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #consumedExecutions = new Set<string>();
	readonly #acceptedExecutions = new Set<string>();
	/** Executions whose run callback finished (cancel status is not enough). */
	readonly #runSettled = new Set<string>();
	/** Owner bound at registration when an acceptance handler was active. */
	readonly #enrolledAcceptance = new Map<string, string>();
	/** Owner bound at registration when an admission handler was active. */
	readonly #enrolledAdmission = new Map<string, string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new Map<string | undefined, PollEscalationState>();
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #acceptanceHandlers = new Map<string, DeliveryAcceptanceHandler>();
	readonly #admissionHandlers = new Map<string, JobAdmissionHandler>();
	readonly #persistInFlight = new Map<string, Promise<void>>();
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	readonly #retainedArtifactsCleanupGraceMs: number;
	readonly #retainedArtifactsCleanupMaxWaitMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#deliveryQueueChanged = Promise.withResolvers<void>();
	#disposed = false;

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return Array.from(jobs);
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (job.ownerId === ownerId) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
		this.#retainedArtifactsCleanupGraceMs = Math.max(
			0,
			Math.floor(options.retainedArtifactsCleanupGraceMs ?? RETAINED_ARTIFACTS_CLEANUP_GRACE_MS),
		);
		this.#retainedArtifactsCleanupMaxWaitMs = Math.max(
			0,
			Math.floor(options.retainedArtifactsCleanupMaxWaitMs ?? RETAINED_ARTIFACTS_CLEANUP_MAX_WAIT_MS),
		);
	}

	/** True when the running-job count has reached the configured cap. */
	get atCapacity(): boolean {
		if (this.#disposed) return true;
		// Mirror register(): queued jobs hold no execution slot.
		let activeCount = 0;
		for (const job of this.#jobs.values()) {
			if (job.status === "running" && !job.queued) activeCount++;
		}
		return activeCount >= this.#maxRunningJobs;
	}

	register(
		type: AsyncJobType,
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: AsyncJobDetails) => Promise<void>;
			/** Clear the queued flag once the job actually starts executing. */
			markRunning: () => void;
		}) => Promise<string | AsyncJobRunResult>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		// Queued jobs hold no execution slot yet — only count jobs that are
		// actually running so a large parked batch cannot starve registration.
		let activeCount = 0;
		for (const existing of this.#jobs.values()) {
			if (existing.status === "running" && !existing.queued) activeCount++;
		}
		if (activeCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		const id = this.#resolveJobId(options?.id);
		const executionId = this.#allocateExecutionId();
		const abortController = new AbortController();
		const startTime = Date.now();
		const ownerId = options?.ownerId;

		const job: AsyncJob = {
			id,
			executionId,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId,
			agentId: options?.agentId,
			queued: options?.queued === true,
		};
		if (ownerId && this.#acceptanceHandlers.has(ownerId)) this.#enrolledAcceptance.set(executionId, ownerId);
		if (ownerId && this.#admissionHandlers.has(ownerId)) this.#enrolledAdmission.set(executionId, ownerId);

		const reportProgress = async (text: string, details?: AsyncJobDetails): Promise<void> => {
			if (details) job.latestDetails = details;
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			let deliveryText: string | undefined;
			try {
				if (this.#enrolledAdmission.has(executionId)) {
					const launched = await this.#admitRegisteredRun(job);
					if (!launched || abortController.signal.aborted) return;
				}
				const outcome = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					markRunning: () => {
						job.queued = false;
					},
				});
				const text = typeof outcome === "string" ? outcome : outcome.text;
				const structured = typeof outcome === "string" ? undefined : outcome.structured;
				if (structured) job.structured = structured;
				if (job.status === "cancelled") {
					job.resultText = text;
					return;
				}
				job.status = "completed";
				job.resultText = text;
				deliveryText = text;
			} catch (error) {
				if (error instanceof AsyncJobError && error.structured) job.structured = error.structured;
				if (job.status === "cancelled") {
					job.errorText = error instanceof Error ? error.message : String(error);
					return;
				}
				const errorText = error instanceof Error ? error.message : String(error);
				job.status = "failed";
				job.errorText = errorText;
				deliveryText = errorText;
			} finally {
				this.#runSettled.add(executionId);
				if (deliveryText !== undefined) this.#enqueueDelivery(id, deliveryText);
				else await this.#acceptCancelledSettlement(job);
				this.#scheduleEviction(id);
			}
		})();

		this.#jobs.set(id, job);
		return id;
	}

	/**
	 * Cancel a single job by id. When `filter.ownerId` is set and does not
	 * match the job's owner, the call is treated as not-found (returns false)
	 * so cross-agent cancellation is rejected at the manager level.
	 */
	cancel(id: string, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		job.status = "cancelled";
		job.abortController.abort();
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
		}
		this.#notifyDeliveryQueueChanged();
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#watchedJobs.delete(jobId)) {
				removed += 1;
			}
		}
		return removed;
	}

	/**
	 * Compute the next adaptive ("smart") wait (ms) for a blocking `hub` wait by
	 * the given owner. Consecutive polls — those starting within
	 * POLL_ESCALATION_RESET_MS of the previous poll returning — climb
	 * POLL_WAIT_LADDER_MS so a tight wait loop backs off; a longer gap means the
	 * agent left to do real work, so the wait resets to the floor. Pair each call
	 * with `recordPollWaitEnd()` once the wait returns.
	 */
	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now()): number {
		const prev = this.#pollEscalation.get(ownerId);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(ownerId, { level, lastPollEndAt: prev?.lastPollEndAt ?? now });
		return POLL_WAIT_LADDER_MS[level];
	}

	/**
	 * Mark a blocking poll wait as finished so the idle-reset window is measured
	 * from now. Polling again before POLL_ESCALATION_RESET_MS elapses keeps
	 * climbing the ladder; waiting longer resets it to the floor.
	 */
	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now()): void {
		const prev = this.#pollEscalation.get(ownerId);
		this.#pollEscalation.set(ownerId, { level: prev?.level ?? 0, lastPollEndAt: now });
	}

	/**
	 * Temporarily suppress delivery for a live foreground wait. Does not persist,
	 * consume, or count as quiescence. Pair with {@link resumeDeliveries} if the
	 * wait backgrounds the job instead of recovering its result.
	 */
	suppressDeliveries(jobIds: string[]): number {
		const uniqueJobIds = this.#uniqueJobIds(jobIds);
		let suppressed = 0;
		for (const jobId of uniqueJobIds) {
			const job = this.#jobs.get(jobId);
			if (!job) continue;
			if (this.#tempSuppressed.has(job.executionId)) continue;
			this.#tempSuppressed.add(job.executionId);
			suppressed += 1;
		}
		this.#dropSuppressedQueuedDeliveries();
		return suppressed;
	}

	/**
	 * Persist then suppress queued delivery for settled executions. A registered
	 * owner handler runs before flags change; failure leaves results available.
	 */
	async acknowledgeDeliveries(jobIds: string[]): Promise<number> {
		const snapshots = this.#snapshotSettled(jobIds);
		if (snapshots.length > 0) await this.#persistSnapshots(snapshots);
		const before = this.#deliveries.length;
		const requested = new Set(jobIds);
		for (const queue of [this.#deliveries, this.#inFlightDeliveries]) {
			for (const delivery of queue) {
				// Unaccepted enrolled executions cannot be evicted. An orphan here
				// is therefore ordinary or already durably accepted.
				if (requested.has(delivery.jobId) && !this.#jobs.has(delivery.jobId)) {
					this.#deliveryAcknowledged.add(delivery.executionId);
				}
			}
		}
		for (const snapshot of snapshots) {
			if (!this.#stillCurrent(snapshot)) continue;
			this.#deliveryAcknowledged.add(snapshot.executionId);
			this.#maybeScheduleEviction(snapshot.jobId);
		}
		this.#dropSuppressedQueuedDeliveries();
		return before - this.#deliveries.length;
	}

	/**
	 * Persist then mark settled results recovered by a foreground snapshot.
	 *
	 * Suppresses queued delivery and marks retained bodies as consumed so later
	 * snapshots report execution state without replaying the same result.
	 */
	async consumeJobResults(jobIds: string[]): Promise<number> {
		const snapshots = this.#snapshotSettled(jobIds);
		if (snapshots.length === 0) return 0;
		await this.#persistSnapshots(snapshots);
		let consumed = 0;
		for (const snapshot of snapshots) {
			if (!this.#stillCurrent(snapshot)) continue;
			this.#deliveryAcknowledged.add(snapshot.executionId);
			this.#maybeScheduleEviction(snapshot.jobId);
			if (this.#consumeExecution(snapshot.jobId, snapshot.executionId)) consumed += 1;
		}
		this.#dropSuppressedQueuedDeliveries();
		return consumed;
	}

	/** True once a result was auto-delivered or recovered by a foreground snapshot. */
	isJobResultConsumed(jobId: string): boolean {
		const job = this.#jobs.get(jobId);
		if (!job) return false;
		return this.#consumedExecutions.has(job.executionId);
	}

	/**
	 * Lift a foreground-wait suppression set via {@link suppressDeliveries}. If
	 * the job already finished while suppressed (its delivery enqueue was
	 * skipped), re-enqueue the completion so the result is still delivered
	 * exactly once. Does not undo an accepted/consumed receipt.
	 */
	resumeDeliveries(jobIds: string[]): void {
		for (const jobId of this.#uniqueJobIds(jobIds)) {
			const job = this.#jobs.get(jobId);
			if (!job || !this.#tempSuppressed.delete(job.executionId)) continue;
			if (this.#deliveryAcknowledged.has(job.executionId)) continue;
			if (!this.#runSettled.has(job.executionId)) continue;
			if (job.status !== "completed" && job.status !== "failed") continue;
			const queued =
				this.#deliveries.some(delivery => delivery.executionId === job.executionId) ||
				this.#inFlightDeliveries.some(delivery => delivery.executionId === job.executionId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.status === "completed" ? (job.resultText ?? "") : (job.errorText ?? ""));
		}
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 *
	 * `reason` is forwarded to each job's `AbortController.abort`, so a session
	 * teardown can tag its owned jobs with {@link ASYNC_JOB_MANAGER_SHUTDOWN_REASON}
	 * before `dispose()` runs — the task executor reads it to park (not
	 * tombstone) a subagent interrupted purely by process shutdown.
	 */
	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#cancelJobs(filter, reason);
	}

	#cancelJobs(filter?: AsyncJobFilter, reason?: unknown): void {
		for (const job of this.getRunningJobs(filter)) {
			job.status = "cancelled";
			job.abortController.abort(reason);
		}
	}

	/**
	 * Immediately evict completed and failed jobs matching the filter instead of
	 * waiting for retention expiry, dropping every queued delivery so a prior
	 * session's result can never be injected into a later transcript. Returns the
	 * number of jobs evicted.
	 *
	 * Enrolled unaccepted executions stay until a bound owner handler persists
	 * them. Live cancelled work is not evicted until the run actually finishes.
	 */
	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const job of this.#filterJobs(this.#jobs.values(), filter)) {
			if (job.status !== "completed" && job.status !== "failed") continue;
			if (!this.#runSettled.has(job.executionId)) continue;
			if (this.#mustRetainUnaccepted(job)) continue;
			this.#deliveryAcknowledged.add(job.executionId);
			this.#dropSuppressedQueuedDeliveries();
			if (this.#evictJob(job.id)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	/**
	 * Route completions for jobs owned by `ownerId` to `sink`. Sessions register
	 * their own sink at construction and unregister on dispose. Owned deliveries
	 * with no live sink are dead-lettered — `onJobComplete` serves only unowned
	 * deliveries.
	 *
	 * Last registration wins for an owner id; the returned unregister clears the
	 * mapping only while it still points at `sink`, so a revived session's fresh
	 * registration survives its parked predecessor's late cleanup.
	 */
	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		return () => {
			if (this.#deliverySinks.get(ownerId) === sink) this.#deliverySinks.delete(ownerId);
		};
	}

	/**
	 * Register the persistence hook invoked before a settled execution is
	 * accepted, suppressed, or consumed. Inert until an actual acceptance.
	 * Duplicate active ownership for the same owner id is rejected.
	 */
	registerDeliveryAcceptance(ownerId: string, handler: DeliveryAcceptanceHandler): () => void {
		if (this.#acceptanceHandlers.has(ownerId)) {
			throw new Error(`Delivery acceptance already registered for owner ${ownerId}`);
		}
		this.#acceptanceHandlers.set(ownerId, handler);
		return () => {
			if (this.#acceptanceHandlers.get(ownerId) === handler) this.#acceptanceHandlers.delete(ownerId);
		};
	}

	/**
	 * Register the launch-intent hook invoked immediately before the registered
	 * run callback. Inert until a matching enrolled execution is admitted.
	 * Duplicate active ownership for the same owner id is rejected.
	 */
	registerJobAdmission(ownerId: string, handler: JobAdmissionHandler): () => void {
		if (this.#admissionHandlers.has(ownerId)) {
			throw new Error(`Job admission already registered for owner ${ownerId}`);
		}
		this.#admissionHandlers.set(ownerId, handler);
		return () => {
			if (this.#admissionHandlers.get(ownerId) === handler) this.#admissionHandlers.delete(ownerId);
		};
	}

	/**
	 * Wait until every job owned by `ownerId` has actually settled — its run
	 * promise resolved, which for cancelled jobs means the underlying process
	 * actually exited. Replacements under a reused name are tracked by
	 * execution id. Returns false when `timeoutMs` elapses first.
	 *
	 * `excludeSuppressed` is wake-oriented: skipped jobs cannot re-wake a run.
	 * Continuation quiescence must omit it so live suppressed work is awaited.
	 */
	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<string>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(job => {
				if (awaited.has(job.executionId) || this.#runSettled.has(job.executionId)) return false;
				if (options?.excludeSuppressed === true && this.isDeliverySuppressed(job.id)) return false;
				return true;
			});
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job.executionId);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	/**
	 * Cancel every job owned by `ownerId`, then wait only until `deadlineAt`.
	 * The returned completion keeps waiting for actual process settlement when
	 * the deadline expires, so callers can move that cleanup out of the
	 * user-visible Task wait without losing ownership of the live work.
	 */
	async cancelAndReapOwnerJobs(ownerId: string, deadlineAt: number): Promise<AsyncJobReapResult> {
		this.cancelAll({ ownerId });
		const timeoutMs = Math.max(0, deadlineAt - Date.now());
		const settled = await this.waitForOwnerJobs(ownerId, { timeoutMs });
		if (settled) {
			return { settled: true, pendingJobIds: [], completion: Promise.resolve() };
		}
		const pendingJobIds = this.getAllJobs({ ownerId })
			.filter(job => job.status === "running" || job.status === "cancelled")
			.map(job => job.id);
		const completion = this.waitForOwnerJobs(ownerId).then(() => {});
		return { settled: false, pendingJobIds, completion };
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.#cancelJobs(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		this.#clearEvictionTimers();
		// Bypass the grace-period sleep: dispose has already drained/cancelled
		// deliveries above, so there is nothing left for the model to read via
		// `agent://<id>` — sleeping the retention window here would only leak
		// temp dirs for up to `retainedArtifactsCleanupGraceMs` (or past
		// process exit, since dispose does not await these cleanups).
		for (const job of this.#jobs.values()) this.#runRetainedArtifactsCleanup(job, { bypassGrace: true });
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#notifyDeliveryQueueChanged();
		this.#inFlightDeliveries.length = 0;
		this.#tempSuppressed.clear();
		this.#deliveryAcknowledged.clear();
		this.#watchedJobs.clear();
		this.#consumedExecutions.clear();
		this.#acceptedExecutions.clear();
		this.#runSettled.clear();
		this.#enrolledAcceptance.clear();
		this.#enrolledAdmission.clear();
		this.#pollEscalation.clear();
		this.#deliverySinks.clear();
		this.#acceptanceHandlers.clear();
		this.#admissionHandlers.clear();
		this.#persistInFlight.clear();
		return jobsSettled && drained;
	}

	#consumeExecution(jobId: string, executionId: string): boolean {
		const job = this.#jobs.get(jobId);
		if (!job || job.executionId !== executionId || job.status === "running") return false;
		if (this.#consumedExecutions.has(executionId)) return false;
		if (job.resultText === undefined && job.errorText === undefined) return false;
		this.#consumedExecutions.add(executionId);
		return true;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	/**
	 * Fire a retained temporary artifacts cleanup exactly once, deferred
	 * until this job's `async-result` delivery has settled (delivered,
	 * dead-lettered, or given up retrying) plus a grace period. Job-row
	 * eviction happens on its own timer independent of delivery — a still-
	 * streaming owner session can leave a delivery in flight (its sink
	 * awaits `yieldQueue.enqueueWithReceipt()`) well past the retention
	 * window, and deleting the retained directory before that receipt
	 * settles would advertise an `agent://` URL whose backing files are
	 * already gone.
	 * The receipt itself resolves at `ASIDE_MESSAGE_COMMIT` — when the
	 * follow-up is inserted into the transcript, but *before* the next
	 * provider call that actually shows it to the model (agent-loop fires
	 * the commit hook, then starts the call). Running cleanup immediately
	 * on settlement would delete the artifacts before the model's very next
	 * turn has any chance to read the pointer via a tool call, so a grace
	 * period covers that round trip.
	 * Errors are logged, not thrown — a failed disposal must not block job
	 * eviction or manager teardown.
	 */
	#runRetainedArtifactsCleanup(job: AsyncJob, options?: { bypassGrace?: boolean }): void {
		const cleanup = job.retainedArtifactsCleanup;
		if (!cleanup) return;
		job.retainedArtifactsCleanup = undefined;
		const jobId = job.id;
		const bypassGrace = options?.bypassGrace === true;
		void this.#waitForJobDeliverySettledBounded(jobId)
			.then(() =>
				!bypassGrace && this.#retainedArtifactsCleanupGraceMs > 0
					? Bun.sleep(this.#retainedArtifactsCleanupGraceMs)
					: undefined,
			)
			.then(cleanup)
			.catch(error => {
				logger.warn("Async job retained artifacts cleanup failed", {
					jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/**
	 * Bounded variant of {@link #waitForJobDeliverySettled}: gives up and
	 * resolves after {@link #retainedArtifactsCleanupMaxWaitMs} even if the
	 * delivery sink never settles (e.g. a yield-queue receipt whose owning
	 * session is gone) so a hung sink cannot leak the retained temp
	 * directory for the process lifetime (PR #10625 review). The unbounded
	 * wait keeps running in the background after the bound trips; it is
	 * harmless once orphaned since cleanup no longer depends on it.
	 */
	async #waitForJobDeliverySettledBounded(jobId: string): Promise<void> {
		const timedOut = Promise.withResolvers<true>();
		const timer = setTimeout(() => timedOut.resolve(true), this.#retainedArtifactsCleanupMaxWaitMs);
		timer.unref();
		try {
			const timedOutFirst = await Promise.race([
				this.#waitForJobDeliverySettled(jobId).then(() => false as const),
				timedOut.promise,
			]);
			if (timedOutFirst) {
				logger.warn(
					"Async job delivery did not settle before the retained artifacts cleanup bound; running cleanup anyway",
					{
						jobId,
						maxWaitMs: this.#retainedArtifactsCleanupMaxWaitMs,
					},
				);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Resolve once no delivery for `jobId` is queued or in flight. Loops
	 * because a failed in-flight attempt may requeue itself for retry;
	 * terminates once the delivery succeeds, is dead-lettered (no live
	 * sink), or stops retrying (job already evicted from `#jobs`).
	 */
	async #waitForJobDeliverySettled(jobId: string): Promise<void> {
		for (;;) {
			const inFlight = this.#inFlightDeliveries.find(delivery => delivery.jobId === jobId);
			if (inFlight) {
				await inFlight.promise?.catch(() => {});
				continue;
			}
			const queued = this.#deliveries.find(delivery => delivery.jobId === jobId);
			if (!queued) return;
			this.#ensureDeliveryLoop();
			await this.#waitForDeliveryQueueChange(Math.max(50, queued.nextAttemptAt - Date.now()));
		}
	}

	#evictJob(jobId: string): boolean {
		const job = this.#jobs.get(jobId);
		if (job && !this.#disposed) {
			if (!this.#runSettled.has(job.executionId)) return false;
			if (this.#mustRetainUnaccepted(job)) return false;
		}
		clearTimeout(this.#evictionTimers.get(jobId));
		this.#evictionTimers.delete(jobId);
		this.#watchedJobs.delete(jobId);
		if (job) {
			this.#tempSuppressed.delete(job.executionId);
			this.#deliveryAcknowledged.delete(job.executionId);
			this.#consumedExecutions.delete(job.executionId);
			this.#acceptedExecutions.delete(job.executionId);
			this.#enrolledAcceptance.delete(job.executionId);
			this.#enrolledAdmission.delete(job.executionId);
			this.#runRetainedArtifactsCleanup(job);
		}
		return this.#jobs.delete(jobId);
	}

	#scheduleEviction(jobId: string): void {
		if (this.#disposed) return;
		const job = this.#jobs.get(jobId);
		if (job && !this.#runSettled.has(job.executionId)) return;
		if (job && this.#mustRetainUnaccepted(job)) return;
		if (this.#retentionMs <= 0) {
			this.#evictJob(jobId);
			return;
		}
		const existing = this.#evictionTimers.get(jobId);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			const current = this.#jobs.get(jobId);
			if (current && !this.#runSettled.has(current.executionId)) return;
			if (current && this.#mustRetainUnaccepted(current)) {
				this.#evictionTimers.delete(jobId);
				return;
			}
			this.#evictJob(jobId);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(jobId, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#deliveries.filter(delivery => !this.#isDeliveryRecordSuppressed(delivery));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.#isDeliveryRecordSuppressed(delivery),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#inFlightDeliveries.filter(delivery => !this.#isDeliveryRecordSuppressed(delivery));
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.#isDeliveryRecordSuppressed(delivery),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.#isDeliveryRecordSuppressed(delivery)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await this.#waitForDeliveryQueueChange(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			this.#notifyDeliveryQueueChanged();
			if (this.#isDeliveryRecordSuppressed(selected)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	isDeliverySuppressed(jobId: string): boolean {
		if (this.#watchedJobs.has(jobId)) return true;
		const job = this.#jobs.get(jobId);
		if (!job) return false;
		return this.#tempSuppressed.has(job.executionId) || this.#deliveryAcknowledged.has(job.executionId);
	}

	#isDeliveryRecordSuppressed(delivery: AsyncJobDelivery): boolean {
		if (this.#watchedJobs.has(delivery.jobId)) return true;
		return this.#tempSuppressed.has(delivery.executionId) || this.#deliveryAcknowledged.has(delivery.executionId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		const job = this.#jobs.get(jobId);
		if (!job) return;
		if (this.isDeliverySuppressed(jobId)) return;
		this.#queueDelivery({
			jobId,
			executionId: job.executionId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: job.ownerId,
			jobSnapshot: {
				executionId: job.executionId,
				type: job.type,
				status: job.status,
				startTime: job.startTime,
				label: job.label,
				structured: job.structured,
				agentId: job.agentId,
				latestDetails: job.latestDetails,
				resultText: job.resultText,
				errorText: job.errorText,
			},
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.#isDeliveryRecordSuppressed(delivery)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await this.#waitForDeliveryQueueChange(waitMs);
				continue;
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.#isDeliveryRecordSuppressed(delivery)) {
				this.#deliveries.shift();
				continue;
			}

			this.#deliveries.shift();
			void this.#deliverDelivery(delivery);
		}
	}

	/**
	 * Resolve the sink for one delivery attempt: owned deliveries route ONLY to
	 * their owner's registered sink (a missing sink dead-letters — never the
	 * default, which would misroute a dead owner's result into another
	 * session); unowned deliveries use the constructor default. Resolved per
	 * attempt so a sink registered between retries (e.g. a revived session)
	 * picks up the retry.
	 */
	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			// Dead-letter: owned delivery with no live sink (session disposed or
			// parked), or unowned delivery with no default sink. Drop it — the
			// job row keeps its result/error text until retention eviction, so
			// the outcome stays inspectable via job queries and agent:// reads.
			logger.warn("Async job delivery dead-lettered: no delivery sink", {
				jobId: delivery.jobId,
				ownerId: delivery.ownerId,
			});
			delivery.promise = Promise.resolve();
			return delivery.promise;
		}
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			try {
				if (this.#enrolledAcceptance.has(delivery.executionId)) {
					const snapshot = this.#snapshotFromDelivery(delivery);
					if (snapshot) {
						await this.#persistSnapshots([snapshot]);
						this.#maybeScheduleEviction(snapshot.jobId);
					}
				}
				if (this.#isDeliveryRecordSuppressed(delivery)) return;
				await sink(delivery.jobId, delivery.text, this.#resolveDeliveryJob(delivery));
				this.#consumeExecution(delivery.jobId, delivery.executionId);
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.#isDeliveryRecordSuppressed(delivery) && this.#jobs.has(delivery.jobId)) {
					this.#queueDelivery(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	#resolveDeliveryJob(delivery: AsyncJobDelivery): AsyncJob | undefined {
		const current = this.#jobs.get(delivery.jobId);
		if (current?.executionId === delivery.executionId) return current;
		return this.#reconstructEvictedJob(delivery);
	}

	/**
	 * Rebuild a minimal {@link AsyncJob} from a delivery's enqueue-time
	 * snapshot when the live job row was already evicted or replaced.
	 */
	#reconstructEvictedJob(delivery: AsyncJobDelivery): AsyncJob | undefined {
		const snapshot = delivery.jobSnapshot;
		if (!snapshot) return undefined;
		return {
			id: delivery.jobId,
			executionId: snapshot.executionId,
			type: snapshot.type,
			status: snapshot.status,
			startTime: snapshot.startTime,
			label: snapshot.label,
			abortController: new AbortController(),
			promise: Promise.resolve(),
			resultText: snapshot.resultText,
			errorText: snapshot.errorText,
			structured: snapshot.structured,
			agentId: snapshot.agentId,
			latestDetails: snapshot.latestDetails,
		};
	}

	#queueDelivery(delivery: AsyncJobDelivery): void {
		const index = this.#deliveries.findIndex(candidate => candidate.nextAttemptAt > delivery.nextAttemptAt);
		if (index === -1) this.#deliveries.push(delivery);
		else this.#deliveries.splice(index, 0, delivery);
		this.#notifyDeliveryQueueChanged();
	}

	async #waitForDeliveryQueueChange(delayMs: number): Promise<void> {
		const timerElapsed = Promise.withResolvers<void>();
		const timer = setTimeout(timerElapsed.resolve, delayMs);
		timer.unref();
		try {
			await Promise.race([timerElapsed.promise, this.#deliveryQueueChanged.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#notifyDeliveryQueueChanged(): void {
		this.#deliveryQueueChanged.resolve();
		this.#deliveryQueueChanged = Promise.withResolvers<void>();
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}

	#uniqueJobIds(jobIds: string[]): string[] {
		return Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
	}

	#allocateExecutionId(): string {
		return crypto.randomUUID();
	}

	#mustRetainUnaccepted(job: AsyncJob): boolean {
		return this.#enrolledAcceptance.has(job.executionId) && !this.#acceptedExecutions.has(job.executionId);
	}

	#stillCurrent(snapshot: DeliveryAcceptanceSnapshot): boolean {
		const job = this.#jobs.get(snapshot.jobId);
		return job?.executionId === snapshot.executionId;
	}

	#maybeScheduleEviction(jobId: string): void {
		if (this.#evictionTimers.has(jobId)) return;
		this.#scheduleEviction(jobId);
	}

	#dropSuppressedQueuedDeliveries(): void {
		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.#isDeliveryRecordSuppressed(delivery)),
		);
		if (before !== this.#deliveries.length) this.#notifyDeliveryQueueChanged();
	}

	#freezeTree(value: unknown): unknown {
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value)) {
			for (const item of value) this.#freezeTree(item);
		} else {
			for (const item of Object.values(value)) this.#freezeTree(item);
		}
		return Object.freeze(value);
	}

	#freezeRetained<T>(value: T): T {
		return this.#freezeTree(structuredClone(value)) as T;
	}

	#freezeJob(job: AsyncJob): DeliveryAcceptanceSnapshot {
		return Object.freeze({
			executionId: job.executionId,
			jobId: job.id,
			ownerId: job.ownerId,
			type: job.type,
			status: job.status as Exclude<AsyncJob["status"], "running">,
			label: job.label,
			resultText: job.resultText,
			errorText: job.errorText,
			structured: job.structured === undefined ? undefined : this.#freezeRetained(job.structured),
			startTime: job.startTime,
			agentId: job.agentId,
			latestDetails: job.latestDetails === undefined ? undefined : this.#freezeRetained(job.latestDetails),
			executionSettled: true as const,
		});
	}

	#snapshotSettled(jobIds: string[]): DeliveryAcceptanceSnapshot[] {
		const snapshots: DeliveryAcceptanceSnapshot[] = [];
		for (const jobId of this.#uniqueJobIds(jobIds)) {
			const job = this.#jobs.get(jobId);
			if (!job || job.status === "running" || !this.#runSettled.has(job.executionId)) continue;
			if (this.#enrolledAcceptance.has(job.executionId)) {
				snapshots.push(this.#freezeJob(job));
				continue;
			}
			snapshots.push(
				Object.freeze({
					executionId: job.executionId,
					jobId: job.id,
					ownerId: job.ownerId,
					type: job.type,
					status: job.status as Exclude<AsyncJob["status"], "running">,
					label: job.label,
					resultText: job.resultText,
					errorText: job.errorText,
					startTime: job.startTime,
					agentId: job.agentId,
					executionSettled: true as const,
				}),
			);
		}
		return snapshots;
	}

	#snapshotFromDelivery(delivery: AsyncJobDelivery): DeliveryAcceptanceSnapshot | undefined {
		const job = this.#jobs.get(delivery.jobId);
		if (job && job.executionId === delivery.executionId) {
			if (job.status === "running" || !this.#runSettled.has(job.executionId)) return undefined;
			return this.#freezeJob(job);
		}
		const snap = delivery.jobSnapshot;
		if (!snap || snap.status === "running") return undefined;
		return Object.freeze({
			executionId: delivery.executionId,
			jobId: delivery.jobId,
			ownerId: delivery.ownerId,
			type: snap.type,
			status: snap.status,
			label: snap.label,
			resultText: snap.resultText,
			errorText: snap.errorText,
			structured: snap.structured === undefined ? undefined : this.#freezeRetained(snap.structured),
			startTime: snap.startTime,
			agentId: snap.agentId,
			latestDetails: snap.latestDetails === undefined ? undefined : this.#freezeRetained(snap.latestDetails),
			executionSettled: true as const,
		});
	}

	/**
	 * Persist an enrolled cancelled execution after the run callback actually
	 * finishes. Cancellation stays distinct from model delivery: this does not
	 * enqueue a sink payload, consume the result, or treat persist failure as
	 * settlement.
	 */
	async #acceptCancelledSettlement(job: AsyncJob): Promise<void> {
		if (job.status !== "cancelled") return;
		if (!this.#enrolledAcceptance.has(job.executionId)) return;
		try {
			await this.#persistSnapshots([this.#freezeJob(job)]);
		} catch (error) {
			logger.warn("Async job cancelled settlement persistence failed", {
				jobId: job.id,
				executionId: job.executionId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #persistSnapshots(snapshots: DeliveryAcceptanceSnapshot[]): Promise<void> {
		const pending: DeliveryAcceptanceSnapshot[] = [];
		const joining: Promise<void>[] = [];
		for (const snapshot of snapshots) {
			if (this.#acceptedExecutions.has(snapshot.executionId)) continue;
			const inflight = this.#persistInFlight.get(snapshot.executionId);
			if (inflight) joining.push(inflight);
			else pending.push(snapshot);
		}
		if (pending.length === 0) {
			if (joining.length > 0) await Promise.all(joining);
			return;
		}
		const work = this.#invokeAcceptanceHandlers(pending);
		for (const snapshot of pending) this.#persistInFlight.set(snapshot.executionId, work);
		try {
			await Promise.all([...joining, work]);
		} finally {
			for (const snapshot of pending) {
				if (this.#persistInFlight.get(snapshot.executionId) === work) {
					this.#persistInFlight.delete(snapshot.executionId);
				}
			}
		}
	}

	async #invokeAcceptanceHandlers(snapshots: DeliveryAcceptanceSnapshot[]): Promise<void> {
		const byOwner = new Map<string | undefined, DeliveryAcceptanceSnapshot[]>();
		for (const snapshot of snapshots) {
			const boundOwner = this.#enrolledAcceptance.get(snapshot.executionId);
			const group = byOwner.get(boundOwner);
			if (group) group.push(snapshot);
			else byOwner.set(boundOwner, [snapshot]);
		}
		for (const [ownerId, group] of byOwner) {
			if (ownerId === undefined) {
				for (const snapshot of group) this.#acceptedExecutions.add(snapshot.executionId);
				continue;
			}
			const handler = this.#acceptanceHandlers.get(ownerId);
			if (!handler) {
				throw new Error(`Delivery acceptance handler missing for enrolled owner ${ownerId}`);
			}
			await handler(Object.freeze(group.slice()));
			for (const snapshot of group) this.#acceptedExecutions.add(snapshot.executionId);
		}
	}

	async #admitRegisteredRun(job: AsyncJob): Promise<boolean> {
		const ownerId = this.#enrolledAdmission.get(job.executionId);
		if (ownerId !== undefined) {
			const handler = this.#admissionHandlers.get(ownerId);
			if (!handler) {
				throw new Error(`Job admission handler missing for enrolled owner ${ownerId}`);
			}
			await handler(
				Object.freeze({
					executionId: job.executionId,
					jobId: job.id,
					ownerId: job.ownerId,
					type: job.type,
					label: job.label,
					startTime: job.startTime,
				}),
			);
		}
		if (!job.abortController.signal.aborted) return true;
		if (job.status !== "cancelled") job.status = "cancelled";
		const reason = job.abortController.signal.reason;
		if (job.errorText === undefined) {
			job.errorText = reason instanceof Error ? reason.message : reason !== undefined ? String(reason) : "aborted";
		}
		return false;
	}
}
