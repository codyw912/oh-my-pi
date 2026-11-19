import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	ToolExecutionBoundary,
	ToolExecutionSettlement,
} from "@oh-my-pi/pi-agent-core/types";
import { ToolExecutionBoundaryError } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createUserMessage } from "./helpers";

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

function passThroughBoundary(): ToolExecutionBoundary {
	return {
		admit: async () => ({
			settle: async () => {},
		}),
	};
}

function echoTool(executed: string[], concurrency: "shared" | "exclusive" = "shared") {
	const toolSchema = type({ value: "string" });
	const tool: AgentTool<typeof toolSchema, { value: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: toolSchema,
		concurrency,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return {
				content: [{ type: "text", text: `echoed: ${params.value}` }],
				details: { value: params.value },
			};
		},
	};
	return tool;
}

async function collectLoop(stream: AsyncIterable<AgentEvent>) {
	const events: AgentEvent[] = [];
	try {
		for await (const event of stream) events.push(event);
		return { events, error: undefined };
	} catch (error) {
		return { events, error };
	}
}

function expectBoundaryError(error: unknown, message: string): ToolExecutionBoundaryError {
	expect(error).toBeInstanceOf(ToolExecutionBoundaryError);
	if (!(error instanceof ToolExecutionBoundaryError)) throw new Error("expected ToolExecutionBoundaryError");
	expect(error.message).toBe(message);
	return error;
}

describe("ToolExecutionBoundary", () => {
	it("denied admission causes zero effects and is not a retryable tool error", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["must not retry"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async () => {
					throw new Error("admission denied");
				},
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream),
		);

		expect(executed).toEqual([]);
		expectBoundaryError(error, "admission denied");
		expect(mock.calls).toHaveLength(1);
		expect(events.some(event => event.type === "tool_execution_end")).toBe(false);
		expect(
			events.some(
				event => event.type === "message_end" && event.message.role === "toolResult" && event.message.isError,
			),
		).toBe(false);
	});

	it("settlement failure prevents queued siblings and reports the admitted result", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed, "exclusive");
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
					],
				},
				{ content: ["must not retry"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async () => ({
					settle: async () => {
						throw new Error("persist failed");
					},
				}),
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo both")], context, config, undefined, mock.stream),
		);

		expect(executed).toEqual(["first"]);
		expectBoundaryError(error, "persist failed");
		expect(mock.calls).toHaveLength(1);
		const ends = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(ends).toHaveLength(1);
		expect(ends[0]?.toolCallId).toBe("tool-1");
		expect(ends[0]?.isError).toBe(false);
		expect(ends[0]?.result.content).toEqual([{ type: "text", text: "echoed: first" }]);
	});

	it("already admitted concurrent effects remain reported after a sibling settlement fault", async () => {
		const executed: string[] = [];
		const firstGate = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const bothAdmitted = Promise.withResolvers<void>();
		let admitCount = 0;
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "shared",
			async execute(toolCallId, params) {
				if (toolCallId === "tool-1") {
					firstGate.resolve();
					await secondGate.promise;
				} else {
					secondGate.resolve();
					await firstGate.promise;
				}
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "alpha" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "beta" } },
					],
				},
				{ content: ["must not retry"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async context => {
					admitCount++;
					if (admitCount === 2) bothAdmitted.resolve();
					await bothAdmitted.promise;
					return {
						settle: async () => {
							if (context.toolCall.id === "tool-1") throw new Error("alpha persist failed");
						},
					};
				},
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo both")], context, config, undefined, mock.stream),
		);

		expect(executed.sort()).toEqual(["alpha", "beta"]);
		expectBoundaryError(error, "alpha persist failed");
		const ends = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool_execution_end" }> => event.type === "tool_execution_end",
		);
		expect(ends.map(event => event.toolCallId).sort()).toEqual(["tool-1", "tool-2"]);
		expect(ends.every(event => event.isError === false)).toBe(true);
	});

	it("settles not-started when a sibling faults during admit without starting execute", async () => {
		const executed: string[] = [];
		const settlements: ToolExecutionSettlement[] = [];
		const firstAdmitStarted = Promise.withResolvers<void>();
		const siblingDenied = Promise.withResolvers<void>();
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			concurrency: "shared",
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${params.value}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{
					content: [
						{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "alpha" } },
						{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "beta" } },
					],
				},
				{ content: ["must not retry"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async context => {
					if (context.toolCall.id === "tool-1") {
						firstAdmitStarted.resolve();
						await siblingDenied.promise;
						return {
							settle: async outcome => {
								settlements.push(outcome);
							},
						};
					}
					await firstAdmitStarted.promise;
					queueMicrotask(() => siblingDenied.resolve());
					throw new Error("sibling denied");
				},
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo both")], context, config, undefined, mock.stream),
		);

		expect(executed).toEqual([]);
		expectBoundaryError(error, "sibling denied");
		expect(settlements).toHaveLength(1);
		expect(settlements[0]?.outcome).toBe("not-started");
		expect(settlements[0]?.executed).toBe(false);
		expect(settlements[0]?.returnedResult).toBeUndefined();
		expect(events.some(event => event.type === "tool_execution_end")).toBe(false);
	});

	it("cancellation between receipt and invocation settles outcome not-started", async () => {
		const executed: string[] = [];
		const settlements: ToolExecutionSettlement[] = [];
		const controller = new AbortController();
		const tool = echoTool(executed);
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async () => {
					controller.abort("cancelled after admit");
					return {
						settle: async outcome => {
							settlements.push(outcome);
						},
					};
				},
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo")], context, config, controller.signal, mock.stream),
		);

		expect(executed).toEqual([]);
		expect(error).toBeUndefined();
		expect(settlements).toHaveLength(1);
		expect(settlements[0]?.executed).toBe(false);
		expect(settlements[0]?.outcome).toBe("not-started");
		expect(settlements[0]?.isError).toBe(true);
		expect(settlements[0]?.returnedResult).toBeUndefined();
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.type === "tool_execution_end" && end.isError).toBe(true);
	});

	it("a tool that writes then throws settles outcome threw without a returned result", async () => {
		const writes: string[] = [];
		const settlements: ToolExecutionSettlement[] = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				writes.push(params.value);
				throw new Error("boom after write");
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "dirty" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async () => ({
					settle: async outcome => {
						settlements.push(outcome);
					},
				}),
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo")], context, config, undefined, mock.stream),
		);

		expect(writes).toEqual(["dirty"]);
		expect(error).toBeUndefined();
		expect(mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(settlements).toHaveLength(1);
		expect(settlements[0]?.outcome).toBe("threw");
		expect(settlements[0]?.executed).toBe(true);
		expect(settlements[0]?.isError).toBe(true);
		expect(settlements[0]?.returnedResult).toBeUndefined();
		expect(JSON.stringify(settlements[0]?.result)).toContain("boom after write");
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.type === "tool_execution_end" && end.isError).toBe(true);
	});

	it("an explicit returned error settles outcome returned with the returned payload", async () => {
		const writes: string[] = [];
		const settlements: ToolExecutionSettlement[] = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				writes.push(params.value);
				return {
					content: [{ type: "text", text: `failed: ${params.value}` }],
					details: { value: params.value },
					isError: true,
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "nope" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async () => ({
					settle: async outcome => {
						settlements.push(outcome);
					},
				}),
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo")], context, config, undefined, mock.stream),
		);

		expect(writes).toEqual(["nope"]);
		expect(error).toBeUndefined();
		expect(settlements).toHaveLength(1);
		expect(settlements[0]?.outcome).toBe("returned");
		expect(settlements[0]?.executed).toBe(true);
		expect(settlements[0]?.isError).toBe(true);
		expect(settlements[0]?.returnedResult).toEqual({
			content: [{ type: "text", text: "failed: nope" }],
			details: { value: "nope" },
			isError: true,
		});
		const settlement = settlements[0];
		if (!settlement?.returnedResult) throw new Error("expected a returned tool result");
		expect(settlement.result).toEqual(settlement.returnedResult);
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.type === "tool_execution_end" && end.isError).toBe(true);
	});

	it("stays latched until explicit rebind and is not cleared by reset", async () => {
		const executed: string[] = [];
		const tool = echoTool(executed);
		let admitShouldFail = true;
		const boundary: ToolExecutionBoundary = {
			admit: async () => {
				if (admitShouldFail) throw new Error("latched denial");
				return { settle: async () => {} };
			},
		};
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "one" } }] },
				{ content: [{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "two" } }] },
				{ content: [{ type: "toolCall", id: "tool-3", name: "echo", arguments: { value: "three" } }] },
				{ content: ["done"] },
			],
		});
		const agent = new Agent({
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: mock.stream,
			toolExecutionBoundary: boundary,
		});

		await expect(agent.prompt("one")).rejects.toBeInstanceOf(ToolExecutionBoundaryError);
		expect(executed).toEqual([]);
		expect(agent.toolExecutionBoundaryError).toBeInstanceOf(ToolExecutionBoundaryError);

		agent.reset();
		expect(agent.toolExecutionBoundaryError).toBeInstanceOf(ToolExecutionBoundaryError);

		await expect(agent.prompt("two")).rejects.toBeInstanceOf(ToolExecutionBoundaryError);
		expect(executed).toEqual([]);

		admitShouldFail = false;
		agent.setToolExecutionBoundary(boundary);
		expect(agent.toolExecutionBoundaryError).toBeUndefined();
		await agent.prompt("three");
		expect(executed).toEqual(["three"]);
	});

	it("preserves beforeToolCall argument mutation when a boundary is installed", async () => {
		const executed: Array<string | number> = [];
		const toolSchema = type({ value: "string" });
		const tool: AgentTool<typeof toolSchema, { value: string | number }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return {
					content: [{ type: "text", text: `echoed: ${String(params.value)}` }],
					details: { value: params.value },
				};
			},
		};
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: passThroughBoundary(),
			beforeToolCall: async ({ args }) => {
				args.value = 123;
				return undefined;
			},
		};

		const { error } = await collectLoop(
			agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream),
		);

		expect(error).toBeUndefined();
		expect(executed).toEqual([123]);
	});

	it("snapshots returnedResult when afterToolCall mutates in place then throws", async () => {
		const executed: string[] = [];
		const settlements: ToolExecutionSettlement[] = [];
		const tool = echoTool(executed);
		const context: AgentContext = { systemPrompt: [""], messages: [], tools: [tool] };
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "hello" } }] },
				{ content: ["done"] },
			],
		});
		const config: AgentLoopConfig = {
			model: mock.model,
			convertToLlm: identityConverter,
			toolExecutionBoundary: {
				admit: async () => ({
					settle: async outcome => {
						settlements.push(outcome);
					},
				}),
			},
			afterToolCall: async ({ result }) => {
				for (const block of result.content) {
					if (block.type === "text") block.text = "mutated";
				}
				throw new Error("hook exploded");
			},
		};

		const { events, error } = await collectLoop(
			agentLoop([createUserMessage("echo something")], context, config, undefined, mock.stream),
		);

		expect(error).toBeUndefined();
		expect(executed).toEqual(["hello"]);
		expect(mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(settlements).toHaveLength(1);
		expect(settlements[0]?.outcome).toBe("returned");
		expect(settlements[0]?.executed).toBe(true);
		expect(settlements[0]?.isError).toBe(true);
		expect(settlements[0]?.returnedResult?.content).toEqual([{ type: "text", text: "echoed: hello" }]);
		expect(JSON.stringify(settlements[0]?.result)).toContain("hook exploded");
		const end = events.find(event => event.type === "tool_execution_end");
		expect(end?.type === "tool_execution_end" && end.isError).toBe(true);
		expect(JSON.stringify(end)).toContain("hook exploded");
	});
});
