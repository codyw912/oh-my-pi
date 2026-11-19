import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ContinuationWorkflow } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { FileEvidenceRef } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import type { WorkProjectionV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-work";
import type { PilotCheck, PilotWorkload } from "./contract";
import continuationPrompt from "./prompts/continuation-review.md" with { type: "text" };
import sourcePrompt from "./prompts/source-primer.md" with { type: "text" };
import systemPrompt from "./prompts/system.md" with { type: "text" };

const PLAN_PATH = "docs/project/plans/refund-idempotency.md";
const readInput = type({ path: "string" });
const reviewInput = type({ report: "string" });
const probeInput = type({
	merchantId: "string",
	accountId: "string",
	paymentId: "string",
	amount: "number",
	idempotencyKey: "string",
});
const FIXTURE_FILES = [
	["fixtures/refund-service.mjs", "app/refund-service.mjs"],
	["fixtures/probe-refund-service.mjs", "app/probe-refund-service.mjs"],
	["fixtures/visible-checks.mjs", "checks/visible-checks.mjs"],
	["fixtures/plan.md", PLAN_PATH],
	["fixtures/refund-api.md", "docs/project/specs/refund-api.md"],
	["fixtures/task-1-evidence.md", "docs/project/evidence/task-1-completion.md"],
] as const;

interface ProbeObservation {
	id: string;
	request: {
		merchantId: string;
		accountId: string;
		paymentId: string;
		amount: number;
		idempotencyKey: string;
	};
	response: Record<string, unknown>;
}

interface SubmittedReview {
	report: string;
	referencedEvidence: string[];
}

function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function textResult(text: string, details?: unknown, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		...(details === undefined ? {} : { details }),
		...(isError ? { isError: true } : {}),
	};
}

function referencedEvidence(report: string): string[] {
	return [...new Set(report.match(/\bprobe-[1-9][0-9]*\b/g) ?? [])];
}

async function copyFixture(root: string, source: string, destination: string): Promise<Uint8Array> {
	const bytes = await fs.readFile(new URL(source, import.meta.url));
	const target = path.join(root, destination);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(target, bytes, { flag: "w" });
	return bytes;
}

async function workspaceRegularFile(root: string, relativePath: string): Promise<string> {
	if (
		typeof relativePath !== "string" ||
		relativePath.length === 0 ||
		path.isAbsolute(relativePath) ||
		relativePath.split(/[\\/]+/).some(segment => segment === "..")
	) {
		throw new Error("path must be a workspace-relative path without traversal");
	}
	const workspace = await fs.realpath(root);
	const candidate = path.resolve(workspace, relativePath);
	const prefix = workspace.endsWith(path.sep) ? workspace : `${workspace}${path.sep}`;
	if (!candidate.startsWith(prefix)) throw new Error("path escapes the workspace");
	const stat = await fs.lstat(candidate);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("path must name a regular workspace file");
	const resolved = await fs.realpath(candidate);
	if (!resolved.startsWith(prefix)) throw new Error("symlink escapes the workspace");
	return resolved;
}

function fileRef(absolutePath: string, bytes: Uint8Array): FileEvidenceRef {
	return { kind: "file", path: absolutePath, byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

export async function createPilotWorkload(root: string): Promise<PilotWorkload> {
	await fs.mkdir(root, { recursive: true });
	const workspaceRoot = await fs.realpath(root);
	const frozenFiles = new Map<string, string>();
	for (const [source, destination] of FIXTURE_FILES) {
		const bytes = await copyFixture(workspaceRoot, source, destination);
		frozenFiles.set(destination, sha256(bytes));
	}

	const taskOneEvidencePath = await workspaceRegularFile(workspaceRoot, "docs/project/evidence/task-1-completion.md");
	const taskOneEvidence = fileRef(taskOneEvidencePath, await fs.readFile(taskOneEvidencePath));
	let observations: ProbeObservation[] = [];
	let submittedReview: SubmittedReview | undefined;

	// Replay the small, bounded probe sequence in a fresh process. This executes
	// the workspace service without loading workspace code into the pilot process.
	let serviceRequests: ProbeObservation["request"][] = [];

	const workflow: ContinuationWorkflow = {
		id: "continuation-pilot-inline",
		async exportProjection({ cwd, planPath }) {
			const projectionRoot = await fs.realpath(cwd);
			if (projectionRoot !== workspaceRoot || planPath !== PLAN_PATH) {
				throw new Error("Pilot workflow projection is scoped to its canonical frozen workspace and plan");
			}
			const planAbsolutePath = await workspaceRegularFile(projectionRoot, planPath);
			const planBytes = await fs.readFile(planAbsolutePath);
			const taskBrief =
				"Review the frozen implementation with code inspection and focused behavioral probes. Submit an evidence-backed artifact.\n";
			const projection: WorkProjectionV1 = {
				version: 1,
				plan: { root: projectionRoot, relativePath: planPath, sha256: sha256(planBytes) },
				workflow: "inline",
				execution: { provider: "session", completion: "landed" },
				revision: 1,
				constraints: [
					"The workspace is frozen for review: do not mutate source or publish.",
					"Preserve idempotent retry behavior for refund requests.",
				],
				current: { task: 2, phase: "review", round: 1, nextAction: "Review the frozen refund implementation" },
				tasks: [
					{
						number: 1,
						title: "Implement refund creation",
						state: "complete",
						phase: "complete",
						round: null,
						nextAction: null,
						brief: null,
						report: taskOneEvidence,
						reviewPackage: null,
						claim: null,
						commits: { base: null, head: null },
					},
					{
						number: 2,
						title: "Review completed implementation",
						state: "review",
						phase: "review",
						round: 1,
						nextAction: "Review the frozen refund implementation",
						brief: {
							kind: "regenerated",
							task: 2,
							text: taskBrief,
							byteLength: Buffer.byteLength(taskBrief, "utf8"),
							sha256: sha256(Buffer.from(taskBrief)),
						},
						report: null,
						reviewPackage: null,
						claim: null,
						commits: { base: null, head: null },
					},
				],
				findings: [
					{
						id: "review-pending",
						task: 2,
						status: "open",
						summary: "The completed implementation requires evidence-backed review before acceptance.",
						evidence: [taskOneEvidence],
					},
				],
				decisions: [
					{
						id: "frozen-review",
						task: 2,
						summary: "Review the completed implementation without source mutation or publication.",
						rationale: "The pilot compares review continuation strategies, not implementation edits.",
						costIfWrong: "A changed workspace would invalidate comparison between conditions.",
						sourceText: null,
						evidence: [taskOneEvidence],
					},
				],
				rejectedApproaches: [
					{
						id: "remove-idempotency",
						task: 2,
						summary: "Disable idempotency to avoid retry-path complexity.",
						reason: "Retry safety after ambiguous client or network outcomes is required.",
						evidence: [taskOneEvidence],
					},
				],
				evidence: [taskOneEvidence],
				claims: [],
				todos: [
					{ id: "task-1", content: "Implement refund creation", status: "completed" },
					{ id: "task-2", content: "Review the completed implementation", status: "in_progress" },
				],
				recovery: { eligible: true, status: "eligible", blockers: [], capabilities: ["read-only-projection"] },
			};
			return projection;
		},
	};

	const tools: AgentTool[] = [
		{
			name: "read_workspace_file",
			label: "Read workspace file",
			description:
				"Read one regular file using a workspace-relative path. Traversal, absolute paths, and symlink escapes are rejected.",
			parameters: readInput,
			intent: "omit",
			approval: "read",
			async execute(_id, args) {
				try {
					const filePath = await workspaceRegularFile(workspaceRoot, readInput.assert(args).path);
					return textResult(await fs.readFile(filePath, "utf8"));
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), undefined, true);
				}
			},
		},
		{
			name: "run_visible_checks",
			label: "Run visible checks",
			description: "Run the fixed visible refund-service checks. No command or path input is accepted.",
			parameters: type({}),
			intent: "omit",
			approval: "exec",
			concurrency: "exclusive",
			async execute() {
				serviceRequests = [];
				const child = Bun.spawn([process.execPath, "checks/visible-checks.mjs"], {
					cwd: workspaceRoot,
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				return textResult(
					`${stdout}${stderr}`.trim() || `visible checks exited ${exitCode}`,
					{ exitCode },
					exitCode !== 0,
				);
			},
		},
		{
			name: "probe_refund_service",
			label: "Probe refund service",
			description:
				"Create a refund with structured input and return the actual service response plus an evidence ID. No arbitrary code or shell is available.",
			parameters: probeInput,
			intent: "omit",
			approval: "exec",
			concurrency: "exclusive",
			async execute(_id, args) {
				try {
					const request = probeInput.assert(args);
					const child = Bun.spawn([process.execPath, "app/probe-refund-service.mjs"], {
						cwd: workspaceRoot,
						stdin: new Blob([JSON.stringify([...serviceRequests, request])]),
						stdout: "pipe",
						stderr: "pipe",
						timeout: 5_000,
					});
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					if (exitCode !== 0) throw new Error(stderr.trim() || `probe exited ${exitCode}`);
					const response = JSON.parse(stdout) as Record<string, unknown>;
					serviceRequests.push(request);
					const observation = { id: `probe-${observations.length + 1}`, request, response };
					observations.push(observation);
					return textResult(JSON.stringify(observation), observation);
				} catch (error) {
					return textResult(error instanceof Error ? error.message : String(error), undefined, true);
				}
			},
		},
		{
			name: "submit_review_artifact",
			label: "Submit review artifact",
			description:
				"Submit the final review text. Cite probe evidence IDs such as probe-1 for objective behavioral claims.",
			parameters: reviewInput,
			intent: "omit",
			approval: "write",
			concurrency: "exclusive",
			async execute(_id, args) {
				const { report } = reviewInput.assert(args);
				submittedReview = { report, referencedEvidence: referencedEvidence(report) };
				return textResult("review artifact recorded", { referencedEvidence: submittedReview.referencedEvidence });
			},
		},
	];

	return {
		root: workspaceRoot,
		planPath: PLAN_PATH,
		workflow,
		systemPrompt,
		sourcePrompt: JSON.stringify({ instruction: sourcePrompt, files: [...frozenFiles.keys()] }),
		continuationPrompt,
		tools,
		preparation: {
			retainedInstructions: ["Do not mutate source or publish; submit an evidence-backed review artifact."],
			roleObligations: [
				"Act as a reviewer: preserve retry safety and distinguish observed behavior from recommendations.",
			],
			discoveries: [
				{
					summary: "Task 1 implementation and its visible checks are complete; Task 2 is the pending review.",
					evidence: [taskOneEvidence],
				},
			],
			readDraft: () => null,
			maxBriefingBytes: 32_768,
			settlementTimeoutMs: 5_000,
		},
		resetObservations() {
			observations = [];
			submittedReview = undefined;
			serviceRequests = [];
		},
		async verify() {
			const checks: PilotCheck[] = [];
			let workspaceIntact = true;
			const changed: string[] = [];
			for (const [relativePath, expectedHash] of frozenFiles) {
				try {
					const filePath = await workspaceRegularFile(workspaceRoot, relativePath);
					if (sha256(await fs.readFile(filePath)) !== expectedHash) {
						workspaceIntact = false;
						changed.push(relativePath);
					}
				} catch {
					workspaceIntact = false;
					changed.push(relativePath);
				}
			}
			checks.push({
				id: "workspace-integrity",
				passed: workspaceIntact,
				evidence: workspaceIntact
					? "All frozen workspace files retain their original SHA-256 hashes."
					: `Changed or inaccessible: ${changed.join(", ")}`,
			});

			const observationIds = new Set(observations.map(item => item.id));
			const citedEvidence = submittedReview?.referencedEvidence.filter(id => observationIds.has(id)) ?? [];
			const allCitationsObserved =
				citedEvidence.length > 0 && citedEvidence.length === submittedReview?.referencedEvidence.length;
			checks.push({
				id: "review-submitted",
				passed: submittedReview !== undefined,
				evidence: submittedReview ? "A review artifact was submitted." : "No review artifact was submitted.",
			});
			checks.push({
				id: "report-references-observed-probes",
				passed: allCitationsObserved,
				evidence: allCitationsObserved
					? `Report cites observed evidence: ${citedEvidence.join(", ")}.`
					: "The report has missing or fabricated probe citations.",
			});
			const crossScopeEvidence = observations.filter(
				item =>
					item.request.merchantId !== item.response.merchantId ||
					item.request.accountId !== item.response.accountId,
			);
			const supportedFinding = crossScopeEvidence.some(item => citedEvidence.includes(item.id));
			checks.push({
				id: "cites-cross-scope-observation",
				passed: supportedFinding,
				evidence: supportedFinding
					? `Report cites cross-scope observation(s): ${crossScopeEvidence
							.filter(item => citedEvidence.includes(item.id))
							.map(item => item.id)
							.join(", ")}.`
					: "No cited probe observation demonstrates a cross-scope result mismatch.",
			});
			return {
				checks,
				review: {
					report: submittedReview?.report ?? null,
					referencedEvidence: submittedReview?.referencedEvidence ?? [],
					humanReview:
						"awaiting human assessment of recommendation quality, severity, and clarity; no exact-text judgment is applied",
				},
				operations: observations.map(item => structuredClone(item)),
			};
		},
	};
}
