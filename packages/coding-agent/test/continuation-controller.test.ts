import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { openContinuationRun } from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import type { ContinuationHandoffInputs } from "@oh-my-pi/pi-coding-agent/session/continuation-handoff";
import { bindContinuationStream, registerContinuationTransport } from "../src/session/continuation-request";
import {
	checkpointPath,
	createNodeDurableIo,
	inspectCommittedRunState,
} from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { continuationTestHarness } from "./helpers/continuation-fixture";
import { makeAssistantMessage } from "./session-manager/helpers";

const { model, fixture, extraSession, trackJob, trackRun, cleanup } = continuationTestHarness();

function handoffInputs(): ContinuationHandoffInputs {
	return {
		model,
		context: { messages: [] },
		retainedInstructions: ["Do not repeat completed work."],
		roleObligations: ["Finish the review."],
		discoveries: [],
		queuedMessages: [],
		draft: null,
		services: [],
		maxBriefingBytes: 256_000,
	};
}

afterEach(cleanup);

describe("durable continuation controller", () => {
	it("records actual intent before a tool effect and stops a prepared sibling after publication failure", async () => {
		const realIo = createNodeDurableIo();
		let failStateRename = false;
		const f = await fixture({
			...realIo,
			async rename(from, to) {
				if (failStateRename && path.basename(to) === "state.json")
					throw new Error("injected state publication failure");
				await realIo.rename(from, to);
			},
		});
		const calls: string[] = [];
		const makeTool = (name: string): AgentTool => ({
			name,
			label: name,
			description: name,
			parameters: type({}),
			concurrency: "exclusive",
			execute: async () => {
				const state = (await inspectCommittedRunState({ worktree: f.root, planPath: "plan.md" })).state;
				expect(state.pendingEffects.some(effect => effect.kind === "tool")).toBe(true);
				calls.push(name);
				await fs.writeFile(path.join(f.root, "actual-effect.txt"), "KNOWN_COMPLETED_EFFECT");
				failStateRename = true;
				return { content: [{ type: "text", text: "KNOWN_COMPLETED_EFFECT" }], details: { effect: name } };
			},
		});
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Fixture"],
				tools: [makeTool("first"), makeTool("second")],
				messages: [
					{
						...makeAssistantMessage(),
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "toolUse",
						content: [
							{ type: "toolCall", id: "first-call", name: "first", arguments: {} },
							{ type: "toolCall", id: "second-call", name: "second", arguments: {} },
						],
					},
				],
			},
			toolExecutionBoundary: f.binding.toolBoundary,
			streamFn: async () => {
				throw new Error("No model call belongs in this failed tool batch");
			},
		});
		await expect(agent.continue()).rejects.toThrow("injected state publication failure");
		expect(calls).toEqual(["first"]);
		const inspected = await inspectCommittedRunState({ worktree: f.root, planPath: "plan.md" });
		const effect = inspected.state.pendingEffects.find(item => item.kind === "tool");
		if (!effect) throw new Error("The unacknowledged effect must remain pending");
		const result = JSON.parse(
			await fs.readFile(
				checkpointPath(inspected.controlDir, inspected.state.run.id, `effect-result-${effect.id}`),
				"utf8",
			),
		);
		expect(result.result.returnedResult.content).toEqual([{ type: "text", text: "KNOWN_COMPLETED_EFFECT" }]);
		expect(await fs.readFile(path.join(f.root, "actual-effect.txt"), "utf8")).toBe("KNOWN_COMPLETED_EFFECT");
	});

	it("keeps a settled job available until its durable acceptance succeeds", async () => {
		const f = await fixture();
		const manager = trackJob(new AsyncJobManager({ onJobComplete: () => {} }));
		const ownerId = f.manager.getSessionId();
		manager.registerJobAdmission(ownerId, f.binding.admitJob);
		manager.registerDeliveryAcceptance(ownerId, f.binding.acceptDeliveries);
		const jobId = manager.register(
			"bash",
			"durable-job",
			async () => {
				const state = (await inspectCommittedRunState({ worktree: f.root, planPath: "plan.md" })).state;
				expect(state.accounting.workers.some(worker => worker.status === "live")).toBe(true);
				return "UNFINISHED_REVIEW_RESULT";
			},
			{ ownerId },
		);
		await manager.waitForOwnerJobs(ownerId);
		await manager.consumeJobResults([jobId]);
		expect(manager.isJobResultConsumed(jobId)).toBe(true);
		const state = (await inspectCommittedRunState({ worktree: f.root, planPath: "plan.md" })).state;
		expect(state.pendingEffects).toEqual([]);
		expect(state.accounting.workers.every(worker => worker.status === "settled")).toBe(true);
	});

	it("pauses before dispatch and permits explicit resume without replacing the stream wrapper", async () => {
		const f = await fixture();
		let dispatches = 0;
		const failBeforeHttp = registerContinuationTransport(async () => {
			dispatches++;
			throw new Error("fixture encoding failed before HTTP");
		});
		const stream = bindContinuationStream(failBeforeHttp, f.binding.requestBoundary, "primary");
		await f.run.setIntent({ kind: "pause", reason: "operator pause" });
		await expect(stream(model, { messages: [] }, {})).rejects.toThrow("operator pause");
		expect(dispatches).toBe(0);
		await f.run.setIntent({ kind: "continue" });
		await expect(stream(model, { messages: [] }, {})).rejects.toThrow("fixture encoding failed before HTTP");
		expect(dispatches).toBe(1);
	});

	it("permits a narrower output cap without allowing larger output or unrelated setting changes", async () => {
		const f = await fixture();
		let dispatches = 0;
		const failBeforeHttp = registerContinuationTransport(async () => {
			dispatches++;
			throw new Error("fixture encoding failed before HTTP");
		});
		const stream = bindContinuationStream(failBeforeHttp, f.binding.requestBoundary, "primary");
		await expect(stream(model, { messages: [] }, { maxTokens: 128 })).rejects.toThrow(
			"fixture encoding failed before HTTP",
		);
		expect(dispatches).toBe(1);
		const authorizedMaxTokens = model.maxTokens;
		if (authorizedMaxTokens === null) throw new Error("fixture model must declare maxTokens");
		await expect(stream(model, { messages: [] }, { maxTokens: authorizedMaxTokens + 1 })).rejects.toThrow(
			"Request output limit is not authorized",
		);
		await expect(stream(model, { messages: [] }, { maxTokens: 128, temperature: 0.7 })).rejects.toThrow(
			"Required settings are not exactly authorized",
		);
		expect(dispatches).toBe(1);
	});

	it("blocks an exhausted account before provider retry wait and preserves it across relaunch", async () => {
		const f = await fixture();
		const receipt = await f.binding.requestBoundary.admit({
			role: "primary",
			model,
			context: { messages: [] },
			options: {},
		});
		const http = await receipt.admitHttp(`${model.baseUrl}/v1/messages`, { body: "{}" });
		await http.received(
			new Response('{"error":{"type":"insufficient_quota","message":"Usage limit reached"}}', { status: 429 }),
		);
		await expect(receipt.beforeRetryWait()).rejects.toThrow("allowance limit");
		await receipt.settle({
			kind: "returned",
			message: {
				...makeAssistantMessage(),
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "error",
				errorMessage: "Usage limit reached",
			},
		});
		expect((await f.binding.beforeRecovery()).kind).toBe("handoff-required");
		const runId = f.run.getState().run.id;
		await f.run.close();
		const recovered = trackRun(await openContinuationRun({ ...f.options, recoverRunId: runId }));
		expect((await recovered.bindSession(f.manager, "primary").beforeRecovery()).kind).toBe("handoff-required");
	});

	it("does not convert a dispatched request with unknown outcome into replay permission", async () => {
		const f = await fixture();
		const receipt = await f.binding.requestBoundary.admit({
			role: "primary",
			model,
			context: { messages: [] },
			options: {},
		});
		const http = await receipt.admitHttp(`${model.baseUrl}/v1/messages`, { body: "{}" });
		await http.failed(new Error("connection lost after send"), true);
		await receipt.settle({ kind: "threw", error: new Error("unknown response") });
		expect((await f.binding.beforeRecovery()).kind).toBe("stop");
		expect(f.run.getState().pendingEffects.some(effect => effect.kind === "http")).toBe(true);
	});

	it("recovers a pre-commit staged handoff without authorizing it under the relaunched generation", async () => {
		const f = await fixture();
		const inputs = handoffInputs();
		const source = f.run.getState().owner;
		const handoff = f.binding.handoff!;
		const ticket = await handoff.begin();
		const prepared = await handoff.prepare(ticket, inputs);
		expect(f.run.getState().pendingHandoff?.phase).toBe("staged");
		const runId = f.run.getState().run.id;
		await f.run.close();
		const recovered = trackRun(await openContinuationRun({ ...f.options, recoverRunId: runId }));
		expect(recovered.getState().owner.sessionId).toBe(source.sessionId);
		expect(recovered.getState().owner.sessionFile).toBe(source.sessionFile);
		expect(recovered.getState().pendingHandoff).toBeNull();
		expect(recovered.getState().owner.generation).toBeGreaterThan(source.generation);
		const recoveredBinding = recovered.bindSession(f.manager, "primary");
		expect((await recoveredBinding.beforeRecovery()).kind).toBe("allow");
		await expect(recoveredBinding.handoff!.commit(prepared, inputs)).rejects.toThrow();
		expect(recovered.getState().owner.sessionId).toBe(source.sessionId);
		const next = await recoveredBinding.handoff!.begin();
		expect(next.id).not.toBe(ticket.id);
		expect(next.sourceGeneration).toBe(recovered.getState().owner.generation);
	});

	it("refuses a stale session from minting a current-generation child", async () => {
		const f = await fixture();
		const stray = await extraSession(f, "fixture-account");
		expect(() => f.run.bindSession(stray, "worker")).toThrow(
			"Direct continuation binding is limited to the committed owner session",
		);
		const child = f.binding.factory.bindSession(stray, "worker");
		expect((await child.beforeRecovery()).kind).toBe("allow");
		const inputs = handoffInputs();
		const prepared = await f.binding.handoff!.prepare(await f.binding.handoff!.begin(), inputs);
		f.accountsBySession.set(prepared.session.sessionId, f.policy.candidates[0]!.account);
		await f.binding.handoff!.commit(prepared, inputs);
		expect(() => f.run.bindSession(f.manager, "worker")).toThrow(
			"Direct continuation binding is limited to the committed owner session",
		);
		expect(() => f.run.bindSession(stray, "worker")).toThrow(
			"Direct continuation binding is limited to the committed owner session",
		);
		expect((await child.beforeRecovery()).kind).toBe("stop");
	});

	it("routes a known successor rejection to the remaining approved candidate", async () => {
		const f = await fixture(undefined, ["fixture-account", "alternate-account"]);
		const inputs = handoffInputs();
		const prepared = await f.binding.handoff!.prepare(await f.binding.handoff!.begin(), inputs);
		const activated = await f.binding.handoff!.commit(prepared, inputs);
		expect(f.run.getState().owner.sessionId).toBe(activated.sessionId);
		const successor = await SessionManager.open(activated.sessionFile);
		try {
			const successorBinding = f.run.bindSession(successor, "primary");
			const receipt = await successorBinding.requestBoundary.admit({
				role: "primary",
				model,
				context: { messages: [] },
				options: {},
			});
			const http = await receipt.admitHttp(`${model.baseUrl}/v1/messages`, { body: "{}" });
			await http.received(new Response("internal error", { status: 500 }));
			await receipt.settle({
				kind: "returned",
				message: {
					...makeAssistantMessage(),
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "error",
					errorMessage: "internal error",
				},
			});
			const outcome = await successorBinding.beforeRecovery();
			expect(outcome.kind).toBe("handoff-required");
			if (outcome.kind === "handoff-required") {
				expect(outcome.reason).toContain("another approved candidate remains");
			}
			expect(f.run.getState().owner.sessionId).toBe(activated.sessionId);
			expect(f.run.getState().pendingEffects).toEqual([]);
			const candidates = await successorBinding.handoff!.candidates();
			expect(candidates).toHaveLength(1);
			expect(candidates[0]?.account).toBe("alternate-account");
		} finally {
			await successor.close();
		}
	});
});
