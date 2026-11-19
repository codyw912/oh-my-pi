import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import {
	buildContinuationBriefing,
	type ContinuationBriefingInput,
} from "@oh-my-pi/pi-coding-agent/session/continuation-briefing";
import type { ContinuationDestination } from "@oh-my-pi/pi-coding-agent/session/continuation-policy";
import type { FileEvidenceRef } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import type { WorkProjectionV1 } from "@oh-my-pi/pi-coding-agent/session/continuation-work";

const CONSTRAINT = "PROTECTED_CONSTRAINT";
const REJECTED = "REJECTED_APPROACH";
const REJECTED_REASON = "Violates PROTECTED_CONSTRAINT";
const FINDING = "OPEN_FINDING";
const DECISION = "BINDING_DECISION";
const CURRENT_BRIEF = "CURRENT_TASK_BRIEF_TEXT\nAddress OPEN_FINDING on the immutable review base.";
const COMPLETED_BRIEF = "COMPLETED_TASK_BODY_MUST_NOT_APPEAR";
const OBLIGATION = "ROLE_OBLIGATION_REVIEWER";
const INSTRUCTION = "RETAINED_INSTRUCTION_NO_PUBLISH";
const DISCOVERY = "UNKNOWN_FREEFORM_DISCOVERY";
const SOURCE_MESSAGE_ID = "msg_SECRET_SOURCE_ID";
const THINKING_SIGNATURE = "THINKING_SIGNATURE_SECRET";

const DESTINATION: ContinuationDestination = {
	provider: "openai",
	account: "acct-dest",
	model: "scripted-dest-model",
	roles: ["primary"],
	settings: { thinkingLevel: ThinkingLevel.High },
	dataScope: "workspace-fixture",
};

describe("buildContinuationBriefing", () => {
	it("preserves review and fix round continuity", async () => {
		for (const round of [
			{ state: "review" as const, phase: "review", round: 1, nextAction: "NEXT_ACTION_REVIEW_ROUND" },
			{ state: "fix" as const, phase: "fix", round: 2, nextAction: "NEXT_ACTION_FIX_ROUND" },
		]) {
			await withTempRoot(async dir => {
				const { input } = await fixture(dir, {
					state: round.state,
					phase: round.phase,
					round: round.round,
					nextAction: round.nextAction,
				});
				const result = await buildContinuationBriefing(input);
				expect(result.text).toContain(round.phase);
				expect(result.text).toContain(`round ${round.round}`);
				expect(result.text).toContain(round.nextAction);
				expect(result.text).toContain(FINDING);
				expect(result.protectedFacts).toContain(round.phase);
				expect(result.protectedFacts).toContain(`round ${round.round}`);
				expect(result.protectedFacts).toContain(round.nextAction);
				expect(result.protectedFacts).toContain(FINDING);
				for (const fact of result.protectedFacts) expect(result.text).toContain(fact);
				expect(result.byteLength).toBe(Buffer.byteLength(result.text, "utf8"));
			});
		}
	});

	it("does not reissue completed work", async () => {
		await withTempRoot(async dir => {
			const { input, completedBriefText } = await fixture(dir);
			const result = await buildContinuationBriefing(input);
			expect(result.text).toContain("task 1");
			expect(result.text).toContain("Completed work");
			expect(result.text).toContain("must not redispatch");
			expect(result.text).toContain(CURRENT_BRIEF);
			expect(result.text).not.toContain(completedBriefText);
			expect(result.protectedFacts).toContain("task 1");
			expect(result.protectedFacts).toContain("Completed work");
		});
	});

	it("keeps constraints and rejected approaches in protected facts", async () => {
		await withTempRoot(async dir => {
			const { input } = await fixture(dir);
			const result = await buildContinuationBriefing(input);
			expect(result.text).toContain(CONSTRAINT);
			expect(result.text).toContain(REJECTED);
			expect(result.text).toContain(REJECTED_REASON);
			expect(result.text).toContain(DECISION);
			expect(result.text).toContain(INSTRUCTION);
			expect(result.text).toContain(OBLIGATION);
			expect(result.protectedFacts).toContain(CONSTRAINT);
			expect(result.protectedFacts).toContain(REJECTED);
			expect(result.protectedFacts).toContain(REJECTED_REASON);
			expect(result.protectedFacts).toContain(DECISION);
			expect(result.text).toContain("workspace-fixture");
			expect(result.text).not.toContain(DESTINATION.model);
			expect(result.text).not.toContain(SOURCE_MESSAGE_ID);
			expect(result.text).not.toContain(THINKING_SIGNATURE);
			expect(result.text).toContain(DISCOVERY);
			expect(result.text).not.toMatch(new RegExp(`${DISCOVERY}.*complet`, "i"));
			for (const fact of result.protectedFacts) expect(result.text).toContain(fact);
		});
	});

	it("rejects changed evidence", async () => {
		await withTempRoot(async dir => {
			const { input, currentBriefPath } = await fixture(dir, { brief: "file" });
			await fs.writeFile(currentBriefPath, "CHANGED_TASK_BRIEF_TEXT");
			await expect(buildContinuationBriefing(input)).rejects.toMatchObject({
				name: "ContinuationBriefingError",
				code: "changed-evidence",
			});
		});
	});

	it("rejects missing evidence", async () => {
		await withTempRoot(async dir => {
			const { input, currentBriefPath } = await fixture(dir, { brief: "file" });
			await fs.unlink(currentBriefPath);
			await expect(buildContinuationBriefing(input)).rejects.toMatchObject({
				name: "ContinuationBriefingError",
				code: "missing-evidence",
			});
			const absent = await fixture(dir, { brief: "none" });
			await expect(buildContinuationBriefing(absent.input)).rejects.toMatchObject({
				name: "ContinuationBriefingError",
				code: "missing-evidence",
			});
		});
	});

	it("rejects a regenerated brief whose hash does not match its text", async () => {
		await withTempRoot(async dir => {
			const { input } = await fixture(dir, {
				brief: "regenerated",
				regeneratedSha256: "a".repeat(64),
			});
			await expect(buildContinuationBriefing(input)).rejects.toMatchObject({
				name: "ContinuationBriefingError",
				code: "invalid-brief",
			});
		});
	});

	it("refuses an oversize briefing rather than dropping protected facts", async () => {
		await withTempRoot(async dir => {
			const { input } = await fixture(dir);
			const result = await buildContinuationBriefing(input);
			for (const fact of result.protectedFacts) expect(result.text).toContain(fact);
			await expect(buildContinuationBriefing({ ...input, maxBytes: result.byteLength - 1 })).rejects.toMatchObject({
				name: "ContinuationBriefingError",
				code: "oversize",
			});
		});
	});

	it("includes live project service identity without command or env", async () => {
		await withTempRoot(async dir => {
			const { input } = await fixture(dir);
			const result = await buildContinuationBriefing({
				...input,
				services: [
					{
						name: "web",
						id: "daemon-web-1",
						pid: 4242,
						startedAt: 1_700_000_000_000,
						owner: "sess-source",
						persist: true,
						detached: false,
					},
				],
			});
			expect(result.text).toContain("web");
			expect(result.text).toContain("daemon-web-1");
			expect(result.text).toContain("owner sess-source");
			expect(result.protectedFacts).toContain("web");
			expect(result.protectedFacts).toContain("daemon-web-1");
			expect(result.text).not.toContain("--token");
			expect(result.text).not.toContain("SECRET_ENV");
		});
	});
});

async function withTempRoot<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "continuation-briefing-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

async function writeRef(root: string, relative: string, content: string): Promise<FileEvidenceRef> {
	const filePath = path.join(root, relative);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const bytes = Buffer.from(content, "utf8");
	await fs.writeFile(filePath, bytes);
	return {
		kind: "file",
		path: await fs.realpath(filePath),
		byteLength: bytes.byteLength,
		sha256: sha256Hex(bytes),
	};
}

function sha256Hex(data: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

async function fixture(
	dir: string,
	options: {
		state?: WorkProjectionV1["tasks"][number]["state"];
		phase?: string;
		round?: number | null;
		nextAction?: string;
		brief?: "file" | "regenerated" | "none";
		regeneratedSha256?: string;
	} = {},
): Promise<{
	input: ContinuationBriefingInput;
	currentBriefText: string;
	completedBriefText: string;
	currentBriefPath: string;
}> {
	const root = await fs.realpath(dir);
	const plan = "# Continuation briefing fixture\n";
	await fs.writeFile(path.join(root, "plan.md"), plan);
	const transcript = await writeRef(
		root,
		"source.jsonl",
		JSON.stringify({ providerMessageId: SOURCE_MESSAGE_ID, thinkingSignature: THINKING_SIGNATURE }),
	);
	const currentBrief = await writeRef(root, "task-2-brief.md", CURRENT_BRIEF);
	const completedBrief = await writeRef(root, "task-1-brief.md", COMPLETED_BRIEF);
	const reviewPackage = await writeRef(root, "task-2-review.json", `{"finding":"${FINDING}"}`);
	const discoveryEvidence = await writeRef(root, "discovery.txt", DISCOVERY);
	const phase = options.phase ?? "fix";
	const round = options.round === undefined ? 2 : options.round;
	const nextAction = options.nextAction ?? "NEXT_ACTION_FIX_ROUND";
	const state = options.state ?? "fix";
	const briefKind = options.brief ?? "file";
	const regeneratedText = CURRENT_BRIEF;
	const currentTaskBrief =
		briefKind === "none"
			? null
			: briefKind === "regenerated"
				? {
						kind: "regenerated" as const,
						task: 2,
						text: regeneratedText,
						byteLength: Buffer.byteLength(regeneratedText, "utf8"),
						sha256: options.regeneratedSha256 ?? sha256Hex(regeneratedText),
					}
				: currentBrief;
	const projection: WorkProjectionV1 = {
		version: 1,
		plan: { root, relativePath: "plan.md", sha256: sha256Hex(plan) },
		workflow: "sdd",
		execution: { provider: "session", completion: "landed" },
		revision: 1,
		constraints: [CONSTRAINT],
		current: { task: 2, phase, round, nextAction },
		tasks: [
			{
				number: 1,
				title: "Completed work",
				state: "complete",
				phase: "complete",
				round: null,
				nextAction: null,
				brief: completedBrief,
				report: null,
				reviewPackage: null,
				claim: null,
				commits: { base: null, head: null },
			},
			{
				number: 2,
				title: "Fix findings",
				state,
				phase,
				round,
				nextAction,
				brief: currentTaskBrief,
				report: null,
				reviewPackage,
				claim: null,
				commits: { base: "review-base", head: "worktree" },
			},
		],
		findings: [{ id: "finding", task: 2, status: "open", summary: FINDING, evidence: [] }],
		decisions: [
			{
				id: "decision",
				task: 2,
				summary: DECISION,
				rationale: "Keep the review base",
				costIfWrong: null,
				sourceText: null,
				evidence: [],
			},
		],
		rejectedApproaches: [{ id: "rejected", task: 2, summary: REJECTED, reason: REJECTED_REASON, evidence: [] }],
		evidence: [],
		claims: [],
		todos: [
			{ id: "done", content: "Completed work", status: "completed" },
			{ id: "fix", content: nextAction, status: "in_progress" },
		],
		recovery: { eligible: true, status: "eligible", blockers: [], capabilities: ["fresh-handoff"] },
	};
	return {
		input: {
			projection,
			runId: "run-briefing",
			generation: 3,
			sourceSessionId: "sess-source",
			sourceTranscript: transcript,
			policyRevision: "policy-rev-1",
			destination: DESTINATION,
			roleObligations: [OBLIGATION],
			retainedInstructions: [INSTRUCTION],
			discoveries: [{ summary: DISCOVERY, evidence: [discoveryEvidence] }],
			services: [],
			maxBytes: 64_000,
		},
		currentBriefText: CURRENT_BRIEF,
		completedBriefText: COMPLETED_BRIEF,
		currentBriefPath: currentBrief.path,
	};
}
