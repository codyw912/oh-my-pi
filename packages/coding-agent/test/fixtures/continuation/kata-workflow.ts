/**
 * Disposable real Kata v0.16 + Sjujperpowers SDD fixture for later PT-01.
 * Invokes the Nix-supplied kata binary and real materialize/record/export
 * helpers only when createKataWorkflowFixture runs. Do not call it outside
 * the native Nix sandbox.
 */
import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ContinuationWorkflow } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { WorkProjectionV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-work";
import { materializePlan } from "../../../../../.continuation-workflow/skills/tracking-providers/scripts/materialize-plan.mjs";
import { recordRecovery } from "../../../../../.continuation-workflow/skills/tracking-providers/scripts/record-recovery.mjs";
import { exportRecovery } from "../../../../../.continuation-workflow/skills/tracking-providers/scripts/export-recovery.mjs";
import {
	workspaceDir,
	fileEvidence,
} from "../../../../../.continuation-workflow/skills/tracking-providers/scripts/recovery-lib.mjs";

const execFile = promisify(execFileCallback);

export const KATA_PINNED_VERSION = "0.16.0";
export const KATA_SOURCE_REVISION = "7050b84d367b8c94cd7a6cb4a556ab697cf0dfbc";
export const KATA_PROJECT = "continuation-kata";
export const KATA_ACTOR = "continuation-actor";
export const KATA_INTRUDER_ACTOR = "intruder-actor";
export const PLAN_RELATIVE_PATH = "docs/project/plans/continuation-kata.md";
export const SPEC_RELATIVE_PATH = "docs/project/specs/continuation-kata.md";
/** Immutable verification base recorded on complete-unlanded task 1. */
export const VERIFICATION_BASE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const VERIFICATION_HEAD = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const TRACKING_SCRIPTS = "skills/tracking-providers/scripts";
const EXEC_TIMEOUT_MS = 30_000;
const DAEMON_STOP_TIMEOUT_MS = 20_000;

export const KATA_WORKFLOW_REQUIREMENTS = {
	env: ["CONTINUATION_KATA_BIN"] as const,
	optionalEnv: ["CONTINUATION_SJUJPERPOWERS_SOURCE"] as const,
	cli: {
		version: KATA_PINNED_VERSION,
		sourceRevision: KATA_SOURCE_REVISION,
		provenance:
			"nix/continuation-kata.nix fetches kenn-io/kata v0.16.0 homebrew_linux archive; CONTINUATION_KATA_BIN must be that store path",
		commands: [
			"kata --json version",
			"kata --json daemon start",
			"kata --json daemon stop",
			"kata health --json",
			"kata init --project <name>",
			"kata projects show <name> --json",
			"kata --project <name> --json create ... --idempotency-key ... --meta ...",
			"kata --project <name> --json show <ref>",
			"kata --project <name> --json --as <actor> claim <ref>",
			"kata --json federation enable <project>",
			"kata --project <name> --json --as <actor> federation lease acquire <ref> --ttl 30m",
			"kata --project <name> --json close <ref> --done --message ... --commit ...",
		],
	},
	apiOverPrivateUnixSocket: ["POST /api/v1/projects/<id>/issues/<ref>/lease/actions/renew"],
	helpers: [
		`${TRACKING_SCRIPTS}/materialize-plan.mjs`,
		`${TRACKING_SCRIPTS}/record-recovery.mjs`,
		`${TRACKING_SCRIPTS}/export-recovery.mjs`,
		`${TRACKING_SCRIPTS}/recovery-lib.mjs`,
		`${TRACKING_SCRIPTS}/resolve-config.mjs`,
	],
	isolation: {
		KATA_HOME: "fixture-local data directory (not ~/.kata)",
		KATA_DB: "fixture-local SQLite path",
		KATA_DSN: "same SQLite path; never Postgres or a remote DSN",
		KATA_AUTHOR: KATA_ACTOR,
		KATA_TELEMETRY_ENABLED: "0",
		XDG_RUNTIME_DIR: "fixture-local Unix socket parent",
		unset: [
			"KATA_SERVER",
			"KATA_AUTH_TOKEN",
			"KATA_GITHUB_TOKEN",
			"KATA_TRUST_PRIVATE_NETWORK",
			"KATA_ALLOW_INSECURE",
		],
		daemon: "explicit `kata daemon start` on the default Unix socket; no TCP --listen",
	},
} as const;

const SPEC = `# Continuation Kata Workflow Design

**Outcome:** file:M1 — Continuation Kata Workflow

## Goal

Prove a file-roadmap plan can activate into real Kata children and recover through Sjujperpowers SDD snapshots.

## Acceptance

- Task 1 stays complete-unlanded until Kata close.
- Task 2 retains two findings, a rejected approach, and the immutable verification base.
- Task 3 stays pending.
- Execution actor identity is independent of inference provider.
`;

const PLAN = `# Continuation Kata Workflow Implementation Plan

**Spec:** \`${SPEC_RELATIVE_PATH}\`

**Source:** file:M1 — Continuation Kata Workflow

## Global Constraints

- PROTECTED_CONSTRAINT
- Preserve execution actor identity across inference provider switches
- Do not close Kata children before the configured landed completion boundary

---

### Task 1: Completed work

Landed-local implementation already exists. Do not repeat. Verification base must stay immutable.

### Task 2: Review and fix

Resolve OPEN_FINDING and CONSTRAINT_LEAK without REJECTED_APPROACH. Resume the implementer on the recorded verification base.

### Task 3: Pending follow-through

Not started. Leave pending until Task 2 findings close.
`;

const FINDING_PROGRESS = "open finding: missing progress reporting\n";
const FINDING_CONSTRAINT = "open finding: CONSTRAINT_LEAK against PROTECTED_CONSTRAINT\n";
const REVIEW_PACKAGE = "review package: two open findings; rejected rewrite-from-scratch\n";

export class KataCliError extends Error {
	readonly args: readonly string[];
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly stderr: string;

	constructor(args: readonly string[], exitCode: number | null, stdout: string, stderr: string) {
		super(`kata ${args.join(" ")} failed (exit ${exitCode ?? "null"}): ${(stderr || stdout).trim() || "no output"}`);
		this.name = "KataCliError";
		this.args = args;
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

export interface KataFileEvidence {
	kind: "file";
	path: string;
	byteLength: number;
	sha256: string;
}

export interface KataMaterializedChild {
	task: number;
	ref: string;
	created: boolean;
	shortId: string;
}

export interface KataCapabilityResult {
	capability: string;
	supported: boolean;
	reason?: string;
	observation?: unknown;
}

export interface KataWorkflowHelpers {
	materializePlan: (args: {
		root: string;
		planPath: string;
		markdown: string;
		config: unknown;
		runKata: (args: string[]) => Promise<unknown>;
	}) => Promise<{
		parent: { ref: string; created: boolean };
		children: Array<{ task: number; ref: string; created: boolean }>;
	}>;
	recordRecovery: (args: {
		root: string;
		planPath: string;
		event: unknown;
		config: unknown;
		showIssue: (args: { root: string; project: string; ref: string }) => Promise<unknown>;
		runtimeCheck?: boolean;
	}) => Promise<{
		acknowledged: boolean;
		revision: number;
		eventId: string;
		snapshotEvidence: KataFileEvidence;
		retained: unknown;
		evidence: KataFileEvidence[];
		progressPath: string;
		snapshot: unknown;
	}>;
	exportRecovery: (args: {
		root: string;
		planPath: string;
		workflow?: string;
		showIssue: (args: { root: string; project: string; ref: string }) => Promise<unknown>;
		config: unknown;
		runtimeCheck?: boolean;
	}) => Promise<WorkProjectionV1>;
	workspaceDir: (root: string, relativePath: string) => string;
	fileEvidence: (path: string, byteLength?: number) => Promise<KataFileEvidence>;
}

export interface KataWorkflowFixture {
	root: string;
	planPath: string;
	planAbsolutePath: string;
	project: string;
	actor: string;
	kataBin: string;
	workflowSource: string;
	requirements: typeof KATA_WORKFLOW_REQUIREMENTS;
	workflow: ContinuationWorkflow;
	materialization: {
		parent: { ref: string; created: boolean };
		children: KataMaterializedChild[];
	};
	snapshot: { revision: number; eventId: string; progressPath: string; evidence: KataFileEvidence };
	report: { progressPath: string; task2Report: KataFileEvidence; task2ReviewPackage: KataFileEvidence };
	evidence: {
		verificationBase: string;
		verificationHead: string;
		findings: KataFileEvidence[];
		retained: unknown;
	};
	env: NodeJS.ProcessEnv;
	inferenceProvider: string;
	switchInferenceProvider(provider: string): string;
	runKata(
		args: string[],
		options?: { json?: boolean; allowFailure?: boolean },
	): Promise<{ payload: unknown; stdout: string; stderr: string; exitCode: number }>;
	exportProjection(): Promise<WorkProjectionV1>;
	observeClaims(): Promise<{ projection: WorkProjectionV1; shows: Record<string, unknown> }>;
	observeCompletion(): Promise<{
		projection: WorkProjectionV1;
		tasks: Array<{ number: number; state: string; kataStatus: string | null; ref: string | null }>;
	}>;
	mutateClaimRevision(task?: number): Promise<{ ref: string; before: number | null; after: number | null }>;
	transferClaimToForeign(
		task?: number,
	): Promise<{ ref: string; beforeHolder: string | null; afterHolder: string | null; afterClaimUid: unknown }>;
	closeChildWithEvidence(task?: number): Promise<{ ref: string; status: string | null }>;
	recordAuthorizedLiveClaims(): Promise<{ acknowledged: boolean; revision: number }>;
	publishResult(): Promise<{ acknowledged: boolean; discoveryRef: KataFileEvidence }>;
	cleanup(): Promise<void>;
}

function fail(message: string): never {
	throw new Error(message);
}

export function resolveContinuationKataBin(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.CONTINUATION_KATA_BIN;
	if (typeof raw !== "string" || raw.trim() === "") {
		fail("CONTINUATION_KATA_BIN must resolve an explicit Nix-supplied kata binary; it is missing");
	}
	const bin = path.resolve(raw.trim());
	if (!path.isAbsolute(raw.trim())) {
		fail(`CONTINUATION_KATA_BIN must be an absolute Nix store path, not ${JSON.stringify(raw)}`);
	}
	if (!existsSync(bin)) {
		fail(`CONTINUATION_KATA_BIN does not exist: ${bin}`);
	}
	return bin;
}

function scriptPath(workflowSource: string, name: string): string {
	return path.join(workflowSource, TRACKING_SCRIPTS, name);
}

async function loadHelpers(workflowSource: string): Promise<KataWorkflowHelpers> {
	const source = path.resolve(workflowSource);
	for (const name of ["materialize-plan.mjs", "record-recovery.mjs", "export-recovery.mjs", "recovery-lib.mjs"]) {
		const file = scriptPath(source, name);
		if (!existsSync(file)) fail(`Sjujperpowers helper missing: ${file}`);
	}
	return { materializePlan, recordRecovery, exportRecovery, workspaceDir, fileEvidence };
}

function isolatedKataEnv(options: {
	kataHome: string;
	runtimeDir: string;
	userHome: string;
	binDir: string;
	dbPath: string;
}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of [
		"KATA_SERVER",
		"KATA_AUTH_TOKEN",
		"KATA_GITHUB_TOKEN",
		"KATA_TRUST_PRIVATE_NETWORK",
		"KATA_ALLOW_INSECURE",
		"KATA_ALLOW_UNAUTHENTICATED_PRIVATE_NETWORK_WRITES",
		"KATA_POSTGRES_SCHEMA",
		"KATA_POSTGRES_SCHEMA_OWNER",
		"KATA_POSTGRES_ALLOW_INSECURE",
	]) {
		delete env[key];
	}
	env.HOME = options.userHome;
	env.KATA_HOME = options.kataHome;
	env.KATA_DB = options.dbPath;
	env.KATA_DSN = options.dbPath;
	env.KATA_AUTHOR = KATA_ACTOR;
	env.KATA_TELEMETRY_ENABLED = "0";
	env.XDG_RUNTIME_DIR = options.runtimeDir;
	env.PATH = `${options.binDir}${path.delimiter}${env.PATH ?? ""}`;
	return env;
}

function parseJson(text: string, label: string): unknown {
	const trimmed = text.trim();
	if (trimmed === "") fail(`${label} produced empty stdout`);
	try {
		return JSON.parse(trimmed);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		fail(`${label} returned invalid JSON (${reason}): ${trimmed.slice(0, 500)}`);
	}
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function unwrapKataPayload(value: unknown): unknown {
	const record = asRecord(value);
	if (!record) return value;
	if (asRecord(record.issue)) return record;
	for (const key of ["payload", "result", "data", "body"]) {
		const nested = asRecord(record[key]);
		if (nested && asRecord(nested.issue)) return nested;
	}
	return record;
}

function integerField(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function stringField(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function claimStub(ref: string, task: number): Record<string, unknown> {
	return {
		kind: "provider",
		provider: "kata",
		ref,
		observedRevision: null,
		task,
	};
}

function shortIdFromRef(ref: string, project: string): string {
	const prefix = `${project}#`;
	return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 50);
		await promise;
	}
	return !pidAlive(pid);
}

function issueRevision(payload: unknown): number | null {
	const unwrapped = asRecord(unwrapKataPayload(payload));
	return integerField(asRecord(unwrapped?.issue)?.revision);
}

function issueOwner(payload: unknown): string | null {
	const unwrapped = asRecord(unwrapKataPayload(payload));
	return stringField(asRecord(unwrapped?.issue)?.owner);
}

export async function createKataWorkflowFixture(
	root: string,
	workflowSource: string,
	options?: { deferResult?: boolean },
): Promise<KataWorkflowFixture> {
	if (typeof workflowSource !== "string" || workflowSource.trim() === "") {
		fail("createKataWorkflowFixture requires the Nix-declared Sjujperpowers workflowSource");
	}
	const kataBin = resolveContinuationKataBin();
	const helpers = await loadHelpers(workflowSource);
	await fs.mkdir(path.resolve(root), { recursive: true });
	const workspace = await fs.realpath(path.resolve(root));
	const kataHome = path.join(workspace, ".kata-home");
	const runtimeDir = path.join(workspace, ".kata-runtime");
	const userHome = path.join(workspace, ".user-home");
	const dbPath = path.join(kataHome, "kata.db");
	await fs.mkdir(kataHome, { recursive: true });
	await fs.mkdir(runtimeDir, { recursive: true });
	await fs.mkdir(userHome, { recursive: true });
	await fs.mkdir(path.join(workspace, path.dirname(PLAN_RELATIVE_PATH)), { recursive: true });
	await fs.mkdir(path.join(workspace, path.dirname(SPEC_RELATIVE_PATH)), { recursive: true });
	await fs.mkdir(path.join(workspace, ".sjujperpowers"), { recursive: true });
	await fs.writeFile(path.join(workspace, SPEC_RELATIVE_PATH), SPEC);
	await fs.writeFile(path.join(workspace, PLAN_RELATIVE_PATH), PLAN);
	await fs.writeFile(
		path.join(workspace, ".sjujperpowers/config.json"),
		`${JSON.stringify(
			{
				version: 1,
				docsRoot: "docs/project",
				roadmap: { provider: "file" },
				execution: { provider: "kata", project: KATA_PROJECT, completion: "landed" },
			},
			null,
			2,
		)}\n`,
	);
	await fs.writeFile(path.join(workspace, ".kata.toml"), `version = 1\n\n[project]\nname = "${KATA_PROJECT}"\n`);

	const env = isolatedKataEnv({
		kataHome,
		runtimeDir,
		userHome,
		binDir: path.dirname(kataBin),
		dbPath,
	});
	const config = {
		version: 1,
		configPath: path.join(workspace, ".sjujperpowers/config.json"),
		docsRoot: "docs/project",
		roadmap: { provider: "file" as const },
		execution: { provider: "kata" as const, project: KATA_PROJECT, completion: "landed" as const },
	};

	let daemonPid: number | null = null;
	let cleaned = false;

	const runKata = async (
		args: string[],
		options?: { json?: boolean; allowFailure?: boolean },
	): Promise<{ payload: unknown; stdout: string; stderr: string; exitCode: number }> => {
		const parse = options?.json !== false;
		try {
			const { stdout, stderr } = await execFile(kataBin, args, {
				cwd: workspace,
				env,
				encoding: "utf8",
				timeout: EXEC_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			});
			return {
				payload: parse ? unwrapKataPayload(parseJson(stdout, `kata ${args.join(" ")}`)) : null,
				stdout,
				stderr,
				exitCode: 0,
			};
		} catch (error) {
			const err = error as { code?: string | number; stdout?: string; stderr?: string; message?: string };
			const stdout = typeof err.stdout === "string" ? err.stdout : "";
			const stderr = typeof err.stderr === "string" ? err.stderr : (err.message ?? String(error));
			const exitCode = typeof err.code === "number" ? err.code : null;
			if (options?.allowFailure) {
				return { payload: null, stdout, stderr, exitCode: exitCode ?? 1 };
			}
			throw new KataCliError(args, exitCode, stdout, stderr);
		}
	};

	const runKataJson = async (args: string[]): Promise<unknown> => (await runKata(args)).payload;

	const showIssue = async ({ project, ref }: { root: string; project: string; ref: string }): Promise<unknown> =>
		runKataJson(["--workspace", workspace, "--project", project, "--json", "show", ref]);

	const cleanup = async (): Promise<void> => {
		if (cleaned) return;
		cleaned = true;
		try {
			await runKata(["--workspace", workspace, "daemon", "stop"], { json: false, allowFailure: true });
		} catch {
			// Best-effort; pid kill below is the backstop.
		}
		if (daemonPid !== null && pidAlive(daemonPid)) {
			try {
				process.kill(daemonPid, "SIGTERM");
			} catch {
				// already exiting
			}
			if (!(await waitForPidExit(daemonPid, DAEMON_STOP_TIMEOUT_MS))) {
				try {
					process.kill(daemonPid, "SIGKILL");
				} catch {
					// gone
				}
			}
		}
		daemonPid = null;
	};

	try {
		const versionPayload = asRecord(await runKataJson(["--json", "version"]));
		const reported =
			stringField(versionPayload?.version) ?? stringField(versionPayload?.Version) ?? JSON.stringify(versionPayload);
		if (!reported.includes(KATA_PINNED_VERSION)) {
			fail(`CONTINUATION_KATA_BIN is not pinned Kata v${KATA_PINNED_VERSION}; version output: ${reported}`);
		}

		const started = asRecord(await runKataJson(["--json", "daemon", "start"]));
		daemonPid = integerField(started?.pid);
		if (daemonPid === null) fail(`kata daemon start did not report pid: ${JSON.stringify(started)}`);
		const address = stringField(started?.address) ?? "";
		if (address.includes("://") && !address.startsWith("unix:")) {
			fail(`kata daemon started on a network address (${address}); fixture requires the default Unix socket`);
		}

		const health = asRecord(await runKataJson(["health", "--json"]));
		if (health?.ok !== true) fail(`kata health --json is not ok: ${JSON.stringify(health)}`);

		await runKata(["--workspace", workspace, "init", "--project", KATA_PROJECT], { json: false, allowFailure: true });
		const projectShow = asRecord(
			await runKataJson(["--workspace", workspace, "--json", "projects", "show", KATA_PROJECT]),
		);
		const projectName = stringField(asRecord(projectShow?.project)?.name) ?? stringField(projectShow?.name);
		if (projectName !== KATA_PROJECT) {
			await runKataJson(["--workspace", workspace, "--json", "projects", "create", KATA_PROJECT]);
		}
		// Exercise real lease fencing on a private hub. No peer is enrolled,
		// and the daemon remains bound only to its private Unix socket.
		await runKataJson(["--workspace", workspace, "--json", "--as", KATA_ACTOR, "federation", "enable", KATA_PROJECT]);

		const markdown = await fs.readFile(path.join(workspace, PLAN_RELATIVE_PATH), "utf8");
		const materialized = await helpers.materializePlan({
			root: workspace,
			planPath: path.join(workspace, PLAN_RELATIVE_PATH),
			markdown,
			config,
			runKata: async args => runKataJson(args),
		});
		if (!materialized.parent?.ref || materialized.children.length !== 3) {
			fail(`materializePlan did not return parent + 3 children: ${JSON.stringify(materialized)}`);
		}
		const children: KataMaterializedChild[] = materialized.children.map(child => ({
			task: child.task,
			ref: child.ref,
			created: child.created,
			shortId: shortIdFromRef(child.ref, KATA_PROJECT),
		}));
		const taskByNumber = new Map(children.map(child => [child.task, child]));
		const task2 = taskByNumber.get(2);
		if (!task2) fail("materializePlan omitted task 2");

		await runKataJson([
			"--workspace",
			workspace,
			"--project",
			KATA_PROJECT,
			"--json",
			"--as",
			KATA_ACTOR,
			"federation",
			"lease",
			"acquire",
			task2.shortId,
			"--ttl",
			"30m",
		]);
		await runKataJson([
			"--workspace",
			workspace,
			"--project",
			KATA_PROJECT,
			"--json",
			"--as",
			KATA_ACTOR,
			"claim",
			task2.shortId,
		]);

		for (const child of children) {
			await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
		}

		const taskClaims = children.map(child => claimStub(child.ref, child.task));
		const enrolled = await helpers.recordRecovery({
			root: workspace,
			planPath: PLAN_RELATIVE_PATH,
			config,
			showIssue,
			event: {
				workflow: "sdd",
				expectedRevision: 1,
				current: { task: 1, phase: "implement", round: null, nextAction: "implement task 1" },
				tasks: [
					{ number: 1, state: "in_progress", phase: "implement", round: null, claim: taskClaims[0] },
					{ number: 2, state: "pending", phase: "implement", round: null, claim: taskClaims[1] },
					{ number: 3, state: "pending", phase: "implement", round: null, claim: taskClaims[2] },
				],
				claims: taskClaims,
			},
		});
		if (!enrolled.acknowledged) fail("recordRecovery refused the enrollment snapshot");

		const completed = await helpers.recordRecovery({
			root: workspace,
			planPath: PLAN_RELATIVE_PATH,
			config,
			showIssue,
			event: {
				type: "complete-task",
				task: 1,
				expectedRevision: 2,
				changes: { base: VERIFICATION_BASE, head: VERIFICATION_HEAD },
				current: { task: 2, phase: "review", round: null, nextAction: "review task 2" },
				tasks: [{ number: 2, state: "review", phase: "review", round: null }],
			},
		});

		const sddDir = helpers.workspaceDir(workspace, PLAN_RELATIVE_PATH);
		await fs.mkdir(sddDir, { recursive: true });
		const reportPath = path.join(sddDir, "task-2-report.md");
		const reviewPath = path.join(sddDir, "task-2-review.md");
		const findingTwoPath = path.join(sddDir, "task-2-constraint.md");
		await fs.writeFile(reportPath, FINDING_PROGRESS);
		await fs.writeFile(reviewPath, REVIEW_PACKAGE);
		await fs.writeFile(findingTwoPath, FINDING_CONSTRAINT);
		const task2Report = await helpers.fileEvidence(reportPath);
		const task2ReviewPackage = await helpers.fileEvidence(reviewPath);
		const findingTwoEvidence = await helpers.fileEvidence(findingTwoPath);

		let recorded = completed;
		let resultPublished = false;
		const publishResult = async () => {
			if (resultPublished) throw new Error("Kata fixture result has already been acknowledged");
			recorded = await helpers.recordRecovery({
				root: workspace,
				planPath: PLAN_RELATIVE_PATH,
				config,
				showIssue,
				event: {
					type: "fix-round",
					task: 2,
					round: 1,
					expectedRevision: completed.revision + 1,
					nextAction: "resume fix round 1 for task 2",
					current: { task: 2, phase: "fix", round: 1, nextAction: "resume fix round 1 for task 2" },
					tasks: [
						{
							number: 2,
							state: "fix",
							phase: "fix",
							round: 1,
							nextAction: "resume fix round 1 for task 2",
							report: task2Report,
							reviewPackage: task2ReviewPackage,
							commits: { base: VERIFICATION_BASE, head: null },
						},
					],
					findings: [
						{
							id: "f1",
							task: 2,
							status: "open",
							summary: "OPEN_FINDING missing progress reporting",
							evidence: [task2Report],
						},
						{
							id: "f2",
							task: 2,
							status: "open",
							summary: "CONSTRAINT_LEAK against PROTECTED_CONSTRAINT",
							evidence: [findingTwoEvidence],
						},
					],
					rejectedApproaches: [
						{
							id: "r1",
							task: 2,
							summary: "REJECTED_APPROACH rewrite from scratch",
							reason: "loses the reviewed Task 1 interface and the immutable verification base",
							evidence: [task2ReviewPackage],
						},
					],
					evidenceRefs: [task2Report, task2ReviewPackage, findingTwoEvidence],
				},
			});
			if (!recorded.acknowledged) fail("recordRecovery refused the task-2 fix-round snapshot");
			resultPublished = true;
			return { acknowledged: recorded.acknowledged, discoveryRef: recorded.snapshotEvidence };
		};
		if (!options?.deferResult) await publishResult();

		const exportProjection = async (context?: { cwd: string; planPath: string }): Promise<WorkProjectionV1> =>
			helpers.exportRecovery({
				root: context?.cwd ?? workspace,
				planPath: context?.planPath ?? PLAN_RELATIVE_PATH,
				workflow: "sdd",
				showIssue,
				config,
				runtimeCheck: false,
			});

		const workflow: ContinuationWorkflow = {
			id: "sjujperpowers",
			exportProjection,
		};

		let inferenceProvider = "scripted-anthropic";

		const observeClaims = async () => {
			const projection = await exportProjection();
			const shows: Record<string, unknown> = {};
			for (const child of children) {
				shows[child.ref] = await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
			}
			return { projection, shows };
		};

		const observeCompletion = async () => {
			const projection = await exportProjection();
			return {
				projection,
				tasks: projection.tasks.map(task => ({
					number: task.number,
					state: task.state,
					kataStatus: task.claim?.status ?? null,
					ref: task.claim?.ref ?? null,
				})),
			};
		};

		const mutateClaimRevision = async (task = 2) => {
			const child = taskByNumber.get(task);
			if (!child) fail(`no materialized child for task ${task}`);
			const beforePayload = await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
			const beforeLease = asRecord(asRecord(beforePayload)?.lease);
			const before = integerField(beforeLease?.revision);
			const projectId = integerField(asRecord(projectShow?.project)?.id ?? projectShow?.id);
			const socket = address.startsWith("unix://") ? address.slice(7) : address;
			if (projectId === null || !socket.startsWith("/") || !beforeLease) {
				fail("Native Kata lease renewal requires the observed project, private socket and live lease");
			}
			const renewed = await fetch(
				`http://kata.fixture/api/v1/projects/${projectId}/issues/${child.shortId}/lease/actions/renew`,
				{
					unix: socket,
					method: "POST",
					redirect: "manual",
					signal: AbortSignal.timeout(EXEC_TIMEOUT_MS),
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						holder: KATA_ACTOR,
						holder_instance_uid: beforeLease.holder_instance_uid,
						client_kind: "cli",
						ttl_seconds: 1800,
					}),
				},
			);
			if (!renewed.ok) fail(`Native Kata lease renewal failed: ${renewed.status} ${await renewed.text()}`);
			await renewed.arrayBuffer();
			const afterPayload = await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
			const afterLease = asRecord(asRecord(afterPayload)?.lease);
			if (afterLease?.claim_uid !== beforeLease.claim_uid || afterLease?.holder !== KATA_ACTOR) {
				fail("Native Kata renewal changed claim identity or execution actor");
			}
			return {
				ref: child.ref,
				before,
				after: integerField(afterLease?.revision),
				claimUid: beforeLease.claim_uid,
				afterClaimUid: afterLease?.claim_uid,
				issueRevisionBefore: issueRevision(beforePayload),
				issueRevisionAfter: issueRevision(afterPayload),
			};
		};

		const transferClaimToForeign = async (task = 2) => {
			const child = taskByNumber.get(task);
			if (!child) fail(`no materialized child for task ${task}`);
			const beforePayload = await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
			const beforeLease = asRecord(asRecord(beforePayload)?.lease);
			if (!beforeLease || beforeLease.holder !== KATA_ACTOR) {
				fail("Native claim transfer requires the authorized actor's live lease");
			}
			await runKataJson([
				"--workspace",
				workspace,
				"--project",
				KATA_PROJECT,
				"--json",
				"--as",
				KATA_ACTOR,
				"federation",
				"lease",
				"release",
				child.shortId,
			]);
			const releasedPayload = await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
			const releasedLease = asRecord(asRecord(releasedPayload)?.lease);
			if (releasedLease && !releasedLease.released_at && releasedLease.holder === KATA_ACTOR) {
				fail("Native Kata lease release left the authorized actor holding the lease");
			}
			await runKataJson([
				"--workspace",
				workspace,
				"--project",
				KATA_PROJECT,
				"--json",
				"--as",
				KATA_INTRUDER_ACTOR,
				"federation",
				"lease",
				"acquire",
				child.shortId,
				"--ttl",
				"30m",
			]);
			const afterPayload = await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
			const afterLease = asRecord(asRecord(afterPayload)?.lease);
			if (afterLease?.holder !== KATA_INTRUDER_ACTOR) {
				fail(`Foreign acquire did not take the lease: ${JSON.stringify(afterLease)}`);
			}
			return {
				ref: child.ref,
				beforeHolder: stringField(beforeLease.holder),
				afterHolder: stringField(afterLease?.holder),
				afterClaimUid: afterLease?.claim_uid,
			};
		};

		const closeChildWithEvidence = async (task = 2) => {
			const child = taskByNumber.get(task);
			if (!child) fail(`no materialized child for task ${task}`);
			await runKataJson([
				"--workspace",
				workspace,
				"--project",
				KATA_PROJECT,
				"--json",
				"--as",
				KATA_ACTOR,
				"close",
				child.shortId,
				"--done",
				"--message",
				"fixture close with commit and test evidence while review remains open",
				"--commit",
				VERIFICATION_HEAD,
				"--test",
				"fixture: continuation-kata review evidence",
				"--reviewed",
				PLAN_RELATIVE_PATH,
			]);
			const afterPayload = await showIssue({ root: workspace, project: KATA_PROJECT, ref: child.ref });
			const status = stringField(asRecord(asRecord(afterPayload)?.issue)?.status);
			if (status !== "closed") fail(`Kata close did not close ${child.ref}: ${JSON.stringify(afterPayload)}`);
			return { ref: child.ref, status };
		};

		const recordAuthorizedLiveClaims = async () => {
			const projection = await exportProjection();
			recorded = await helpers.recordRecovery({
				root: workspace,
				planPath: PLAN_RELATIVE_PATH,
				config,
				showIssue,
				event: {
					expectedRevision: recorded.revision + 1,
					nextAction: projection.current.nextAction,
					claims: projection.claims,
					tasks: projection.tasks.map(task => ({ number: task.number, claim: task.claim })),
				},
			});
			if (!recorded.acknowledged) fail("recordRecovery refused the provider-authorized live claims");
			return { acknowledged: recorded.acknowledged, revision: recorded.revision };
		};

		const seeded = await exportProjection();
		if (seeded.recovery.status === "unsupported") {
			fail(`seeded exportRecovery is unsupported: ${seeded.recovery.blockers.join(", ")}`);
		}

		return {
			root: workspace,
			planPath: PLAN_RELATIVE_PATH,
			planAbsolutePath: path.join(workspace, PLAN_RELATIVE_PATH),
			project: KATA_PROJECT,
			actor: KATA_ACTOR,
			kataBin,
			workflowSource: path.resolve(workflowSource),
			requirements: KATA_WORKFLOW_REQUIREMENTS,
			workflow,
			materialization: { parent: materialized.parent, children },
			get snapshot() {
				return {
					revision: recorded.revision,
					eventId: recorded.eventId,
					progressPath: recorded.progressPath,
					evidence: recorded.snapshotEvidence,
				};
			},
			report: { progressPath: recorded.progressPath, task2Report, task2ReviewPackage },
			evidence: {
				verificationBase: VERIFICATION_BASE,
				verificationHead: VERIFICATION_HEAD,
				findings: [task2Report, findingTwoEvidence],
				retained: recorded.retained,
			},
			env,
			get inferenceProvider() {
				return inferenceProvider;
			},
			switchInferenceProvider(provider: string) {
				inferenceProvider = provider;
				return inferenceProvider;
			},
			runKata,
			exportProjection,
			observeClaims,
			observeCompletion,
			mutateClaimRevision,
			transferClaimToForeign,
			closeChildWithEvidence,
			recordAuthorizedLiveClaims,
			publishResult,
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

function capability(
	capability: string,
	supported: boolean,
	extra: { reason?: string; observation?: unknown } = {},
): KataCapabilityResult {
	return { capability, supported, ...extra };
}

/**
 * Sandbox-only PT-01 conformance: claim revision, force-claim refusal, and
 * completion semantics against the live Kata daemon. Unsupported results are
 * returned explicitly; never converted into skipped success.
 */
export async function exerciseKataWorkflowConformance(fixture: KataWorkflowFixture): Promise<{
	actor: string;
	inferenceProviderAfterSwitch: string;
	claimRevision: KataCapabilityResult;
	forceClaimRefusal: KataCapabilityResult;
	completion: KataCapabilityResult;
	actorIdentity: KataCapabilityResult;
	unsupported: KataCapabilityResult[];
}> {
	const before = await fixture.observeClaims();
	const task2 = before.projection.tasks.find(task => task.number === 2);
	const task2Ref = task2?.claim?.ref ?? fixture.materialization.children.find(child => child.task === 2)?.ref;
	if (!task2Ref) fail("seeded projection is missing the task 2 Kata claim");

	const mutated = await fixture.mutateClaimRevision(2);
	let claimRevision: KataCapabilityResult;
	if (mutated.before === null || mutated.after === null) {
		claimRevision = capability("claim-revision", false, {
			reason: "Kata show did not return an integer lease.revision before/after renewal",
			observation: mutated,
		});
	} else if (mutated.after <= mutated.before) {
		claimRevision = capability("claim-revision", false, {
			reason: "native lease renewal did not advance lease.revision",
			observation: mutated,
		});
	} else {
		claimRevision = capability("claim-revision", true, { observation: mutated });
	}

	const child2 = fixture.materialization.children.find(child => child.task === 2);
	if (!child2) fail("missing materialized task 2");
	const forced = await fixture.runKata(
		[
			"--workspace",
			fixture.root,
			"--project",
			fixture.project,
			"--json",
			"--as",
			KATA_INTRUDER_ACTOR,
			"claim",
			child2.shortId,
		],
		{ allowFailure: true },
	);
	let forceClaimRefusal: KataCapabilityResult;
	if (forced.exitCode === 0) {
		forceClaimRefusal = capability("force-claim-refusal", false, {
			reason: "claim without --force succeeded for a foreign actor; Kata v0.16 must refuse this",
			observation: forced.payload,
		});
	} else {
		const refusal = asRecord(
			asRecord(parseJson(forced.stderr || forced.stdout, "foreign Kata claim refusal"))?.error,
		);
		const afterDenied = await fixture.observeClaims();
		const lease = asRecord(asRecord(afterDenied.shows[child2.ref])?.lease);
		const refused =
			refusal?.code === "claim_denied" && lease?.holder === KATA_ACTOR && lease?.revision === mutated.after;
		forceClaimRefusal = capability("force-claim-refusal", refused, {
			reason: refused ? undefined : "foreign mutation was not denied with an unchanged authorized lease",
			observation: { exitCode: forced.exitCode, refusal, lease },
		});
	}

	const completion = await fixture.observeCompletion();
	const task1 = completion.tasks.find(task => task.number === 1);
	const task2State = completion.tasks.find(task => task.number === 2);
	const task3 = completion.tasks.find(task => task.number === 3);
	const child1 = fixture.materialization.children.find(child => child.task === 1);
	if (!child1) fail("missing materialized task 1");
	const premature = await fixture.runKata(
		[
			"--workspace",
			fixture.root,
			"--project",
			fixture.project,
			"--json",
			"--as",
			KATA_ACTOR,
			"close",
			child1.shortId,
			"--done",
			"--message",
			"premature close without landing evidence",
		],
		{ allowFailure: true },
	);
	const unlanded = task1?.state === "complete_unlanded" && task1.kataStatus === "open";
	const pending = task3?.state === "pending";
	const reviewing = task2State?.state === "fix" || task2State?.state === "review";
	const closeRefused = premature.exitCode !== 0 && /evidence/i.test(`${premature.stderr}\n${premature.stdout}`);
	let completionResult: KataCapabilityResult;
	if (!unlanded || !pending || !reviewing) {
		completionResult = capability("completion-semantics", false, {
			reason: "seeded states are not task1 complete_unlanded / task2 review-or-fix / task3 pending",
			observation: { tasks: completion.tasks, recovery: completion.projection.recovery },
		});
	} else if (!closeRefused) {
		completionResult = capability("completion-semantics", false, {
			reason:
				"Kata accepted close --done without commit/pr/test/reviewed evidence; refusing to treat that as landed completion",
			observation: { stdout: premature.stdout, tasks: completion.tasks },
		});
	} else {
		completionResult = capability("completion-semantics", true, {
			observation: {
				tasks: completion.tasks,
				prematureClose: { exitCode: premature.exitCode, stderr: premature.stderr },
			},
		});
	}

	const switched = fixture.switchInferenceProvider("scripted-openai");
	const afterSwitch = await fixture.observeClaims();
	const owner =
		afterSwitch.projection.tasks.find(task => task.number === 2)?.claim?.owner ??
		afterSwitch.projection.tasks.find(task => task.number === 2)?.claim?.claimOwner ??
		issueOwner(afterSwitch.shows[task2Ref]);
	const actorIdentity = capability("execution-actor-identity", owner === fixture.actor, {
		reason:
			owner === fixture.actor
				? undefined
				: `owner ${JSON.stringify(owner)} drifted from ${fixture.actor} after inference provider switch`,
		observation: { inferenceProvider: switched, owner, actor: fixture.actor },
	});

	const results = [claimRevision, forceClaimRefusal, completionResult, actorIdentity];
	return {
		actor: fixture.actor,
		inferenceProviderAfterSwitch: switched,
		claimRevision,
		forceClaimRefusal,
		completion: completionResult,
		actorIdentity,
		unsupported: results.filter(result => !result.supported),
	};
}
