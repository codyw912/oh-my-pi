import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { openContinuationRun, type ContinuationRun } from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import type { ContinuationHandoffInputs } from "@oh-my-pi/pi-coding-agent/session/continuation-handoff";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { continuationModel } from "./helpers/continuation-fixture";
import { evidenceDir, requireWorkflowSource, writeCaseEvidence } from "./fixtures/continuation/portable-session";
import {
	runCrossProviderCase,
	type CrossProviderWorkflowBindings,
	type CrossProviderWorkflowContext,
} from "./fixtures/continuation/cross-provider-session";
import {
	createKataWorkflowFixture,
	exerciseKataWorkflowConformance,
	KATA_ACTOR,
	type KataWorkflowFixture,
	VERIFICATION_BASE,
} from "./fixtures/continuation/kata-workflow";

async function setupKataWorkflow(context: CrossProviderWorkflowContext): Promise<CrossProviderWorkflowBindings> {
	const fixture = await createKataWorkflowFixture(context.root, context.workflowSource, { deferResult: true });
	return {
		planPath: fixture.planAbsolutePath,
		workflow: fixture.workflow,
		publishSnapshot: fixture.publishResult,
		findings: ["OPEN_FINDING missing progress reporting", "CONSTRAINT_LEAK against PROTECTED_CONSTRAINT"],
		rejectedApproach: "REJECTED_APPROACH rewrite from scratch",
		rejectedReason: "loses the reviewed Task 1 interface and the immutable verification base",
		nextAction: "resume fix round 1 for task 2",
		protectedConstraint: "PROTECTED_CONSTRAINT",
		discoveryRef: fixture.report.task2Report,
		cleanup: fixture.cleanup,
		verify: async () => {
			const projection = await fixture.exportProjection();
			expect(projection.tasks.find(task => task.number === 1)?.state).toBe("complete_unlanded");
			expect(projection.current).toMatchObject({ task: 2, phase: "fix", round: 1 });
			expect(projection.tasks.find(task => task.number === 2)?.commits?.base).toBe(VERIFICATION_BASE);
			expect(projection.tasks.find(task => task.number === 3)?.state).toBe("pending");
			const conformance = await exerciseKataWorkflowConformance(fixture);
			expect(conformance.unsupported).toEqual([]);
			expect(conformance.actor).toBe(KATA_ACTOR);
			return conformance;
		},
	};
}

it("PT-01 E1 preserves real Kata review and claims across Anthropic to Responses", async () => {
	await runCrossProviderCase({
		caseId: "E1",
		direction: "anthropic-to-openai-responses",
		interleaving: "result-first",
		workflowKind: "sdd-kata",
		handoff: "manual",
		setupWorkflow: setupKataWorkflow,
	});
}, 30_000);

it("PT-01 E3 preserves real Kata review and claims across Responses to Anthropic", async () => {
	await runCrossProviderCase({
		caseId: "E3",
		direction: "openai-responses-to-anthropic",
		interleaving: "instruction-first",
		workflowKind: "sdd-kata",
		handoff: "manual",
		setupWorkflow: setupKataWorkflow,
	});
}, 30_000);

it("PT-01 F7 rejects a staged continuation after native Kata lease renewal", async () => {
	const dir = TempDir.createSync("pt01-f7-kata");
	const root = await fs.realpath(dir.path());
	let fixture: KataWorkflowFixture | undefined;
	let manager: SessionManager | undefined;
	let run: ContinuationRun | undefined;
	const evidence: Record<string, unknown> = { case: "F7", workflow: "sdd-kata", result: "incomplete" };
	let requests = 0;
	const endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests++;
			return new Response("Stale work must not reach this endpoint", { status: 503 });
		},
	});
	const model = { ...continuationModel, baseUrl: endpoint.url.origin };
	try {
		fixture = await createKataWorkflowFixture(root, requireWorkflowSource());
		manager = SessionManager.create(root, path.join(root, "sessions"));
		manager.appendMessage({
			role: "user",
			content: "Continue the pending review without forcing a Kata claim.",
			timestamp: 1,
		});
		const destination = {
			provider: model.provider,
			account: "fixture-account",
			model: model.id,
			endpoint: model.baseUrl,
			roles: ["primary" as const],
			settings: {},
			dataScope: "fixture",
		};
		run = await openContinuationRun({
			sessionManager: manager,
			planPath: fixture.planPath,
			workflow: fixture.workflow,
			source: destination,
			policy: {
				version: 1,
				revision: "f7-kata",
				roles: ["primary"],
				dataScope: "fixture",
				candidates: [destination],
				unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
				attemptBudget: 1,
				restrictedAccounts: [],
			},
			observeRequest: async request => ({
				account: destination.account,
				dataScope: destination.dataScope,
				contextTokens: Buffer.byteLength(JSON.stringify(request.context)),
				allowances: [
					{ provider: destination.provider, account: destination.account, window: "fixture", headroom: "healthy" },
				],
			}),
		});
		const owner = run.getState().owner;
		const handoff = run.bindSession(manager, "primary").handoff!;
		const inputs: ContinuationHandoffInputs = {
			model,
			context: { messages: [] },
			retainedInstructions: ["Do not force a Kata claim."],
			roleObligations: ["Finish the pending review."],
			discoveries: [],
			queuedMessages: [],
			draft: null,
			services: [],
			maxBriefingBytes: 256_000,
		};
		const ticket = await handoff.begin(destination);
		const prepared = await handoff.prepare(ticket, inputs);
		evidence.before = await fixture.exportProjection();
		evidence.mutation = await fixture.mutateClaimRevision(2);
		evidence.after = await fixture.exportProjection();
		await expect(handoff.commit(prepared, inputs)).rejects.toThrow("Workflow revision changed during preparation");
		expect(run.getState().owner).toEqual(owner);
		expect(requests).toBe(0);
		evidence.owner = run.getState().owner;
		evidence.stagedSession = prepared.session.sessionId;
		evidence.result = "stale-claim-rejected";
	} catch (error) {
		evidence.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		await run?.close();
		await manager?.close();
		await fixture?.cleanup();
		await endpoint.stop(true);
		evidence.requests = requests;
		const retained = evidenceDir();
		if (retained) await fs.cp(root, path.join(retained, "pt01-f7-kata-artifacts"), { recursive: true });
		await writeCaseEvidence("pt01-f7-kata", evidence);
		dir.remove();
	}
}, 30_000);

it("rejects admission after a foreign actor wins the native Kata lease", async () => {
	const dir = TempDir.createSync("pt01-kata-claim-loss");
	const root = await fs.realpath(dir.path());
	let fixture: KataWorkflowFixture | undefined;
	let manager: SessionManager | undefined;
	let run: ContinuationRun | undefined;
	const evidence: Record<string, unknown> = { case: "claim-authority", workflow: "sdd-kata", result: "incomplete" };
	let requests = 0;
	const endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests++;
			return new Response("Unauthorized claim must not reach this endpoint", { status: 503 });
		},
	});
	const model = { ...continuationModel, baseUrl: endpoint.url.origin };
	try {
		fixture = await createKataWorkflowFixture(root, requireWorkflowSource());
		manager = SessionManager.create(root, path.join(root, "sessions"));
		manager.appendMessage({
			role: "user",
			content: "Continue the pending review without forcing a Kata claim.",
			timestamp: 1,
		});
		const destination = {
			provider: model.provider,
			account: "fixture-account",
			model: model.id,
			endpoint: model.baseUrl,
			roles: ["primary" as const],
			settings: {},
			dataScope: "fixture",
		};
		run = await openContinuationRun({
			sessionManager: manager,
			planPath: fixture.planPath,
			workflow: fixture.workflow,
			source: destination,
			policy: {
				version: 1,
				revision: "claim-authority-kata",
				roles: ["primary"],
				dataScope: "fixture",
				candidates: [destination],
				unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
				attemptBudget: 1,
				restrictedAccounts: [],
			},
			observeRequest: async request => ({
				account: destination.account,
				dataScope: destination.dataScope,
				contextTokens: Buffer.byteLength(JSON.stringify(request.context)),
				allowances: [
					{ provider: destination.provider, account: destination.account, window: "fixture", headroom: "healthy" },
				],
			}),
		});
		const owner = run.getState().owner;
		const handoff = run.bindSession(manager, "primary").handoff!;
		const inputs: ContinuationHandoffInputs = {
			model,
			context: { messages: [] },
			retainedInstructions: ["Do not force a Kata claim."],
			roleObligations: ["Finish the pending review."],
			discoveries: [],
			queuedMessages: [],
			draft: null,
			services: [],
			maxBriefingBytes: 256_000,
		};
		const ticket = await handoff.begin(destination);
		const prepared = await handoff.prepare(ticket, inputs);
		evidence.before = await fixture.exportProjection();
		evidence.mutation = await fixture.transferClaimToForeign(2);
		const after = await fixture.exportProjection();
		evidence.after = after;
		expect(after.recovery.eligible).toBe(false);
		expect(
			after.recovery.blockers.some(
				item => item.startsWith("kata-lease-foreign:") || item.startsWith("kata-lease-replaced:"),
			),
		).toBe(true);
		await expect(handoff.commit(prepared, inputs)).rejects.toThrow();
		expect(run.getState().owner).toEqual(owner);
		expect(requests).toBe(0);
		evidence.reconcile = await fixture.recordAuthorizedLiveClaims();
		const recovered = await fixture.exportProjection();
		evidence.recovered = recovered;
		expect(recovered.recovery.status).toBe("eligible");
		evidence.owner = run.getState().owner;
		evidence.stagedSession = prepared.session.sessionId;
		evidence.result = "foreign-claim-rejected-then-authorized";
	} catch (error) {
		evidence.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		await run?.close();
		await manager?.close();
		await fixture?.cleanup();
		await endpoint.stop(true);
		evidence.requests = requests;
		const retained = evidenceDir();
		if (retained) await fs.cp(root, path.join(retained, "pt01-kata-claim-loss-artifacts"), { recursive: true });
		await writeCaseEvidence("pt01-kata-claim-loss", evidence);
		dir.remove();
	}
}, 30_000);

it("blocks admission when a native Kata child is closed with unfinished review", async () => {
	const dir = TempDir.createSync("pt01-kata-closed-review");
	const root = await fs.realpath(dir.path());
	let fixture: KataWorkflowFixture | undefined;
	let manager: SessionManager | undefined;
	let run: ContinuationRun | undefined;
	const evidence: Record<string, unknown> = {
		case: "closed-unfinished-review",
		workflow: "sdd-kata",
		result: "incomplete",
	};
	let requests = 0;
	const endpoint = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			requests++;
			return new Response("Contradictory review must not reach this endpoint", { status: 503 });
		},
	});
	const model = { ...continuationModel, baseUrl: endpoint.url.origin };
	try {
		fixture = await createKataWorkflowFixture(root, requireWorkflowSource());
		manager = SessionManager.create(root, path.join(root, "sessions"));
		manager.appendMessage({
			role: "user",
			content: "Continue the pending review without forcing a Kata claim.",
			timestamp: 1,
		});
		const destination = {
			provider: model.provider,
			account: "fixture-account",
			model: model.id,
			endpoint: model.baseUrl,
			roles: ["primary" as const],
			settings: {},
			dataScope: "fixture",
		};
		run = await openContinuationRun({
			sessionManager: manager,
			planPath: fixture.planPath,
			workflow: fixture.workflow,
			source: destination,
			policy: {
				version: 1,
				revision: "closed-review-kata",
				roles: ["primary"],
				dataScope: "fixture",
				candidates: [destination],
				unknownHeadroom: { allowFirstUsefulRequest: false, maxFirstUsefulRequests: 0 },
				attemptBudget: 1,
				restrictedAccounts: [],
			},
			observeRequest: async request => ({
				account: destination.account,
				dataScope: destination.dataScope,
				contextTokens: Buffer.byteLength(JSON.stringify(request.context)),
				allowances: [
					{ provider: destination.provider, account: destination.account, window: "fixture", headroom: "healthy" },
				],
			}),
		});
		const owner = run.getState().owner;
		const handoff = run.bindSession(manager, "primary").handoff!;
		const inputs: ContinuationHandoffInputs = {
			model,
			context: { messages: [] },
			retainedInstructions: ["Do not force a Kata claim."],
			roleObligations: ["Finish the pending review."],
			discoveries: [],
			queuedMessages: [],
			draft: null,
			services: [],
			maxBriefingBytes: 256_000,
		};
		const ticket = await handoff.begin(destination);
		const prepared = await handoff.prepare(ticket, inputs);
		evidence.before = await fixture.exportProjection();
		evidence.mutation = await fixture.closeChildWithEvidence(2);
		const after = await fixture.exportProjection();
		evidence.after = after;
		expect(after.recovery.status).toBe("contradictory");
		expect(after.recovery.eligible).toBe(false);
		expect(after.recovery.blockers.some(item => item.startsWith("closed-child-unfinished-review:"))).toBe(true);
		expect(after.tasks.find(task => task.number === 2)?.state).toBe("contradictory");
		await expect(handoff.commit(prepared, inputs)).rejects.toThrow();
		expect(run.getState().owner).toEqual(owner);
		expect(requests).toBe(0);
		evidence.owner = run.getState().owner;
		evidence.stagedSession = prepared.session.sessionId;
		evidence.result = "closed-unfinished-review-blocked";
	} catch (error) {
		evidence.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		await run?.close();
		await manager?.close();
		await fixture?.cleanup();
		await endpoint.stop(true);
		evidence.requests = requests;
		const retained = evidenceDir();
		if (retained) await fs.cp(root, path.join(retained, "pt01-kata-closed-review-artifacts"), { recursive: true });
		await writeCaseEvidence("pt01-kata-closed-review", evidence);
		dir.remove();
	}
}, 30_000);
