import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ContinuationSessionBinding } from "@oh-my-pi/pi-coding-agent/session/continuation-binding";
import {
	openContinuationRun,
	type ContinuationRun,
	type ContinuationRunOptions,
} from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import type { ContinuationPolicyV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-policy";
import { sha256Bytes, type ContinuationDurableIo } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { WorkProjectionV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-work";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "../session-manager/helpers";

const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!bundled) throw new Error("Expected bundled fixture model");

/** Isolated local endpoint; tests must never touch global profiles or existing sessions. */
export const continuationModel = { ...bundled, baseUrl: "http://127.0.0.1:49123" };

const PLAN =
	"# Controller Implementation Plan\n\n## Global Constraints\n\n- PROTECTED_CONSTRAINT\n\n### Task 1: Completed work\nDo not repeat.\n\n### Task 2: Review\nResolve OPEN_FINDING without REJECTED_APPROACH.\n";

/** Current-task brief is the plan's task body, not a model summary. */
export const CURRENT_TASK_BRIEF = "### Task 2: Review\nResolve OPEN_FINDING without REJECTED_APPROACH.\n";

export interface ContinuationFixture {
	root: string;
	manager: SessionManager;
	projection: WorkProjectionV1;
	policy: ContinuationPolicyV1;
	options: ContinuationRunOptions;
	accountsBySession: Map<string, string>;
	run: ContinuationRun;
	binding: ContinuationSessionBinding;
}

export function continuationTestHarness() {
	const dirs: TempDir[] = [];
	const runs: ContinuationRun[] = [];
	const managers: SessionManager[] = [];
	const jobs: AsyncJobManager[] = [];

	async function cleanup() {
		for (const manager of jobs.splice(0)) await manager.dispose();
		for (const run of runs.splice(0)) await run.close();
		for (const manager of managers.splice(0)) await manager.close();
		await Promise.all(dirs.splice(0).map(dir => dir.remove()));
	}

	async function fixture(io?: ContinuationDurableIo, accounts: readonly string[] = ["fixture-account"]) {
		const dir = TempDir.createSync("continuation-fixture");
		dirs.push(dir);
		const root = await fs.realpath(dir.path());
		const planPath = path.join(root, "plan.md");
		await fs.writeFile(planPath, PLAN);
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		managers.push(manager);
		manager.appendMessage(makeAssistantMessage());
		await manager.ensureOnDisk();
		const brief = {
			kind: "regenerated" as const,
			task: 2,
			text: CURRENT_TASK_BRIEF,
			byteLength: Buffer.byteLength(CURRENT_TASK_BRIEF, "utf8"),
			sha256: sha256Bytes(CURRENT_TASK_BRIEF),
		};
		const projection: WorkProjectionV1 = {
			version: 1,
			plan: { root, relativePath: "plan.md", sha256: sha256Bytes(PLAN) },
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
		const policy: ContinuationPolicyV1 = {
			version: 1,
			revision: "fixture-policy",
			roles: ["primary", "worker", "advisor", "maintenance"],
			dataScope: "fixture",
			candidates: accounts.map(account => ({
				provider: continuationModel.provider,
				account,
				model: continuationModel.id,
				endpoint: continuationModel.baseUrl,
				roles: ["primary", "worker", "advisor", "maintenance"],
				settings: {},
				dataScope: "fixture",
			})),
			unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
			attemptBudget: 2,
			restrictedAccounts: [],
		};
		const accountsBySession = new Map([[manager.getSessionId(), accounts[0] ?? "fixture-account"]]);
		const options = {
			sessionManager: manager,
			planPath: "plan.md",
			policy,
			source: policy.candidates[0]!,
			workflow: { id: "fixture", exportProjection: async () => structuredClone(projection) },
			observeRequest: async (_request: unknown, sessionId: string) => {
				const account = accountsBySession.get(sessionId) ?? accounts[0] ?? "fixture-account";
				return {
					account,
					dataScope: "fixture",
					contextTokens: 100,
					allowances: [
						{
							provider: continuationModel.provider,
							account,
							window: "fixture-window",
							headroom: "healthy" as const,
						},
					],
				};
			},
			ownerOptions: io ? { io } : undefined,
		};
		const run = await openContinuationRun(options);
		runs.push(run);
		return {
			root,
			manager,
			projection,
			policy,
			options,
			accountsBySession,
			run,
			binding: run.bindSession(manager, "primary"),
		};
	}

	async function extraSession(f: ContinuationFixture, account: string) {
		const manager = SessionManager.create(f.root, path.join(f.root, "sessions"));
		managers.push(manager);
		manager.appendMessage(makeAssistantMessage());
		await manager.ensureOnDisk();
		f.accountsBySession.set(manager.getSessionId(), account);
		return manager;
	}

	function trackJob(manager: AsyncJobManager) {
		jobs.push(manager);
		return manager;
	}

	function trackRun(run: ContinuationRun) {
		runs.push(run);
		return run;
	}

	return { model: continuationModel, fixture, extraSession, trackJob, trackRun, cleanup };
}
