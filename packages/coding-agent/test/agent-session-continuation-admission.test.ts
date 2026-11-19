import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	ContinuationBindingFactory,
	ContinuationSessionBinding,
} from "@oh-my-pi/pi-coding-agent/session/continuation-binding";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { completeImplFromEnrollment } from "@oh-my-pi/pi-coding-agent/session/continuation-complete";
import { ContinuationRequestBoundaryError, registerContinuationTransport } from "../src/session/continuation-request";
import { classifyUnexpectedStop } from "@oh-my-pi/pi-coding-agent/session/unexpected-stop-classifier";
import {
	DEFAULT_MEMORY_LOCAL_MODEL_KEY,
	DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY,
} from "@oh-my-pi/pi-coding-agent/tiny/models";
import { tinyModelClient, tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { anthropicToolUseSse } from "./fixtures/continuation/portable-session";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

function allowHttpReceipt() {
	return {
		received: async () => {},
		failed: async (_error: unknown, _dispatched: boolean) => {},
	};
}

function allowRequestReceipt() {
	return {
		admitHttp: async () => allowHttpReceipt(),
		settle: async () => {},
		beforeRetryWait: async () => {},
	};
}

function createFactory(options: { failRequest?: boolean; failTool?: boolean }): ContinuationBindingFactory {
	const bind = (role: ContinuationSessionBinding["role"]): ContinuationSessionBinding => ({
		role,
		factory: { bindSession: (_manager, nextRole) => bind(nextRole) },
		requestBoundary: {
			admit: async () => {
				if (options.failRequest) throw new Error("request admission failed");
				return allowRequestReceipt();
			},
		},
		toolBoundary: {
			admit: async () => {
				if (options.failTool) throw new Error("tool admission failed");
				return { settle: async () => {} };
			},
		},
		admitJob: async () => {},
		acceptDeliveries: async () => {},
		forRole: nextRole => bind(nextRole),
		beforeRecovery: async () => ({ kind: "allow" as const }),
		barrier: async () => {},
		assertSessionTransition: () => {},
		dispose: async () => {},
	});
	return { bindSession: (_manager, role) => bind(role) };
}

describe("AgentSession continuation admission", () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled anthropic model");

	let authStorage = createInMemoryAuthStorage();
	let session: AgentSession | undefined;

	beforeEach(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
	});

	it("rejects enrolled async execution without an owner identity", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		try {
			expect(() => {
				session = new AgentSession({
					agent: new Agent({ initialState: { model, tools: [] } }),
					sessionManager: SessionManager.inMemory(),
					settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
					modelRegistry: new ModelRegistry(authStorage),
					asyncJobManager: manager,
					continuationFactory: createFactory({}),
				});
			}).toThrow("Continuation with async jobs requires an explicit agentId");
			expect(manager.getAllJobs()).toEqual([]);
		} finally {
			await manager.dispose();
		}
	});

	it("keeps ordinary stream and tool execution when enrollment is absent", async () => {
		let streamCalls = 0;
		let toolCalls = 0;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: type({}),
			execute: async () => {
				toolCalls += 1;
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [echo], messages: [] },
			convertToLlm,
			streamFn: async () => {
				streamCalls += 1;
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "hi" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[echo.name, echo]]),
		});
		await session.prompt("go");
		expect(streamCalls).toBe(1);
		expect(toolCalls).toBe(0);
		expect(session.continuationFactory).toBeUndefined();
	});

	it("stops actual stream dispatch when request receipt admission fails", async () => {
		let streamCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
			streamFn: registerContinuationTransport(async () => {
				streamCalls += 1;
				throw new Error("underlying stream must not run");
			}),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			continuationFactory: createFactory({ failRequest: true }),
		});
		await session.prompt("go");
		await session.prompt("try again");
		expect(streamCalls).toBe(0);
	});

	it("stops actual tool execution when tool receipt admission fails", async () => {
		let toolCalls = 0;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo",
			parameters: type({}),
			execute: async () => {
				toolCalls += 1;
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		let streamCalls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				streamCalls++;
				return anthropicToolUseSse("echo", {});
			},
		});
		try {
			const agent = new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model: { ...model, baseUrl: server.url.origin },
					systemPrompt: ["Test"],
					tools: [echo],
					messages: [],
				},
				convertToLlm,
				streamFn: streamSimple,
			});
			session = new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
				toolRegistry: new Map([[echo.name, echo]]),
				continuationFactory: createFactory({ failTool: true }),
			});
			await expect(session.prompt("go")).rejects.toThrow(/tool admission failed|Tool execution boundary/);
			expect(streamCalls).toBe(1);
			expect(toolCalls).toBe(0);
		} finally {
			await server.stop(true);
		}
	});
});

describe("enrolled unsupported inference rejects before dispatch", () => {
	it("completeImplFromEnrollment throws without invoking completeSimple when enrolled and unwrapped", async () => {
		const complete = completeImplFromEnrollment(undefined, true);
		await expect(complete({} as never, { messages: [] })).rejects.toBeInstanceOf(ContinuationRequestBoundaryError);
	});

	it("does not call the local tiny title worker when enrolled", async () => {
		const generate = spyOn(tinyTitleClient, "generate").mockResolvedValue("should-not-run");
		let streamCalls = 0;
		const streamFn = async () => {
			streamCalls += 1;
			throw new Error("admitted stream must not run for local tiny titles");
		};
		try {
			await expect(
				generateSessionTitle(
					"Implement continuation admission wiring",
					new ModelRegistry(createInMemoryAuthStorage()),
					Settings.isolated({ "providers.tinyModel": DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY }),
					"sess",
					undefined,
					undefined,
					undefined,
					undefined,
					undefined,
					streamFn,
				),
			).rejects.toBeInstanceOf(ContinuationRequestBoundaryError);
			expect(generate).not.toHaveBeenCalled();
			expect(streamCalls).toBe(0);
		} finally {
			generate.mockRestore();
		}
	});

	it("does not call the local unexpected-stop worker when enrolled", async () => {
		const complete = spyOn(tinyModelClient, "complete").mockResolvedValue("yes");
		let streamCalls = 0;
		try {
			await expect(
				classifyUnexpectedStop("the model stopped unexpectedly", {
					settings: Settings.isolated({ "providers.unexpectedStopModel": DEFAULT_MEMORY_LOCAL_MODEL_KEY }),
					registry: new ModelRegistry(createInMemoryAuthStorage()),
					sessionId: "sess",
					streamFn: async () => {
						streamCalls += 1;
						throw new Error("admitted stream must not run for local tiny classifiers");
					},
				}),
			).rejects.toBeInstanceOf(ContinuationRequestBoundaryError);
			expect(complete).not.toHaveBeenCalled();
			expect(streamCalls).toBe(0);
		} finally {
			complete.mockRestore();
		}
	});
});
