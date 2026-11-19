import { type } from "@oh-my-pi/omptype";
import type { CanonicalPlanIdentity, FileEvidenceRef } from "./continuation-store";

const text = type("string").matching(/\S/);
const nonnegativeInteger = type("number").divisibleBy(1).atLeast(0).atMost(Number.MAX_SAFE_INTEGER);
const positiveInteger = nonnegativeInteger.atLeast(1);
const hash = type("string").matching(/^[0-9a-f]{64}$/);
const fileEvidence = type({ kind: "'file'", path: text, byteLength: nonnegativeInteger, sha256: hash });
const nullableEvidence = fileEvidence.or("null");
const evidenceList = nullableEvidence.array();
const claim = type({
	kind: "'provider'",
	provider: "'kata'",
	ref: text,
	uid: text.or("null"),
	project: text.or("null"),
	shortId: text.or("null"),
	observedRevision: nonnegativeInteger.or("null"),
	status: "'open' | 'closed' | 'unknown'",
	task: positiveInteger.or("null"),
	labels: text.array(),
	owner: text.or("null"),
	lease: type({
		holder: text.or("null"),
		holderInstanceUid: text.or("null"),
		claimKind: text.or("null"),
		claimUid: text.or("null"),
		revision: nonnegativeInteger.or("null"),
		expiresAt: text.or("null"),
		releasedAt: text.or("null"),
	}).or("null"),
	claimOwner: text.or("null"),
});
const task = type({
	number: positiveInteger,
	title: text,
	state: "'pending' | 'in_progress' | 'review' | 'fix' | 'complete' | 'complete_unlanded' | 'blocked' | 'contradictory'",
	phase: text,
	round: positiveInteger.or("null"),
	nextAction: text.or("null"),
	brief: nullableEvidence.or({
		kind: "'regenerated'",
		task: positiveInteger,
		text: "string",
		byteLength: nonnegativeInteger,
		sha256: hash,
	}),
	report: nullableEvidence,
	reviewPackage: nullableEvidence,
	claim: claim.or("null"),
	commits: { base: text.or("null"), head: text.or("null") },
});

const workProjection = type({
	version: "1",
	plan: { root: text, relativePath: text, sha256: hash },
	workflow: "'sdd' | 'inline'",
	execution: type({ provider: "'kata'", project: text, completion: "'landed' | 'pull_request'" }).or({
		provider: "'session' | 'none'",
		completion: "'landed' | 'pull_request'",
	}),
	revision: nonnegativeInteger,
	constraints: text.array(),
	current: { task: positiveInteger.or("null"), phase: text, round: positiveInteger.or("null"), nextAction: text },
	tasks: task.array(),
	findings: type({
		id: text,
		task: positiveInteger,
		status: "'open' | 'addressed' | 'parked' | 'minor'",
		summary: text,
		evidence: evidenceList,
	}).array(),
	decisions: type({
		id: text,
		task: positiveInteger.or("null"),
		summary: text,
		rationale: text,
		costIfWrong: text.or("null"),
		sourceText: text.or("null"),
		evidence: evidenceList,
	}).array(),
	rejectedApproaches: type({
		id: text,
		task: positiveInteger.or("null"),
		summary: text,
		reason: text,
		evidence: evidenceList,
	}).array(),
	evidence: evidenceList,
	claims: claim.array(),
	todos: type({ id: text, content: text, status: "'pending' | 'in_progress' | 'completed'" }).array().or("null"),
	recovery: {
		eligible: "boolean",
		status: "'eligible' | 'ineligible' | 'unsupported' | 'contradictory' | 'attention'",
		blockers: text.array(),
		capabilities: text.array(),
	},
}).onDeepUndeclaredKey("reject");

export type WorkProjectionV1 = typeof workProjection.infer;

/** Validate the extension boundary without deriving missing workflow facts. */
export function validateWorkProjection(
	value: unknown,
	identity: CanonicalPlanIdentity,
	planSha256: string,
): WorkProjectionV1 {
	const projection = workProjection.assert(value);
	if (
		projection.plan.root !== identity.root ||
		projection.plan.relativePath !== identity.relativePath ||
		projection.plan.sha256 !== planSha256
	) {
		throw new Error("Continuation projection does not match the canonical plan and its current bytes");
	}
	if (
		projection.recovery.eligible !== (projection.recovery.status === "eligible") ||
		(projection.recovery.eligible && projection.recovery.blockers.length > 0)
	) {
		throw new Error("Continuation projection has contradictory recovery eligibility");
	}
	const tasks = new Map(projection.tasks.map(item => [item.number, item]));
	if (
		tasks.size !== projection.tasks.length ||
		(projection.current.task !== null && !tasks.has(projection.current.task))
	) {
		throw new Error("Continuation projection has contradictory task identity");
	}
	for (const finding of projection.findings) {
		const task = tasks.get(finding.task);
		if (!task || (finding.status === "open" && task.state === "complete")) {
			throw new Error(`Continuation projection contradicts finding ${finding.id}`);
		}
	}
	if (
		projection.recovery.eligible &&
		projection.claims.some(item => item.status === "unknown" || item.observedRevision === null)
	) {
		throw new Error("Unknown execution-provider observations cannot authorize continuation");
	}
	return projection;
}

/** Exact byte dependencies only; generated briefs are checked against the plan separately. */
export function workProjectionEvidence(projection: WorkProjectionV1): FileEvidenceRef[] {
	const refs = [...projection.evidence];
	for (const task of projection.tasks) {
		if (task.brief?.kind === "file") refs.push(task.brief);
		refs.push(task.report, task.reviewPackage);
	}
	for (const item of [...projection.findings, ...projection.decisions, ...projection.rejectedApproaches])
		refs.push(...item.evidence);
	const unique = new Map<string, FileEvidenceRef>();
	for (const ref of refs) {
		if (ref) unique.set(`${ref.path}\0${ref.byteLength}\0${ref.sha256}`, ref);
	}
	return [...unique.values()];
}
