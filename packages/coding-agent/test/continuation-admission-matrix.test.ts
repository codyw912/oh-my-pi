import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ContinuationSessionBinding } from "@oh-my-pi/pi-coding-agent/session/continuation-binding";
import { openContinuationRun } from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import { bindContinuationStream, registerContinuationTransport } from "../src/session/continuation-request";
import { createNodeDurableIo, inspectCommittedRunState } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { continuationTestHarness } from "./helpers/continuation-fixture";
import { makeAssistantMessage } from "./session-manager/helpers";

const { model, fixture, extraSession, trackJob, trackRun, cleanup } = continuationTestHarness();

afterEach(cleanup);

async function exhaustPrimary(binding: ContinuationSessionBinding) {
	const receipt = await binding.requestBoundary.admit({
		role: "primary",
		model,
		context: { messages: [] },
		options: {},
	});
	const http = await receipt.admitHttp(`${model.baseUrl}/v1/messages`, { body: "{}" });
	await http.received(
		new Response('{"error":{"type":"insufficient_quota","message":"Usage limit reached"}}', { status: 429 }),
	);
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
}

function countingStream(binding: ContinuationSessionBinding, role: "primary" | "worker", label: string) {
	let dispatches = 0;
	const stream = bindContinuationStream(
		registerContinuationTransport(async () => {
			dispatches++;
			throw new Error(label);
		}),
		binding.requestBoundary,
		role,
	);
	return { stream, dispatches: () => dispatches };
}

describe("continuation admission matrix", () => {
	it("denies an exhausted source before the stream callback", async () => {
		const f = await fixture();
		await exhaustPrimary(f.binding);
		const counted = countingStream(f.binding, "primary", "exhausted source must not dispatch");
		await expect(
			counted.stream(
				model,
				{ messages: [] },
				{
					fetch: async () => {
						throw new Error("HTTP must not run for an exhausted source");
					},
				},
			),
		).rejects.toThrow("allowance limit");
		expect(counted.dispatches()).toBe(0);
	});

	it("denies a newly bound same-account alias before the stream callback", async () => {
		const f = await fixture();
		await exhaustPrimary(f.binding);
		const alias = await extraSession(f, "fixture-account");
		const counted = countingStream(
			f.binding.factory.bindSession(alias, "worker"),
			"worker",
			"same-account alias must not dispatch",
		);
		await expect(
			counted.stream(
				model,
				{ messages: [] },
				{
					fetch: async () => {
						throw new Error("HTTP must not run for a same-account alias");
					},
				},
			),
		).rejects.toThrow("allowance limit");
		expect(counted.dispatches()).toBe(0);
	});

	it("keeps an alternate approved account admissible before and after explicit relaunch", async () => {
		const f = await fixture(undefined, ["fixture-account", "alternate-account"]);
		await exhaustPrimary(f.binding);
		const alternate = await extraSession(f, "alternate-account");
		const before = countingStream(
			f.binding.factory.bindSession(alternate, "worker"),
			"worker",
			"alternate encoding failed before HTTP",
		);
		await expect(before.stream(model, { messages: [] }, {})).rejects.toThrow("alternate encoding failed before HTTP");
		expect(before.dispatches()).toBe(1);
		const runId = f.run.getState().run.id;
		await f.run.close();
		const recovered = trackRun(await openContinuationRun({ ...f.options, recoverRunId: runId }));
		const after = countingStream(
			recovered.bindSession(f.manager, "primary").factory.bindSession(alternate, "worker"),
			"worker",
			"relaunch alternate encoding failed before HTTP",
		);
		await expect(after.stream(model, { messages: [] }, {})).rejects.toThrow(
			"relaunch alternate encoding failed before HTTP",
		);
		expect(after.dispatches()).toBe(1);
	});

	it("leaves a rejected durable worker result available and blocks dependent admission", async () => {
		const realIo = createNodeDurableIo();
		let failAcceptance = false;
		const f = await fixture({
			...realIo,
			async rename(from, to) {
				if (failAcceptance && path.basename(to) === "state.json")
					throw new Error("injected acceptance publication failure");
				await realIo.rename(from, to);
			},
		});
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
		failAcceptance = true;
		await expect(manager.consumeJobResults([jobId])).rejects.toThrow("injected acceptance publication failure");
		expect(manager.isJobResultConsumed(jobId)).toBe(false);
		expect(manager.getJob(jobId)?.resultText).toBe("UNFINISHED_REVIEW_RESULT");
		const counted = countingStream(f.binding, "primary", "dependent stream must not dispatch");
		await expect(
			counted.stream(
				model,
				{ messages: [] },
				{
					fetch: async () => {
						throw new Error("HTTP must not run after rejected worker acceptance");
					},
				},
			),
		).rejects.toThrow();
		expect(counted.dispatches()).toBe(0);
		let launched = 0;
		manager.register(
			"bash",
			"dependent-job",
			async () => {
				launched += 1;
				return "must not run";
			},
			{ ownerId },
		);
		await manager.waitForOwnerJobs(ownerId);
		expect(launched).toBe(0);
	});

	it("does not execute a tool whose arguments change while durable admission awaits I/O", async () => {
		const realIo = createNodeDurableIo();
		let liveArgs: Record<string, unknown> | undefined;
		const f = await fixture({
			...realIo,
			async writeFileExclusive(filePath, data, options) {
				if (liveArgs && path.basename(filePath).startsWith("event-effect-intent-")) {
					liveArgs.value = "mutated-during-admission";
				}
				await realIo.writeFileExclusive(filePath, data, options);
			},
		});
		const executed: string[] = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema> = {
			name: "revise",
			label: "revise",
			description: "revise",
			parameters: toolSchema,
			execute: async (_id, params) => {
				executed.push(params.value);
				await fs.writeFile(path.join(f.root, "stale-intent.txt"), "STALE_INTENT_EXECUTED");
				return { content: [{ type: "text", text: "executed" }] };
			},
		};
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Fixture"],
				tools: [tool],
				messages: [
					{
						...makeAssistantMessage(),
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "toolUse",
						content: [{ type: "toolCall", id: "revise-call", name: "revise", arguments: { value: "original" } }],
					},
				],
			},
			beforeToolCall: async ({ args }) => {
				liveArgs = args;
			},
			toolExecutionBoundary: f.binding.toolBoundary,
			streamFn: async () => {
				throw new Error("No model call belongs in this argument-revision batch");
			},
		});
		await expect(agent.continue()).rejects.toThrow("Tool arguments changed during durable admission");
		expect(executed).toEqual([]);
		await expect(fs.readFile(path.join(f.root, "stale-intent.txt"), "utf8")).rejects.toThrow();
		const state = (await inspectCommittedRunState({ worktree: f.root, planPath: "plan.md" })).state;
		expect(state.pendingEffects.some(effect => effect.kind === "tool")).toBe(false);
	});

	it("does not dispatch callbacks or HTTP for unsupported or unrepresentable request settings", async () => {
		const f = await fixture();
		const unrepresentable = countingStream(f.binding, "primary", "unrepresentable settings must not dispatch");
		await expect(
			unrepresentable.stream(
				model,
				{ messages: [] },
				{
					topP: 0.5,
					fetch: async () => {
						throw new Error("HTTP must not run for unrepresentable settings");
					},
				},
			),
		).rejects.toThrow("not representable");
		expect(unrepresentable.dispatches()).toBe(0);

		const unsupported = countingStream(f.binding, "primary", "unsupported transport must not dispatch");
		await expect(
			unsupported.stream(
				{ ...model, transport: "pi-native" as const },
				{ messages: [] },
				{
					fetch: async () => {
						throw new Error("HTTP must not run for unsupported transport");
					},
				},
			),
		).rejects.toThrow("unsupported");
		expect(unsupported.dispatches()).toBe(0);
	});
});
