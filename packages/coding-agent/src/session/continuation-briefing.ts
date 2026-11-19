/**
 * Destination-neutral continuation briefing.
 *
 * Builds the three-layer handoff text from a work projection and validated
 * local file prefixes. It does not talk to inference providers, copy source
 * history, or invent workflow completion.
 */
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import briefingTemplate from "../prompts/system/continuation-briefing.md" with { type: "text" };
import type { ContinuationDestination } from "./continuation-policy";
import type { FileEvidenceRef } from "./continuation-store";
import type { WorkProjectionV1 } from "./continuation-work";

const HASH = /^[0-9a-f]{64}$/;

export type ContinuationBriefingErrorCode =
	| "invalid-input"
	| "contradictory-state"
	| "missing-evidence"
	| "changed-evidence"
	| "invalid-brief"
	| "oversize";

export class ContinuationBriefingError extends Error {
	readonly code: ContinuationBriefingErrorCode;
	readonly details: Record<string, unknown> | undefined;

	constructor(code: ContinuationBriefingErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ContinuationBriefingError";
		this.code = code;
		this.details = details;
	}
}

export interface ContinuationDiscovery {
	summary: string;
	evidence: readonly FileEvidenceRef[];
}

/** Nonsecret identity/access for a live hub-managed project service. */
export interface ContinuationServiceHandle {
	name: string;
	id: string;
	pid?: number;
	startedAt: number;
	owner?: string;
	persist: boolean;
	detached: boolean;
}

export interface ContinuationBriefingInput {
	projection: WorkProjectionV1;
	runId: string;
	generation: number;
	sourceSessionId: string;
	sourceTranscript: FileEvidenceRef;
	policyRevision: string;
	destination: ContinuationDestination;
	roleObligations: readonly string[];
	retainedInstructions: readonly string[];
	discoveries: readonly ContinuationDiscovery[];
	services: readonly ContinuationServiceHandle[];
	maxBytes: number;
}

export interface ContinuationBriefing {
	text: string;
	evidence: FileEvidenceRef[];
	byteLength: number;
	protectedFacts: readonly string[];
}

type ProjectionTask = WorkProjectionV1["tasks"][number];
type RegeneratedBrief = Extract<ProjectionTask["brief"], { kind: "regenerated" }>;

const COMPLETED_STATES: Record<string, true> = { complete: true, complete_unlanded: true };
const REVIEW_FIX: Record<string, true> = { review: true, fix: true };

/** Mechanical three-layer briefing. Protected facts are never trimmed to fit. */
export async function buildContinuationBriefing(input: ContinuationBriefingInput): Promise<ContinuationBriefing> {
	validateInput(input);
	const projection = input.projection;
	const tasks = indexTasks(projection);
	const current = requireCurrentTask(projection, tasks);
	assertProjectionConsistency(projection, tasks, current);

	const evidence = new Map<string, FileEvidenceRef>();
	const protectedFacts: string[] = [];
	const seenFacts = new Set<string>();
	const addFact = (value: string): void => {
		if (!value.trim()) {
			throw new ContinuationBriefingError("invalid-input", "Protected fact strings must be nonempty.");
		}
		if (seenFacts.has(value)) return;
		seenFacts.add(value);
		protectedFacts.push(value);
	};

	await readValidatedPrefix(input.sourceTranscript);
	remember(evidence, input.sourceTranscript);

	const currentBriefText = await resolveCurrentBrief(current, current.number);
	if (current.brief?.kind === "file") remember(evidence, current.brief);
	await retainOptional(evidence, current.report);
	await retainOptional(evidence, current.reviewPackage);

	for (const ref of projection.evidence) await retainOptional(evidence, ref);
	for (const item of projection.findings) {
		for (const ref of item.evidence) await retainOptional(evidence, ref);
	}
	for (const item of projection.decisions) {
		for (const ref of item.evidence) await retainOptional(evidence, ref);
	}
	for (const item of projection.rejectedApproaches) {
		for (const ref of item.evidence) await retainOptional(evidence, ref);
	}
	for (const discovery of input.discoveries) {
		assertNonEmptyString(discovery.summary, "discoveries.summary");
		if (!Array.isArray(discovery.evidence)) {
			throw new ContinuationBriefingError("invalid-input", "discoveries.evidence must be an array.");
		}
		for (const ref of discovery.evidence) await retainOptional(evidence, ref);
	}

	for (const constraint of projection.constraints) addFact(constraint);
	for (const instruction of input.retainedInstructions) addFact(instruction);
	for (const obligation of input.roleObligations) addFact(obligation);
	for (const service of input.services) {
		addFact(service.name);
		addFact(service.id);
	}
	addFact(projection.current.phase);
	addFact(projection.current.nextAction);
	if (projection.current.round !== null) addFact(`round ${projection.current.round}`);
	addFact(`task ${current.number}`);
	addFact(current.title);
	for (const finding of projection.findings) {
		if (finding.status === "open") addFact(finding.summary);
	}
	for (const decision of projection.decisions) addFact(decision.summary);
	for (const rejected of projection.rejectedApproaches) {
		addFact(rejected.summary);
		addFact(rejected.reason);
	}
	const completed: ProjectionTask[] = [];
	for (const task of projection.tasks) {
		if (!COMPLETED_STATES[task.state]) continue;
		completed.push(task);
		addFact(`task ${task.number}`);
		addFact(task.title);
	}

	const others = projection.tasks.filter(task => task.number !== current.number);
	for (const task of others) {
		await retainOptional(evidence, task.report);
		await retainOptional(evidence, task.reviewPackage);
	}
	const text = prompt.render(briefingTemplate, {
		runId: input.runId,
		generation: input.generation,
		sourceSessionId: input.sourceSessionId,
		sourceTranscript: formatRef(input.sourceTranscript),
		policyRevision: input.policyRevision,
		projection,
		current,
		destination: input.destination,
		authorizedRoles: input.destination.roles.join(", "),
		retainedInstructions: input.retainedInstructions,
		roleObligations: input.roleObligations,
		hasRound: projection.current.round !== null,
		openFindings: projection.findings.filter(item => item.status === "open"),
		completed: completed.map(task => ({
			...task,
			landingOutstanding: task.state === "complete_unlanded" || task.claim?.status === "open",
		})),
		currentBriefText,
		currentReport: current.report ? formatRef(current.report) : "none",
		currentReviewPackage: current.reviewPackage ? formatRef(current.reviewPackage) : "none",
		hasCommits: Boolean(current.commits.base || current.commits.head),
		commitBase: current.commits.base ?? "none",
		commitHead: current.commits.head ?? "none",
		hasClaimRevision: current.claim?.observedRevision !== null && current.claim?.observedRevision !== undefined,
		otherTasks: others.map(task => ({
			...task,
			completed: Boolean(COMPLETED_STATES[task.state]),
			reportReference: task.report ? formatRef(task.report) : null,
			reviewReference: task.reviewPackage ? formatRef(task.reviewPackage) : null,
		})),
		discoveries: input.discoveries.map(discovery => ({
			summary: discovery.summary,
			references: discovery.evidence.map(formatRef),
		})),
		services: input.services,
	});
	for (const fact of protectedFacts) {
		if (!text.includes(fact)) {
			throw new ContinuationBriefingError("contradictory-state", "Protected fact is missing from briefing text.", {
				fact,
			});
		}
	}
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength > input.maxBytes) {
		throw new ContinuationBriefingError(
			"oversize",
			`Continuation briefing is ${byteLength} bytes; required start context and working set exceed maxBytes ${input.maxBytes} and cannot be trimmed.`,
			{ byteLength, maxBytes: input.maxBytes, protectedFactCount: protectedFacts.length },
		);
	}
	return { text, evidence: [...evidence.values()], byteLength, protectedFacts };
}

function validateInput(input: ContinuationBriefingInput): void {
	if (!input || typeof input !== "object") {
		throw new ContinuationBriefingError("invalid-input", "Continuation briefing input is required.");
	}
	if (!input.projection || typeof input.projection !== "object") {
		throw new ContinuationBriefingError("invalid-input", "projection is required.");
	}
	assertNonEmptyString(input.runId, "runId");
	assertNonEmptyString(input.sourceSessionId, "sourceSessionId");
	assertNonEmptyString(input.policyRevision, "policyRevision");
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
		throw new ContinuationBriefingError("invalid-input", "generation must be an integer >= 0.", {
			generation: input.generation,
		});
	}
	if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0) {
		throw new ContinuationBriefingError("invalid-input", "maxBytes must be an integer >= 0.", {
			maxBytes: input.maxBytes,
		});
	}
	if (!input.destination || typeof input.destination !== "object") {
		throw new ContinuationBriefingError("invalid-input", "destination is required.");
	}
	assertNonEmptyString(input.destination.dataScope, "destination.dataScope");
	if (!Array.isArray(input.destination.roles)) {
		throw new ContinuationBriefingError("invalid-input", "destination.roles must be an array.");
	}
	assertStringArray(input.roleObligations, "roleObligations");
	assertStringArray(input.retainedInstructions, "retainedInstructions");
	if (!Array.isArray(input.discoveries)) {
		throw new ContinuationBriefingError("invalid-input", "discoveries must be an array.");
	}
	if (!Array.isArray(input.services)) {
		throw new ContinuationBriefingError("invalid-input", "services must be an array.");
	}
	for (const [index, service] of input.services.entries()) {
		assertNonEmptyString(service?.name, `services[${index}].name`);
		assertNonEmptyString(service?.id, `services[${index}].id`);
		if (!Number.isSafeInteger(service.startedAt) || service.startedAt < 0) {
			throw new ContinuationBriefingError("invalid-input", `services[${index}].startedAt must be an integer >= 0.`);
		}
		if (typeof service.persist !== "boolean" || typeof service.detached !== "boolean") {
			throw new ContinuationBriefingError(
				"invalid-input",
				`services[${index}] persist and detached must be booleans.`,
			);
		}
	}
	assertEvidenceRef(input.sourceTranscript, "sourceTranscript");
}

function indexTasks(projection: WorkProjectionV1): Map<number, ProjectionTask> {
	if (!Array.isArray(projection.tasks)) {
		throw new ContinuationBriefingError("invalid-input", "projection.tasks must be an array.");
	}
	const tasks = new Map<number, ProjectionTask>();
	for (const task of projection.tasks) {
		if (!Number.isSafeInteger(task.number) || task.number < 1) {
			throw new ContinuationBriefingError("contradictory-state", "Task identity is invalid.", { task });
		}
		if (tasks.has(task.number)) {
			throw new ContinuationBriefingError("contradictory-state", `Duplicate task identity ${task.number}.`);
		}
		tasks.set(task.number, task);
	}
	return tasks;
}

function requireCurrentTask(projection: WorkProjectionV1, tasks: Map<number, ProjectionTask>): ProjectionTask {
	if (projection.current.task === null) {
		throw new ContinuationBriefingError("contradictory-state", "Missing critical current task.");
	}
	const current = tasks.get(projection.current.task);
	if (!current) {
		throw new ContinuationBriefingError(
			"contradictory-state",
			`Current task ${projection.current.task} is not in the projection.`,
		);
	}
	return current;
}

function assertProjectionConsistency(
	projection: WorkProjectionV1,
	tasks: Map<number, ProjectionTask>,
	current: ProjectionTask,
): void {
	if (current.state === "contradictory") {
		throw new ContinuationBriefingError("contradictory-state", `Current task ${current.number} is contradictory.`);
	}
	if (current.phase !== projection.current.phase) {
		throw new ContinuationBriefingError("contradictory-state", "Current task phase does not match the projection.", {
			task: current.number,
			taskPhase: current.phase,
			currentPhase: projection.current.phase,
		});
	}
	if (current.round !== projection.current.round) {
		throw new ContinuationBriefingError("contradictory-state", "Current task round does not match the projection.", {
			task: current.number,
			taskRound: current.round,
			currentRound: projection.current.round,
		});
	}
	if (current.nextAction !== projection.current.nextAction) {
		throw new ContinuationBriefingError(
			"contradictory-state",
			"Current task next action does not match the projection.",
			{ task: current.number, taskNextAction: current.nextAction, currentNextAction: projection.current.nextAction },
		);
	}
	if ((REVIEW_FIX[current.state] || REVIEW_FIX[projection.current.phase]) && projection.current.round === null) {
		throw new ContinuationBriefingError("contradictory-state", "Review/fix continuity requires an explicit round.", {
			phase: projection.current.phase,
			state: current.state,
		});
	}
	for (const finding of projection.findings) {
		const task = tasks.get(finding.task);
		if (!task) {
			throw new ContinuationBriefingError("contradictory-state", `Finding ${finding.id} refers to an unknown task.`);
		}
		if (finding.status === "open" && COMPLETED_STATES[task.state]) {
			throw new ContinuationBriefingError(
				"contradictory-state",
				`Open finding ${finding.id} contradicts completed task ${task.number}.`,
			);
		}
	}
	if (projection.recovery.status === "contradictory") {
		throw new ContinuationBriefingError("contradictory-state", "Projection recovery status is contradictory.", {
			blockers: projection.recovery.blockers,
		});
	}
}

async function resolveCurrentBrief(task: ProjectionTask, currentTask: number): Promise<string> {
	const brief = task.brief;
	if (!brief) {
		throw new ContinuationBriefingError(
			"missing-evidence",
			`Missing critical current task brief for task ${task.number}.`,
			{
				task: task.number,
			},
		);
	}
	if (brief.kind === "regenerated") {
		return validateRegeneratedBrief(brief, task.number, currentTask);
	}
	const bytes = await readValidatedPrefix(brief);
	return bytes.toString("utf8");
}

function validateRegeneratedBrief(brief: RegeneratedBrief, taskNumber: number, currentTask: number): string {
	if (brief.task !== taskNumber || brief.task !== currentTask) {
		throw new ContinuationBriefingError(
			"invalid-brief",
			`Regenerated brief task ${brief.task} does not match current task ${currentTask}.`,
			{ briefTask: brief.task, taskNumber, currentTask },
		);
	}
	if (typeof brief.text !== "string") {
		throw new ContinuationBriefingError("invalid-brief", "Regenerated brief text is required.");
	}
	const byteLength = Buffer.byteLength(brief.text, "utf8");
	if (brief.byteLength !== byteLength) {
		throw new ContinuationBriefingError(
			"invalid-brief",
			`Regenerated brief byteLength ${brief.byteLength} does not match text size ${byteLength}.`,
			{ declared: brief.byteLength, actual: byteLength },
		);
	}
	const digest = sha256Hex(brief.text);
	if (brief.sha256 !== digest) {
		throw new ContinuationBriefingError(
			"invalid-brief",
			"Regenerated brief sha256 does not match the declared text.",
			{ declared: brief.sha256, actual: digest },
		);
	}
	if (!brief.text.trim()) {
		throw new ContinuationBriefingError(
			"missing-evidence",
			`Missing critical current task brief for task ${taskNumber}.`,
		);
	}
	return brief.text;
}

async function retainOptional(evidence: Map<string, FileEvidenceRef>, ref: FileEvidenceRef | null): Promise<void> {
	if (!ref) return;
	await readValidatedPrefix(ref);
	remember(evidence, ref);
}

function remember(evidence: Map<string, FileEvidenceRef>, ref: FileEvidenceRef): void {
	evidence.set(`${ref.path}\0${ref.byteLength}\0${ref.sha256}`, ref);
}

async function readValidatedPrefix(ref: FileEvidenceRef): Promise<Buffer> {
	assertEvidenceRef(ref, "evidence");
	let canonical: string;
	try {
		canonical = await fs.realpath(ref.path);
	} catch (error) {
		const missing = nodeErrorCode(error) === "ENOENT";
		throw new ContinuationBriefingError(
			missing ? "missing-evidence" : "changed-evidence",
			`${missing ? "Missing" : "Unreadable"} continuation evidence: ${ref.path}`,
			{ ref, error: String(error) },
		);
	}
	if (canonical !== path.resolve(ref.path)) {
		throw new ContinuationBriefingError(
			"changed-evidence",
			`Continuation evidence path is not canonical: ${ref.path}`,
			{
				ref,
				canonical,
			},
		);
	}
	let handle: FileHandle;
	try {
		handle = await fs.open(ref.path, "r");
	} catch (error) {
		const missing = nodeErrorCode(error) === "ENOENT";
		throw new ContinuationBriefingError(
			missing ? "missing-evidence" : "changed-evidence",
			`${missing ? "Missing" : "Unreadable"} continuation evidence: ${ref.path}`,
			{ ref, error: String(error) },
		);
	}
	try {
		const prefix = Buffer.alloc(ref.byteLength);
		const { bytesRead } = await handle.read(prefix, 0, ref.byteLength, 0);
		if (bytesRead !== ref.byteLength) {
			throw new ContinuationBriefingError(
				"changed-evidence",
				`Continuation evidence ${ref.path} is shorter than byteLength`,
				{ ref, actual: bytesRead },
			);
		}
		const digest = sha256Hex(prefix);
		if (digest !== ref.sha256) {
			throw new ContinuationBriefingError(
				"changed-evidence",
				`Continuation evidence ${ref.path} does not match sha256`,
				{
					ref,
					actual: digest,
				},
			);
		}
		return prefix;
	} finally {
		await handle.close();
	}
}

function sha256Hex(data: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function assertEvidenceRef(ref: FileEvidenceRef, label: string): void {
	if (!ref || ref.kind !== "file") {
		throw new ContinuationBriefingError("invalid-input", `${label} must be a file evidence ref.`);
	}
	assertNonEmptyString(ref.path, `${label}.path`);
	if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
		throw new ContinuationBriefingError("invalid-input", `${label}.byteLength must be an integer >= 0.`, { ref });
	}
	if (typeof ref.sha256 !== "string" || !HASH.test(ref.sha256)) {
		throw new ContinuationBriefingError(
			"invalid-input",
			`${label}.sha256 must be a 64-character lowercase hex digest.`,
			{
				ref,
			},
		);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !value.trim()) {
		throw new ContinuationBriefingError("invalid-input", `${label} must be a nonempty string.`);
	}
}

function assertStringArray(value: unknown, label: string): asserts value is readonly string[] {
	if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
		throw new ContinuationBriefingError("invalid-input", `${label} must be an array of nonempty strings.`);
	}
}

function formatRef(ref: FileEvidenceRef): string {
	return `${ref.path} (${ref.byteLength} bytes, sha256 ${ref.sha256})`;
}

function nodeErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}
