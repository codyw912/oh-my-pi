/**
 * bindContinuationStream at real encoder/HTTP dispatch seams.
 *
 * Enrolled HTTP-only behavior (StreamOptions.fetch, no live inference):
 *   anthropic-messages, openai-responses, openai-codex-responses
 * Also honors fetch:
 *   openai-completions, azure-openai-responses, openrouter,
 *   google-generative-ai, google-gemini-cli, google-vertex, ollama-chat
 * Rejected before dispatch; controller still sees admit + not-started:
 *   pi-native transport, bedrock-converse-stream, cursor-agent,
 *   devin-agent, gitlab-duo-agent, injected Anthropic clients
 *
 * Ordinary sessions never install this adapter.
 */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	FetchImpl,
	Model,
	SimpleStreamOptions,
	Tool,
} from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	bindContinuationStream,
	ContinuationAdmissionError,
	ContinuationRequestBoundaryError,
	registerContinuationTransport,
	type ContinuationRequestBoundary,
	type ContinuationRequestOutcome,
} from "../src/session/continuation-request";
import { anthropicSse, openaiResponsesSse } from "./fixtures/continuation/scripted-providers";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const lookupTool: Tool = {
	name: "lookup",
	description: "Look up a key",
	parameters: {
		type: "object",
		properties: { key: { type: "string" } },
		required: ["key"],
	},
};

function anthropicModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function openaiResponsesModel(): Model<"openai-responses"> {
	return buildModel({
		id: "gpt-5-mini",
		name: "GPT-5 mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function codexModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
	});
}

function bedrockModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-sonnet-4-6",
		name: "Bedrock Claude",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function cursorModel(): Model<"cursor-agent"> {
	return buildModel({
		id: "cursor-composer",
		name: "Cursor Composer",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function richContext(): Context {
	return {
		systemPrompt: ["You are a continuation fixture."],
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "describe this and lookup k1" },
					{ type: "image", data: PNG_B64, mimeType: "image/png" },
				],
				timestamp: 1,
			},
		],
		tools: [lookupTool],
	};
}

function textContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
	};
}

function codexSse(text: string): Response {
	const events = [
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function codexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

interface WireCapture {
	trace: string[];
	urls: string[];
	bodies: Array<Record<string, unknown>>;
	headers: Headers[];
	redirects: Array<RequestInit["redirect"] | undefined>;
}

function scriptedFetch(
	handle: (call: number, capture: WireCapture) => Response | Promise<Response>,
	trace: string[] = [],
): {
	fetch: FetchImpl;
	capture: WireCapture;
} {
	const capture: WireCapture = { trace, urls: [], bodies: [], headers: [], redirects: [] };
	const fetch: FetchImpl = async (input, init) => {
		trace.push("network");
		capture.urls.push(requestUrl(input));
		capture.redirects.push(init?.redirect ?? (input instanceof Request ? input.redirect : undefined));
		if (typeof init?.body === "string") {
			try {
				capture.bodies.push(JSON.parse(init.body) as Record<string, unknown>);
			} catch {
				capture.bodies.push({ raw: init.body });
			}
		}
		capture.headers.push(new Headers(init?.headers));
		return handle(capture.urls.length, capture);
	};
	return { fetch, capture };
}

interface BoundaryHooks {
	admit?: () => Promise<void>;
	admitHttp?: () => Promise<void>;
	settle?: (outcome: ContinuationRequestOutcome) => Promise<void>;
	received?: (response: Response) => Promise<void>;
	failed?: (error: unknown, dispatched: boolean) => Promise<void>;
}

function recordingBoundary(hooks: BoundaryHooks = {}, trace: string[] = []) {
	const settlements: ContinuationRequestOutcome[] = [];
	const httpFailures: Array<{ dispatched: boolean }> = [];
	const boundary: ContinuationRequestBoundary = {
		async admit() {
			trace.push("admit");
			await hooks.admit?.();
			return {
				async admitHttp() {
					trace.push("admitHttp");
					await hooks.admitHttp?.();
					return {
						async received(response) {
							trace.push("received");
							await hooks.received?.(response);
						},
						async failed(error, dispatched) {
							httpFailures.push({ dispatched });
							trace.push(dispatched ? "failed-dispatched" : "failed-not-dispatched");
							await hooks.failed?.(error, dispatched);
						},
					};
				},
				async settle(outcome) {
					settlements.push(outcome);
					trace.push("settle");
					await hooks.settle?.(outcome);
				},
				async beforeRetryWait() {
					trace.push("beforeRetryWait");
				},
			};
		},
	};
	return { boundary, trace, settlements, httpFailures };
}

async function readStream(stream: AssistantMessageEventStream): Promise<{
	events: AssistantMessageEvent[];
	error?: unknown;
	message?: AssistantMessage;
}> {
	const events: AssistantMessageEvent[] = [];
	try {
		for await (const event of stream) events.push(event);
		return { events, message: await stream.result() };
	} catch (error) {
		return { events, error };
	}
}

function capturingStream(): {
	fn: StreamFn;
	options: SimpleStreamOptions[];
	models: Model[];
	contexts: Context[];
} {
	const options: SimpleStreamOptions[] = [];
	const models: Model[] = [];
	const contexts: Context[] = [];
	const fn: StreamFn = (model, context, streamOptions) => {
		models.push(model);
		contexts.push(context);
		if (streamOptions) options.push(streamOptions);
		return streamSimple(model, context, streamOptions);
	};
	return { fn: registerContinuationTransport(fn), options, models, contexts };
}

function httpAttempts(trace: string[]): string[] {
	return trace.filter(step => step === "admitHttp" || step === "network");
}

describe("bindContinuationStream", () => {
	it("keeps transport registration out of the public package API", () => {
		expect(() => import.meta.resolve("@oh-my-pi/pi-coding-agent/session/continuation-request")).toThrow();
	});

	it("rejects an HTTP API that has not passed continuation certification", async () => {
		const recorded = recordingBoundary();
		const model: Model = { ...anthropicModel(), api: "google-generative-ai" };
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
		await expect(bound(model, textContext(), { apiKey: "synthetic-test-key" })).rejects.toBeInstanceOf(
			ContinuationRequestBoundaryError,
		);
		expect(httpAttempts(recorded.trace)).toEqual([]);
		expect(recorded.settlements).toEqual([expect.objectContaining({ kind: "not-started" })]);
	});

	it("rejects an uncertified stream before it can dispatch outside the HTTP boundary", async () => {
		const recorded = recordingBoundary();
		let escapedDispatches = 0;
		const untrusted: StreamFn = async () => {
			escapedDispatches++;
			throw new Error("This transport ignores the supplied fetch");
		};
		const bound = bindContinuationStream(untrusted, recorded.boundary, "primary");
		await expect(bound(anthropicModel(), textContext(), {})).rejects.toThrow("certified HTTP transport");
		expect(escapedDispatches).toBe(0);
		expect(recorded.trace).toEqual([]);
	});

	it("rejects output from a certified wrapper that bypasses the admitted fetch", async () => {
		const recorded = recordingBoundary();
		const bypass = registerContinuationTransport((model, context, options) =>
			streamSimple(model, context, { ...options, fetch: async () => anthropicSse("unobserved output") }),
		);
		const stream = await bindContinuationStream(bypass, recorded.boundary, "primary")(
			anthropicModel(),
			textContext(),
			{ apiKey: "synthetic-test-key" },
		);
		const observed = await readStream(stream);
		expect(observed.error).toBeInstanceOf(ContinuationRequestBoundaryError);
		expect(observed.message).toBeUndefined();
		expect(httpAttempts(recorded.trace)).toEqual([]);
		expect(recorded.settlements).toEqual([
			expect.objectContaining({
				kind: "threw",
				unobservedTransport: true,
			}),
		]);
	});

	it("admits Anthropic Messages HTTP before each wire send and settles before terminal output", async () => {
		const inner = capturingStream();
		const trace: string[] = [];
		const recorded = recordingBoundary({}, trace);
		const wire = scriptedFetch(() => anthropicSse("ok"), trace);
		const bound = bindContinuationStream(inner.fn, recorded.boundary, "primary");
		const context = richContext();
		const stream = await bound(anthropicModel(), context, {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			temperature: 0.2,
			maxTokens: 256,
			headers: { "x-cont-setting": "keep" },
			anthropicCacheRefresh: true,
			preferWebsockets: true,
			providerRetryWait: async () => {},
		});
		const seen: string[] = [];
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") {
				expect(trace.includes("settle")).toBe(true);
				seen.push(event.type);
			}
		}
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		expect(recorded.settlements).toEqual([{ kind: "returned", message }]);
		expect(httpAttempts(trace)).toEqual(["admitHttp", "network"]);
		expect(seen).toEqual(["done"]);
		expect(inner.options[0]?.anthropicCacheRefresh).toBe(false);
		expect(inner.options[0]?.preferWebsockets).toBe(false);
		expect(inner.options[0]?.temperature).toBe(0.2);
		expect(inner.options[0]?.headers?.["x-cont-setting"]).toBe("keep");
		expect(inner.contexts[0]).toBe(context);
		expect(inner.contexts[0]?.tools?.[0]?.name).toBe("lookup");

		const body = wire.capture.bodies[0];
		expect(body).toBeDefined();
		expect(JSON.stringify(body)).toContain("lookup");
		expect(JSON.stringify(body)).toContain(PNG_B64);
		expect(body?.max_tokens).toBe(256);
		expect(wire.capture.headers[0]?.get("x-cont-setting")).toBe("keep");
	});

	it("retries OpenAI Responses through durable admitHttp before every transport attempt", async () => {
		const trace: string[] = [];
		const recorded = recordingBoundary({}, trace);
		let attempts = 0;
		const wire = scriptedFetch(() => {
			attempts++;
			if (attempts === 1) {
				return new Response(JSON.stringify({ error: { message: "slow down" } }), {
					status: 429,
					headers: { "retry-after-ms": "0", "content-type": "application/json" },
				});
			}
			return openaiResponsesSse("hi");
		}, trace);
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "worker");
		const stream = await bound(openaiResponsesModel(), textContext(), {
			apiKey: "test-openai-key",
			fetch: wire.fetch,
			providerRetryWait: async () => {},
		});
		const { message, error } = await readStream(stream);

		expect(error).toBeUndefined();
		expect(message?.stopReason).toBe("stop");
		expect(wire.capture.urls.length).toBe(2);
		expect(wire.capture.urls.every(url => url.includes("/responses"))).toBe(true);
		expect(httpAttempts(trace)).toEqual(["admitHttp", "network", "admitHttp", "network"]);
		expect(recorded.settlements[0]?.kind).toBe("returned");
	});

	it("forces Codex Responses onto HTTP even when the model prefers websockets", async () => {
		const inner = capturingStream();
		const trace: string[] = [];
		const recorded = recordingBoundary({}, trace);
		const wire = scriptedFetch(() => codexSse("Hello"), trace);
		const bound = bindContinuationStream(inner.fn, recorded.boundary, "primary");
		const stream = await bound(codexModel(), textContext(), {
			apiKey: codexToken(),
			fetch: wire.fetch,
			preferWebsockets: true,
			providerSessionState: new Map(),
			sessionId: "codex-cont-session",
			providerRetryWait: async () => {},
		});
		const { message, error } = await readStream(stream);

		expect(error).toBeUndefined();
		expect(message?.stopReason).toBe("stop");
		expect(wire.capture.urls.length).toBe(1);
		expect(wire.capture.urls[0]).toContain("/responses");
		expect(httpAttempts(trace)).toEqual(["admitHttp", "network"]);
		expect(inner.models[0]?.preferWebsockets).toBe(false);
		expect(inner.options[0]?.preferWebsockets).toBe(false);
		expect(recorded.settlements[0]?.kind).toBe("returned");
	});

	it("does not emit terminal assistant output when durable settle fails", async () => {
		const trace: string[] = [];
		const recorded = recordingBoundary(
			{
				settle: async () => {
					throw new Error("journal write failed");
				},
			},
			trace,
		);
		const wire = scriptedFetch(() => anthropicSse("secret-terminal"), trace);
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
		const stream = await bound(anthropicModel(), textContext(), {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			providerRetryWait: async () => {},
		});
		const { events, error } = await readStream(stream);

		expect(error).toBeInstanceOf(ContinuationRequestBoundaryError);
		expect(events.some(event => event.type === "done" || event.type === "error")).toBe(false);
		await expect(stream.result()).rejects.toBeInstanceOf(ContinuationRequestBoundaryError);

		const second = bound(anthropicModel(), textContext(), {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			providerRetryWait: async () => {},
		});
		await expect(second).rejects.toBe(error);
		expect(trace.filter(step => step === "admit")).toHaveLength(1);
	});

	it("latches a persistence fault across a post-await admission race", async () => {
		const secondAdmitEntered = Promise.withResolvers<void>();
		const releaseSecondAdmit = Promise.withResolvers<void>();
		let admitStarts = 0;
		const trace: string[] = [];
		const recorded = recordingBoundary(
			{
				admit: async () => {
					if (++admitStarts === 2) {
						secondAdmitEntered.resolve();
						await releaseSecondAdmit.promise;
					}
				},
				received: async () => {
					await secondAdmitEntered.promise;
					throw new Error("http receipt persist failed");
				},
			},
			trace,
		);
		const wire = scriptedFetch(() => anthropicSse("race"), trace);
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "advisor");
		const options: SimpleStreamOptions = {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			providerRetryWait: async () => {},
		};
		const first = await bound(anthropicModel(), textContext(), options);
		const second = bound(anthropicModel(), textContext(), options);
		const firstRead = await readStream(first);
		releaseSecondAdmit.resolve();
		expect(firstRead.error).toBeInstanceOf(ContinuationRequestBoundaryError);
		await expect(second).rejects.toBe(firstRead.error);
		expect(wire.capture.urls.length).toBe(1);
		expect(recorded.settlements[1]?.kind).toBe("not-started");
	});

	it("settles abort after intent as not-started without dispatch", async () => {
		const controller = new AbortController();
		const trace: string[] = [];
		const recorded = recordingBoundary(
			{
				admit: async () => {
					controller.abort("operator-stop");
				},
			},
			trace,
		);
		const wire = scriptedFetch(() => anthropicSse("nope"), trace);
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "maintenance");
		await expect(
			bound(anthropicModel(), textContext(), {
				apiKey: "test-anthropic-key",
				fetch: wire.fetch,
				signal: controller.signal,
				providerRetryWait: async () => {},
			}),
		).rejects.toBe("operator-stop");
		expect(wire.capture.urls).toEqual([]);
		expect(recorded.settlements).toEqual([{ kind: "not-started", reason: "operator-stop" }]);
		expect(trace.filter(step => step === "admitHttp")).toHaveLength(0);
	});

	it("rejects unsupported routing after admit so the controller still accounts not-started", async () => {
		const cases: Model[] = [{ ...anthropicModel(), transport: "pi-native" }, bedrockModel(), cursorModel()];
		for (const model of cases) {
			const trace: string[] = [];
			const recorded = recordingBoundary({}, trace);
			const wire = scriptedFetch(() => {
				throw new Error("network must not run");
			}, trace);
			const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
			await expect(
				bound(model, textContext(), {
					apiKey: "test-key",
					fetch: wire.fetch,
					providerRetryWait: async () => {},
				}),
			).rejects.toBeInstanceOf(ContinuationRequestBoundaryError);
			expect(trace.filter(step => step === "admit")).toHaveLength(1);
			expect(recorded.settlements[0]?.kind).toBe("not-started");
			expect(wire.capture.urls).toEqual([]);
		}

		const injectedClientOptions = {
			apiKey: "test-key",
			client: { messages: { create() {} } },
		};
		const trace: string[] = [];
		const recorded = recordingBoundary({}, trace);
		const wire = scriptedFetch(() => {
			throw new Error("network must not run");
		}, trace);
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
		await expect(
			bound(anthropicModel(), textContext(), {
				...injectedClientOptions,
				fetch: wire.fetch,
				providerRetryWait: async () => {},
			}),
		).rejects.toBeInstanceOf(ContinuationRequestBoundaryError);
		expect(trace.filter(step => step === "admit")).toHaveLength(1);
		expect(recorded.settlements[0]?.kind).toBe("not-started");
		expect(wire.capture.urls).toEqual([]);
	});

	it("cancels a streaming response when the HTTP receipt cannot be committed", async () => {
		let cancelled = false;
		const recorded = recordingBoundary({
			received: async () => {
				throw new Error("cannot journal headers");
			},
		});
		const wire = scriptedFetch(() => {
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
				},
				cancel() {
					cancelled = true;
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
		const stream = await bound(anthropicModel(), textContext(), {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			providerRetryWait: async () => {},
		});
		const { events, error } = await readStream(stream);
		expect(error).toBeInstanceOf(ContinuationRequestBoundaryError);
		expect(cancelled).toBe(true);
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(recorded.settlements[0]?.kind).toBe("threw");
	});

	it("does not latch ContinuationAdmissionError so a later request can proceed", async () => {
		let admits = 0;
		const recorded = recordingBoundary({
			admit: async () => {
				admits++;
				if (admits === 1) {
					throw new ContinuationAdmissionError({ kind: "defer", reason: "paused" });
				}
			},
		});
		const wire = scriptedFetch(() => anthropicSse("ok"));
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
		const options: SimpleStreamOptions = {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			providerRetryWait: async () => {},
		};
		await expect(bound(anthropicModel(), textContext(), options)).rejects.toBeInstanceOf(ContinuationAdmissionError);
		const stream = await bound(anthropicModel(), textContext(), options);
		const { message, error } = await readStream(stream);
		expect(error).toBeUndefined();
		expect(message?.stopReason).toBe("stop");
		expect(admits).toBe(2);
	});

	it("marks HTTP intent as not dispatched when abort wins before fetch", async () => {
		const controller = new AbortController();
		const trace: string[] = [];
		const recorded = recordingBoundary(
			{
				admitHttp: async () => {
					controller.abort("operator-stop");
				},
			},
			trace,
		);
		const wire = scriptedFetch(() => anthropicSse("nope"), trace);
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
		const stream = await bound(anthropicModel(), textContext(), {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			signal: controller.signal,
			providerRetryWait: async () => {},
		});
		const { message } = await readStream(stream);
		expect(message?.stopReason).toBe("aborted");
		expect(wire.capture.urls).toEqual([]);
		expect(recorded.httpFailures).toEqual([{ dispatched: false }]);
		expect(recorded.settlements[0]?.kind).toBe("not-started");
	});

	it("does not settle a provider error event as returned after a dispatched fetch failure", async () => {
		const trace: string[] = [];
		const recorded = recordingBoundary({}, trace);
		const wire = scriptedFetch(() => {
			throw new Error("socket reset");
		}, trace);
		const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
		const stream = await bound(anthropicModel(), textContext(), {
			apiKey: "test-anthropic-key",
			fetch: wire.fetch,
			providerRetryWait: async () => {},
		});
		const { events, error } = await readStream(stream);
		expect(error).toBeDefined();
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(recorded.httpFailures.some(failure => failure.dispatched)).toBe(true);
		expect(recorded.settlements[0]?.kind).toBe("threw");
		expect(wire.capture.urls).toHaveLength(1);
	});

	it("does not follow 302/307 redirects or send the payload to another endpoint", async () => {
		const other = "https://evil.example/v1/messages";
		for (const status of [302, 307]) {
			const trace: string[] = [];
			const recorded = recordingBoundary({}, trace);
			const wire = scriptedFetch(() => {
				const url = wire.capture.urls[wire.capture.urls.length - 1] ?? "";
				if (url.includes("evil.example")) {
					throw new Error(`${status} redirect target must not be requested`);
				}
				return new Response(null, {
					status,
					headers: { Location: other },
				});
			}, trace);
			const bound = bindContinuationStream(streamSimple, recorded.boundary, "primary");
			const stream = await bound(anthropicModel(), textContext(), {
				apiKey: "test-anthropic-key",
				fetch: wire.fetch,
				providerRetryWait: async () => {},
			});
			const { events, error } = await readStream(stream);
			expect(error).toBeInstanceOf(ContinuationRequestBoundaryError);
			expect(events.some(event => event.type === "done")).toBe(false);
			expect(wire.capture.urls.some(url => url.includes("evil.example"))).toBe(false);
			expect(wire.capture.redirects.every(mode => mode === "manual")).toBe(true);
			expect(recorded.httpFailures.some(failure => failure.dispatched)).toBe(true);
			expect(recorded.settlements[0]?.kind).toBe("threw");
		}
	});

	it("pins redirect manual on Request inputs so follow mode cannot reach another endpoint", async () => {
		const other = "https://evil.example/redirected";
		const recorded = recordingBoundary();
		const wire = scriptedFetch(() => {
			if (wire.capture.urls.some(url => url.includes("evil.example"))) {
				throw new Error("redirect target must not be requested");
			}
			return new Response(null, { status: 307, headers: { Location: other } });
		});
		const inner: StreamFn = async (_model, _context, streamOptions) => {
			const request = new Request("https://api.anthropic.com/v1/messages", {
				method: "POST",
				redirect: "follow",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			await streamOptions?.fetch?.(request);
			throw new Error("redirect must not be returned as success");
		};
		const bound = bindContinuationStream(registerContinuationTransport(inner), recorded.boundary, "primary");
		await expect(
			bound(anthropicModel(), textContext(), {
				apiKey: "test-anthropic-key",
				fetch: wire.fetch,
				providerRetryWait: async () => {},
			}),
		).rejects.toBeInstanceOf(ContinuationRequestBoundaryError);
		expect(wire.capture.urls).toEqual(["https://api.anthropic.com/v1/messages"]);
		expect(wire.capture.redirects).toEqual(["manual"]);
		expect(recorded.httpFailures).toEqual([{ dispatched: true }]);
		expect(recorded.settlements[0]?.kind).toBe("threw");
	});
});
