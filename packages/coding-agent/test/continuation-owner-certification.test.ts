import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type CanonicalPlanIdentityInput,
	type ContinuationActivation,
	type ContinuationOwnerRequest,
	type FileEvidenceRef,
	type PendingHandoff,
	checkpointPath,
	ContinuationStoreError,
	controlDirectory,
	inspectCommittedRunState,
	planKeyFromRelativePath,
	sha256Bytes,
	withContinuationOwner,
	writeImmutableJson,
} from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { continuationModel } from "./helpers/continuation-fixture";
import { makeAssistantMessage } from "./session-manager/helpers";
import {
	type CrashEnrolledPayload,
	type CrashReadyPayload,
	type PausedReloadPayload,
	CRASH_EFFECT_TEXT,
	CRASH_PLAN,
	crashEffectPath,
	crashToolCallsPath,
	openCrashContinuationRun,
} from "./fixtures/continuation/run-crash-process";

const FIXTURE = path.join(import.meta.dir, "fixtures/continuation/run-store-process.ts");
const CRASH_FIXTURE = path.join(import.meta.dir, "fixtures/continuation/run-crash-process.ts");
const CHILD_TIMEOUT_MS = 15_000;

const tempDirs: TempDir[] = [];
interface SpawnedChild {
	kill(signal?: "SIGKILL"): void;
	exited: Promise<number>;
	exitCode: number | null;
	stderr: ReadableStream;
}
const children: SpawnedChild[] = [];

function tempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return fs.realpathSync(dir.path());
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function enrollRequest(
	identity: CanonicalPlanIdentityInput,
	sessionFile: string,
	extra?: Partial<Extract<ContinuationOwnerRequest, { action: "enroll" }>["initial"]>,
): ContinuationOwnerRequest {
	return {
		action: "enroll",
		identity,
		initial: {
			runId: extra?.runId ?? "run-1",
			owner: {
				sessionId: extra?.owner?.sessionId ?? "sess-1",
				sessionFile: extra?.owner?.sessionFile ?? sessionFile,
			},
			intent: extra?.intent ?? { kind: "continue" },
			pendingEffects: extra?.pendingEffects,
			accounting: extra?.accounting,
			stop: extra?.stop,
			pendingHandoff: extra?.pendingHandoff,
		},
	};
}

function activationInput(
	sessionFile: string,
	transitionId: string,
	overrides: Partial<ContinuationActivation> = {},
): ContinuationActivation {
	return {
		expectedGeneration: 1,
		transitionId,
		handoffId: "handoff-1",
		session: { sessionId: "s2", sessionFile },
		frontierEvidence: [],
		checkpointDependencies: [],
		...overrides,
	};
}

async function writeStagedSuccessor(
	root: string,
	sessionId: string,
	contents = "staged-session\n",
): Promise<{
	sessionId: string;
	sessionFile: string;
	transcript: FileEvidenceRef;
	checkpoint: FileEvidenceRef;
}> {
	const sessionFile = path.join(root, `${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, contents);
	const bytes = fs.readFileSync(sessionFile);
	const transcript: FileEvidenceRef = {
		kind: "file",
		path: fs.realpathSync(sessionFile),
		byteLength: bytes.byteLength,
		sha256: sha256Bytes(bytes),
	};
	const checkpoint = await writeImmutableJson(path.join(root, "checkpoints", sessionId, "c1.json"), {
		kind: "checkpoint",
		sessionId,
	});
	return { sessionId, sessionFile, transcript, checkpoint };
}

function stagedHandoff(args: {
	generation: number;
	destination: {
		sessionId: string;
		sessionFile: string;
		transcript: FileEvidenceRef;
		checkpoint: FileEvidenceRef;
	};
	sourceSessionId?: string;
	sourceSessionFile?: string;
}): PendingHandoff {
	return {
		id: "handoff-1",
		phase: "staged",
		source: {
			sessionId: args.sourceSessionId ?? "sess-1",
			sessionFile: args.sourceSessionFile,
			generation: args.generation,
		},
		destination: args.destination,
		policyRevision: "pol-1",
	};
}

function readOwnerProcessResult(filePath: string): {
	ok: boolean;
	generation?: number;
	canAdmitWork?: boolean;
	message: string;
} {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!parsed || typeof parsed !== "object") return { ok: false, message: "" };
	const ok = "ok" in parsed && parsed.ok === true;
	const generation = "generation" in parsed && typeof parsed.generation === "number" ? parsed.generation : undefined;
	const canAdmitWork = "canAdmitWork" in parsed ? parsed.canAdmitWork === true : undefined;
	let message = "";
	if ("error" in parsed && parsed.error && typeof parsed.error === "object" && "message" in parsed.error) {
		const value = parsed.error.message;
		if (typeof value === "string") message = value;
	}
	return { ok, generation, canAdmitWork, message };
}

async function waitForFile(filePath: string, child: SpawnedChild): Promise<void> {
	for (;;) {
		try {
			await fsp.access(filePath);
			return;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (child.exitCode !== null) {
				const stderr = await new Response(child.stderr).text();
				const resultHint = filePath.replace(/ready\.json$/, "result.json");
				let result = "";
				try {
					result = fs.readFileSync(resultHint, "utf8");
				} catch {
					result = "";
				}
				throw new Error(
					`child exited before ${filePath} (${child.exitCode}): ${stderr}${result ? `\n${result}` : ""}`,
				);
			}
		}
	}
}

function spawnStoreProcess(config: unknown, env: Record<string, string>, fixturePath = FIXTURE): SpawnedChild {
	const configPath = path.join(tempDir("cont-cfg"), "config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
	const child = Bun.spawn([process.execPath, fixturePath, configPath], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env: { HOME: env.HOME, PATH: process.env.PATH ?? "", ...env },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	return child;
}

function seedPlan(
	root: string,
	relativePlan: string,
	sessionName: string,
): { identity: CanonicalPlanIdentityInput; sessionFile: string; relativePlan: string } {
	const planPath = path.join(root, relativePlan);
	fs.mkdirSync(path.dirname(planPath), { recursive: true });
	fs.writeFileSync(planPath, `# ${relativePlan}\n`);
	const sessionFile = path.join(root, sessionName);
	fs.writeFileSync(sessionFile, "session\n");
	return { identity: { worktree: root, planPath }, sessionFile, relativePlan };
}

function readCrashEnrolled(filePath: string): CrashEnrolledPayload {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!parsed || typeof parsed !== "object") throw new Error(`enrolled payload is not an object: ${filePath}`);
	const value = parsed as Partial<CrashEnrolledPayload>;
	if (
		typeof value.runId !== "string" ||
		typeof value.sessionId !== "string" ||
		typeof value.sessionFile !== "string" ||
		typeof value.generation !== "number" ||
		value.frontier === undefined ||
		!Array.isArray(value.pendingEffectIds) ||
		typeof value.committedEventCount !== "number" ||
		typeof value.committedTransitionCount !== "number"
	) {
		throw new Error(`incomplete enrolled payload: ${JSON.stringify(parsed)}`);
	}
	return value as CrashEnrolledPayload;
}

function readCrashReady(filePath: string): CrashReadyPayload {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!parsed || typeof parsed !== "object") throw new Error(`crash ready payload is not an object: ${filePath}`);
	const value = parsed as Partial<CrashReadyPayload>;
	if (
		(value.crashedAt !== "after-evidence-before-frontier" && value.crashedAt !== "after-effect-before-result") ||
		typeof value.pid !== "number" ||
		!Array.isArray(value.evidencePaths) ||
		typeof value.targetPath !== "string"
	) {
		throw new Error(`incomplete crash ready payload: ${JSON.stringify(parsed)}`);
	}
	return value as CrashReadyPayload;
}

function readPausedReloadResult(filePath: string): PausedReloadPayload {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!parsed || typeof parsed !== "object") throw new Error(`paused reload payload is not an object: ${filePath}`);
	const value = parsed as Partial<PausedReloadPayload>;
	if (
		typeof value.ok !== "boolean" ||
		typeof value.pid !== "number" ||
		typeof value.localhostInferenceAttempts !== "number" ||
		typeof value.localhostServerHits !== "number"
	) {
		throw new Error(`incomplete paused reload payload: ${JSON.stringify(parsed)}`);
	}
	return value as PausedReloadPayload;
}

async function runCrashChild(
	mode: "f1-evidence-before-frontier" | "f5-effect-before-result",
	root: string,
	home: string,
): Promise<{ enrolled: CrashEnrolledPayload; ready: CrashReadyPayload }> {
	const enrolledPath = path.join(root, "enrolled.json");
	const readyPath = path.join(root, "crash-ready.json");
	const child = spawnStoreProcess(
		{
			mode,
			root,
			enrolledPath,
			readyPath,
			resultPath: path.join(root, "crash-result.json"),
		},
		{ HOME: home },
		CRASH_FIXTURE,
	);
	await waitForFile(enrolledPath, child);
	await waitForFile(readyPath, child);
	expect(await child.exited).not.toBe(0);
	return { enrolled: readCrashEnrolled(enrolledPath), ready: readCrashReady(readyPath) };
}

describe("PT-01 owner/store child-process certification", () => {
	it(
		"binds competing OMP homes to one plan record and keeps same-basename plans distinct",
		async () => {
			const root = tempDir("homes-identity");
			const planA = seedPlan(root, "docs/plans/shared-name.md", "sess-a.jsonl");
			const planB = seedPlan(root, "notes/shared-name.md", "sess-b.jsonl");
			expect(planKeyFromRelativePath(planA.relativePlan)).not.toBe(planKeyFromRelativePath(planB.relativePlan));
			const homeA = tempDir("home-a");
			const homeB = tempDir("home-b");

			const readyA = path.join(root, "a-ready.json");
			const holderA = spawnStoreProcess(
				{
					mode: "hold-owner",
					request: enrollRequest(planA.identity, planA.sessionFile, { runId: "run-a" }),
					readyPath: readyA,
					resultPath: path.join(root, "a-result.json"),
				},
				{ HOME: homeA },
			);
			await waitForFile(readyA, holderA);

			const readyB = path.join(root, "b-ready.json");
			const holderB = spawnStoreProcess(
				{
					mode: "hold-owner",
					request: enrollRequest(planB.identity, planB.sessionFile, {
						runId: "run-b",
						owner: { sessionId: "sess-b", sessionFile: planB.sessionFile },
					}),
					readyPath: readyB,
					resultPath: path.join(root, "b-result.json"),
				},
				{ HOME: homeB },
			);
			await waitForFile(readyB, holderB);

			const inspectedA = await inspectCommittedRunState(planA.identity);
			const inspectedB = await inspectCommittedRunState(planB.identity);
			expect(inspectedA.controlDir).toBe(controlDirectory(inspectedA.identity));
			expect(inspectedB.controlDir).toBe(controlDirectory(inspectedB.identity));
			expect(inspectedA.controlDir).not.toBe(inspectedB.controlDir);
			expect(inspectedA.state.run.id).toBe("run-a");
			expect(inspectedB.state.run.id).toBe("run-b");
			expect(inspectedA.identity.relativePath).toBe("docs/plans/shared-name.md");
			expect(inspectedB.identity.relativePath).toBe("notes/shared-name.md");

			const challengerResult = path.join(root, "a-challenger-result.json");
			const challenger = spawnStoreProcess(
				{
					mode: "try-owner",
					request: { action: "recover", identity: planA.identity },
					readyPath: path.join(root, "a-challenger-ready.json"),
					resultPath: challengerResult,
					lockRetries: 1,
				},
				{ HOME: homeB },
			);
			expect(await challenger.exited).not.toBe(0);
			const failed = readOwnerProcessResult(challengerResult);
			expect(failed.ok).toBe(false);
			expect(failed.message).toContain("Failed to acquire lock");
			expect((await inspectCommittedRunState(planA.identity)).state.owner.generation).toBe(1);

			holderA.kill("SIGKILL");
			expect(await holderA.exited).not.toBe(0);

			const recoverResult = path.join(root, "a-recover-result.json");
			const recoverer = spawnStoreProcess(
				{
					mode: "try-owner",
					request: { action: "recover", identity: planA.identity, expectedRunId: "run-a" },
					readyPath: path.join(root, "a-recover-ready.json"),
					resultPath: recoverResult,
					lockRetries: 1,
				},
				{ HOME: homeB },
			);
			expect(await recoverer.exited).toBe(0);
			const recovered = readOwnerProcessResult(recoverResult);
			expect(recovered.ok).toBe(true);
			expect(recovered.generation).toBe(1);
			const after = await inspectCommittedRunState(planA.identity);
			expect(after.controlDir).toBe(inspectedA.controlDir);
			expect(after.state.run.id).toBe("run-a");
			expect(after.state.owner.sessionId).toBe("sess-1");
			expect(after.state.owner.generation).toBe(1);
			expect((await inspectCommittedRunState(planB.identity)).state.run.id).toBe("run-b");
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"leaves a live work child accounted for after controller death and refuses replacement work",
		async () => {
			const root = tempDir("live-child");
			const plan = seedPlan(root, "docs/plans/example.md", "session.jsonl");
			const home = tempDir("home-controller");
			const workerReady = path.join(root, "worker-ready.json");
			const worker = spawnStoreProcess(
				{
					mode: "hold-worker",
					readyPath: workerReady,
					resultPath: path.join(root, "worker-result.json"),
				},
				{ HOME: home },
			);
			await waitForFile(workerReady, worker);
			const workerReadyPayload: unknown = JSON.parse(fs.readFileSync(workerReady, "utf8"));
			if (
				!workerReadyPayload ||
				typeof workerReadyPayload !== "object" ||
				!("pid" in workerReadyPayload) ||
				typeof workerReadyPayload.pid !== "number"
			) {
				throw new Error(`work child did not publish pid: ${JSON.stringify(workerReadyPayload)}`);
			}
			const workerIdentity = `work-child-${workerReadyPayload.pid}`;

			const holderReady = path.join(root, "controller-ready.json");
			const holder = spawnStoreProcess(
				{
					mode: "hold-owner",
					request: enrollRequest(plan.identity, plan.sessionFile, {
						pendingEffects: [{ id: "fx-live", kind: "worker", unresolved: true, identity: workerIdentity }],
						accounting: {
							workers: [{ identity: workerIdentity, status: "live" }],
							sessions: [{ sessionId: "sess-1", sessionFile: plan.sessionFile }],
						},
					}),
					readyPath: holderReady,
					resultPath: path.join(root, "controller-result.json"),
				},
				{ HOME: home },
			);
			await waitForFile(holderReady, holder);
			expect(worker.exitCode).toBeNull();

			holder.kill("SIGKILL");
			expect(await holder.exited).not.toBe(0);
			expect(worker.exitCode).toBeNull();

			const inspected = await inspectCommittedRunState(plan.identity);
			expect(inspected.state.accounting.workers).toEqual([{ identity: workerIdentity, status: "live" }]);
			expect(inspected.state.pendingEffects).toEqual([
				{ id: "fx-live", kind: "worker", unresolved: true, identity: workerIdentity },
			]);

			const recoverHome = tempDir("home-recover");
			const liveRecoverResult = path.join(root, "live-recover-result.json");
			const liveRecoverer = spawnStoreProcess(
				{
					mode: "try-owner",
					request: { action: "recover", identity: plan.identity },
					readyPath: path.join(root, "live-recover-ready.json"),
					resultPath: liveRecoverResult,
					lockRetries: 1,
				},
				{ HOME: recoverHome },
			);
			expect(await liveRecoverer.exited).toBe(0);
			const liveRecovered = readOwnerProcessResult(liveRecoverResult);
			expect(liveRecovered.ok).toBe(true);
			expect(liveRecovered.generation).toBe(1);
			expect(liveRecovered.canAdmitWork).toBe(false);
			expect(worker.exitCode).toBeNull();
			await withContinuationOwner({ action: "recover", identity: plan.identity }, async owner => {
				expect(owner.canAdmitWork()).toBe(false);
				expect(owner.getState().owner.sessionId).toBe("sess-1");
				try {
					await owner.activateOwner(
						activationInput(plan.sessionFile, "activate-replacement", {
							session: { sessionId: "replacement", sessionFile: plan.sessionFile },
						}),
					);
					throw new Error("replacement dispatch should be refused while the work child is live");
				} catch (error) {
					if (!(error instanceof ContinuationStoreError)) throw error;
					expect(error.code).toBe("unresolved-effects");
				}
				expect(owner.getState().owner.generation).toBe(1);
				expect(owner.getState().owner.sessionId).toBe("sess-1");
			});
			expect(worker.exitCode).toBeNull();
			worker.kill("SIGKILL");
			expect(await worker.exited).not.toBe(0);
		},
		CHILD_TIMEOUT_MS,
	);

	it(
		"recovers the predecessor from uncommitted successor files and the successor after owner commit",
		async () => {
			const root = tempDir("staged-committed");
			const plan = seedPlan(root, "docs/plans/example.md", "session.jsonl");
			const dest = await writeStagedSuccessor(root, "s2");
			const homeA = tempDir("home-a");
			const homeB = tempDir("home-b");

			const holderReady = path.join(root, "holder-ready.json");
			const holder = spawnStoreProcess(
				{
					mode: "hold-owner",
					request: enrollRequest(plan.identity, plan.sessionFile),
					readyPath: holderReady,
					resultPath: path.join(root, "holder-result.json"),
				},
				{ HOME: homeA },
			);
			await waitForFile(holderReady, holder);
			expect(fs.existsSync(dest.sessionFile)).toBe(true);
			holder.kill("SIGKILL");
			expect(await holder.exited).not.toBe(0);

			const beforeStage = await inspectCommittedRunState(plan.identity);
			expect(beforeStage.state.owner.sessionId).toBe("sess-1");
			expect(beforeStage.state.owner.generation).toBe(1);
			expect(beforeStage.state.pendingHandoff).toBeNull();
			expect(beforeStage.state.accounting.sessions.map(item => item.sessionId)).toEqual(["sess-1"]);

			const unstagedRecoverResult = path.join(root, "unstaged-recover-result.json");
			const unstagedRecoverer = spawnStoreProcess(
				{
					mode: "try-owner",
					request: { action: "recover", identity: plan.identity },
					readyPath: path.join(root, "unstaged-recover-ready.json"),
					resultPath: unstagedRecoverResult,
					lockRetries: 1,
				},
				{ HOME: homeB },
			);
			expect(await unstagedRecoverer.exited).toBe(0);
			const unstaged = readOwnerProcessResult(unstagedRecoverResult);
			expect(unstaged.ok).toBe(true);
			expect(unstaged.generation).toBe(1);
			expect(unstaged.canAdmitWork).toBe(true);
			expect((await inspectCommittedRunState(plan.identity)).state.pendingHandoff).toBeNull();

			await withContinuationOwner({ action: "recover", identity: plan.identity }, async owner => {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "stage-handoff",
					patch: {
						pendingHandoff: stagedHandoff({
							generation: 1,
							sourceSessionFile: plan.sessionFile,
							destination: dest,
						}),
					},
				});
			});

			const stagedRecoverResult = path.join(root, "staged-recover-result.json");
			const stagedRecoverer = spawnStoreProcess(
				{
					mode: "try-owner",
					request: { action: "recover", identity: plan.identity },
					readyPath: path.join(root, "staged-recover-ready.json"),
					resultPath: stagedRecoverResult,
					lockRetries: 1,
				},
				{ HOME: homeB },
			);
			expect(await stagedRecoverer.exited).toBe(0);
			const staged = readOwnerProcessResult(stagedRecoverResult);
			expect(staged.ok).toBe(true);
			expect(staged.generation).toBe(1);
			expect(staged.canAdmitWork).toBe(false);
			const stagedState = (await inspectCommittedRunState(plan.identity)).state;
			expect(stagedState.owner.sessionId).toBe("sess-1");
			expect(stagedState.owner.generation).toBe(1);
			expect(stagedState.pendingHandoff).toMatchObject({
				phase: "staged",
				destination: { sessionId: "s2" },
			});

			await withContinuationOwner({ action: "recover", identity: plan.identity }, async owner => {
				const next = await owner.activateOwner(
					activationInput(dest.sessionFile, "act-ok", {
						session: { sessionId: dest.sessionId, sessionFile: dest.sessionFile },
						frontierEvidence: [dest.checkpoint],
						checkpointDependencies: [dest.checkpoint],
						expectedFrontier: owner.getState().frontier,
						expectedPolicyRevision: "pol-1",
					}),
				);
				expect(next.owner.generation).toBe(2);
				expect(next.owner.sessionId).toBe("s2");
				expect(next.pendingHandoff).toBeNull();
			});

			const committedRecoverResult = path.join(root, "committed-recover-result.json");
			const committedRecoverer = spawnStoreProcess(
				{
					mode: "try-owner",
					request: { action: "recover", identity: plan.identity },
					readyPath: path.join(root, "committed-recover-ready.json"),
					resultPath: committedRecoverResult,
					lockRetries: 1,
				},
				{ HOME: homeA },
			);
			expect(await committedRecoverer.exited).toBe(0);
			const committed = readOwnerProcessResult(committedRecoverResult);
			expect(committed.ok).toBe(true);
			expect(committed.generation).toBe(2);
			expect(committed.canAdmitWork).toBe(true);
			const committedState = (await inspectCommittedRunState(plan.identity)).state;
			expect(committedState.owner.sessionId).toBe("s2");
			expect(committedState.owner.generation).toBe(2);
			expect(committedState.pendingHandoff).toBeNull();
			expect(committedState.accounting.sessions.map(item => item.sessionId).sort()).toEqual(["s2", "sess-1"]);

			await withContinuationOwner({ action: "recover", identity: plan.identity }, async owner => {
				try {
					await owner.activateOwner(
						activationInput(plan.sessionFile, "resurrect-predecessor", {
							expectedGeneration: 2,
							session: { sessionId: "sess-1", sessionFile: plan.sessionFile },
							frontierEvidence: [dest.checkpoint],
							checkpointDependencies: [dest.checkpoint],
						}),
					);
					throw new Error("committed successor must not resurrect the predecessor");
				} catch (error) {
					if (!(error instanceof ContinuationStoreError)) throw error;
					expect(error.code).toBe("handoff-not-staged");
				}
				expect(owner.getState().owner.sessionId).toBe("s2");
				expect(owner.getState().owner.generation).toBe(2);
			});
		},
		CHILD_TIMEOUT_MS,
	);

	it("reconciles unpublished F1 evidence and reopens the paused owner without inference", async () => {
		const root = tempDir("f1-evidence");
		fs.writeFileSync(path.join(root, "plan.md"), CRASH_PLAN);
		const home = tempDir("home-f1");
		const { enrolled, ready } = await runCrashChild("f1-evidence-before-frontier", root, home);
		expect(ready.crashedAt).toBe("after-evidence-before-frontier");
		expect(ready.evidencePaths.length).toBeGreaterThan(0);
		for (const evidencePath of ready.evidencePaths) {
			expect(fs.existsSync(evidencePath)).toBe(true);
		}

		const identity = { worktree: root, planPath: path.join(root, "plan.md") };
		const inspected = await inspectCommittedRunState(identity);
		expect(inspected.state.intent).toEqual(enrolled.intent);
		expect(inspected.state.intent.kind).toBe("continue");
		expect(inspected.state.owner.generation).toBe(enrolled.generation);
		expect(inspected.state.frontier.lastCommittedEventId).toBe(enrolled.frontier.lastCommittedEventId);
		expect(inspected.state.frontier.lastCommittedTransitionId).toBe(enrolled.frontier.lastCommittedTransitionId);
		expect(inspected.state.committedEvents.length).toBe(enrolled.committedEventCount);
		expect(inspected.state.committedTransitions.length).toBe(enrolled.committedTransitionCount);
		const committedEvidence = new Set(inspected.state.frontier.evidence.map(ref => ref.path));
		for (const evidencePath of ready.evidencePaths) {
			expect(committedEvidence.has(evidencePath)).toBe(false);
		}

		const recoverResult = path.join(root, "f1-recover-result.json");
		const recoverer = spawnStoreProcess(
			{
				mode: "try-owner",
				request: { action: "recover", identity, expectedRunId: enrolled.runId },
				readyPath: path.join(root, "f1-recover-ready.json"),
				resultPath: recoverResult,
				lockRetries: 1,
			},
			{ HOME: home },
		);
		expect(await recoverer.exited).toBe(0);
		const recoveredOwner = readOwnerProcessResult(recoverResult);
		expect(recoveredOwner.ok).toBe(true);
		expect(recoveredOwner.canAdmitWork).toBe(true);
		expect((await inspectCommittedRunState(identity)).state.intent.kind).toBe("continue");

		const manager = await SessionManager.open(enrolled.sessionFile, path.join(root, "sessions"), undefined, {
			initialCwd: root,
			suppressBreadcrumb: true,
		});
		const run = await openCrashContinuationRun({ root, sessionManager: manager, recoverRunId: enrolled.runId });
		try {
			expect(run.getState().intent.kind).toBe("continue");
			const beforePause = run.getState();
			await run.setIntent({ kind: "pause", reason: "f1-unpublished" });
			expect(run.getState().intent).toEqual({ kind: "pause", reason: "f1-unpublished" });
			expect(run.getState().frontier.lastCommittedEventId).not.toBe(beforePause.frontier.lastCommittedEventId);
			expect(run.getState().committedEvents.length).toBeGreaterThan(beforePause.committedEvents.length);
		} finally {
			await run.close();
			await manager.close();
		}
		const pausedOnDisk = await inspectCommittedRunState(identity);
		expect(pausedOnDisk.state.intent).toEqual({ kind: "pause", reason: "f1-unpublished" });
		expect(pausedOnDisk.state.committedEvents.length).toBeGreaterThan(enrolled.committedEventCount);
		expect(pausedOnDisk.state.owner.sessionId).toBe(enrolled.sessionId);
		expect(pausedOnDisk.state.run.id).toBe(enrolled.runId);

		const reloadReady = path.join(root, "reload-paused-ready.json");
		const reloadResult = path.join(root, "reload-paused-result.json");
		const reloader = spawnStoreProcess(
			{
				mode: "reload-paused",
				root,
				sessionFile: enrolled.sessionFile,
				recoverRunId: enrolled.runId,
				readyPath: reloadReady,
				resultPath: reloadResult,
			},
			{ HOME: home },
			CRASH_FIXTURE,
		);
		await waitForFile(reloadReady, reloader);
		await waitForFile(reloadResult, reloader);
		const reloaded = readPausedReloadResult(reloadResult);
		expect(reloaded.error).toBeUndefined();
		expect(reloaded.ok).toBe(true);
		expect(reloaded.intent).toEqual({ kind: "pause", reason: "f1-unpublished" });
		expect(reloaded.runId).toBe(enrolled.runId);
		expect(reloaded.owner?.sessionId).toBe(pausedOnDisk.state.owner.sessionId);
		expect(path.resolve(reloaded.owner?.sessionFile ?? "")).toBe(path.resolve(pausedOnDisk.state.owner.sessionFile));
		expect(reloaded.owner?.generation).toBeGreaterThanOrEqual(pausedOnDisk.state.owner.generation);
		expect(reloaded.startup).toEqual({ kind: "defer", reason: "f1-unpublished" });
		expect(reloaded.maintenance).toEqual({ kind: "defer", reason: "f1-unpublished" });
		expect(reloaded.quotaRecovery).toEqual({ kind: "defer", reason: "f1-unpublished" });
		expect(reloaded.handoff?.refused).toBe(true);
		expect(reloaded.handoff?.kind).toBe("defer");
		expect(reloaded.primaryStream?.outcomeKind).toBe("defer");
		expect(reloaded.maintenanceStream?.outcomeKind).toBe("defer");
		expect(reloaded.localhostInferenceAttempts).toBe(0);
		expect(reloaded.localhostServerHits).toBe(0);
		expect(await reloader.exited).toBe(0);

		const afterReload = await inspectCommittedRunState(identity);
		expect(afterReload.state.intent).toEqual({ kind: "pause", reason: "f1-unpublished" });
		expect(afterReload.state.run.id).toBe(enrolled.runId);
		expect(afterReload.state.owner.sessionId).toBe(pausedOnDisk.state.owner.sessionId);
		for (const evidencePath of ready.evidencePaths) {
			expect(fs.existsSync(evidencePath)).toBe(true);
			expect(afterReload.state.frontier.evidence.some(ref => ref.path === evidencePath)).toBe(false);
		}
	}, 20_000);

	it(
		"retains an applied destination effect as unresolved when the durable result never lands",
		async () => {
			const root = tempDir("f5-effect");
			fs.writeFileSync(path.join(root, "plan.md"), CRASH_PLAN);
			const home = tempDir("home-f5");
			const { enrolled, ready } = await runCrashChild("f5-effect-before-result", root, home);
			expect(ready.crashedAt).toBe("after-effect-before-result");
			expect(fs.existsSync(ready.targetPath)).toBe(false);
			expect(fs.readFileSync(crashEffectPath(root), "utf8")).toBe(CRASH_EFFECT_TEXT);
			expect(JSON.parse(fs.readFileSync(crashToolCallsPath(root), "utf8"))).toEqual(["first"]);

			const identity = { worktree: root, planPath: path.join(root, "plan.md") };
			const inspected = await inspectCommittedRunState(identity);
			expect(inspected.state.pendingEffects.some(effect => effect.kind === "tool" && effect.unresolved)).toBe(true);
			expect(inspected.state.owner.generation).toBe(2);
			expect(inspected.state.owner.sessionId).toBe(enrolled.sessionId);
			const pendingTool = inspected.state.pendingEffects.find(effect => effect.kind === "tool");
			if (!pendingTool) throw new Error("F5 must retain the unresolved tool intent");
			expect(
				fs.existsSync(
					checkpointPath(inspected.controlDir, inspected.state.run.id, `effect-result-${pendingTool.id}`),
				),
			).toBe(false);

			const recoverResult = path.join(root, "f5-recover-result.json");
			const recoverer = spawnStoreProcess(
				{
					mode: "try-owner",
					request: { action: "recover", identity, expectedRunId: enrolled.runId },
					readyPath: path.join(root, "f5-recover-ready.json"),
					resultPath: recoverResult,
					lockRetries: 1,
				},
				{ HOME: home },
			);
			expect(await recoverer.exited).toBe(0);
			const recoveredOwner = readOwnerProcessResult(recoverResult);
			expect(recoveredOwner.ok).toBe(true);
			expect(recoveredOwner.canAdmitWork).toBe(false);

			const manager = await SessionManager.open(enrolled.sessionFile, path.join(root, "sessions"), undefined, {
				initialCwd: root,
				suppressBreadcrumb: true,
			});
			const run = await openCrashContinuationRun({ root, sessionManager: manager, recoverRunId: enrolled.runId });
			try {
				expect(
					run.getState().pendingEffects.some(effect => effect.id === pendingTool.id && effect.unresolved),
				).toBe(true);
				const outcome = await run.bindSession(manager, "primary").beforeRecovery();
				expect(outcome.kind).toBe("stop");
				if (outcome.kind === "stop") {
					expect(outcome.attention).toBe(true);
					expect(outcome.reason).toContain("Unresolved effects");
				}
				const replayCalls: string[] = [];
				const replayTool = (name: string): AgentTool => ({
					name,
					label: name,
					description: name,
					parameters: type({}),
					concurrency: "exclusive",
					execute: async () => {
						replayCalls.push(name);
						await fsp.appendFile(crashEffectPath(root), "REPLAY");
						return { content: [{ type: "text", text: "REPLAY" }], details: { effect: name } };
					},
				});
				const agent = new Agent({
					initialState: {
						model: continuationModel,
						systemPrompt: ["Fixture"],
						tools: [replayTool("first"), replayTool("second")],
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
					toolExecutionBoundary: run.bindSession(manager, "primary").toolBoundary,
					streamFn: async () => {
						throw new Error("No model call belongs in recovered F5 replay");
					},
				});
				await expect(agent.continue()).rejects.toThrow();
				expect(replayCalls).toEqual([]);
				expect(fs.readFileSync(crashEffectPath(root), "utf8")).toBe(CRASH_EFFECT_TEXT);
				expect(
					run.getState().pendingEffects.some(effect => effect.id === pendingTool.id && effect.unresolved),
				).toBe(true);
			} finally {
				await run.close();
				await manager.close();
			}
		},
		CHILD_TIMEOUT_MS,
	);
});
