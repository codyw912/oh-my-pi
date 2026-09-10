/**
 * Contract: `createSettingsAwareStreamFn` layers session provider settings
 * (`providers.openrouterVariant`, `providers.antigravityEndpoint`,
 * `providers.stream*TimeoutSeconds`, `providers.maxInFlightRequests`,
 * `model.loopGuard.*`, `textVerbosity` for Responses-family requests)
 * options win — the same wiring the main agent and the advisor agent share so
 * OpenRouter sticky-routing / response caching behaves the same on advisor turns
 * (can1357/oh-my-pi#3639).
 */
import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";

function captureBase(): { fn: StreamFn; calls: Array<{ options?: SimpleStreamOptions }> } {
	const calls: Array<{ options?: SimpleStreamOptions }> = [];
	const fn: StreamFn = (_model, _context, options) => {
		calls.push({ options });
		return new AssistantMessageEventStream();
	};
	return { fn, calls };
}

const stubModel = {} as unknown as Model;
const stubCodexModel = { api: "openai-codex-responses" } as unknown as Model;
const stubResponsesModel = { api: "openai-responses" } as unknown as Model;
const stubContext = { messages: [], tools: [], systemPrompt: [] } as unknown as Context;
const bifrostOpenCodeModel = {
	api: "openai-completions",
	provider: "bifrost-chat",
	id: "opencode-go/glm-5.3",
	baseUrl: "http://bifrost.home.lan:4200/v1",
} as unknown as Model;

describe("createSettingsAwareStreamFn", () => {
	it("applies provider settings to the forwarded options when caller omits them", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
			"model.loopGuard.checkAssistantContent": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, { apiKey: "k" });

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("floor");
		expect(options?.antigravityEndpointMode).toBe("sandbox");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 4 });
		expect(options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
		// caller's own option is preserved
		expect(options?.apiKey).toBe("k");
	});

	describe("OpenCode session routing", () => {
		it("forwards one stable session through Bifrost", () => {
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

			wrapped(bifrostOpenCodeModel, stubContext, { sessionId: "session-123" });

			expect(calls[0]?.options?.headers).toEqual({
				"x-bf-eh-x-opencode-session": "session-123",
				"x-bf-eh-x-opencode-client": "omp",
				"x-bf-session-id": "session-123",
			});
		});

		it("recognizes every Bifrost OpenCode protocol adapter", () => {
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);
			for (const id of [
				"opencode-go/glm-5.3",
				"opencode-go-responses/gpt-5.6-luna",
				"opencode-go-messages/qwen3.7-plus",
			]) {
				wrapped({ ...bifrostOpenCodeModel, id } as Model, stubContext, { sessionId: "session-123" });
			}

			expect(calls).toHaveLength(3);
			for (const call of calls) {
				expect(call.options?.headers?.["x-bf-eh-x-opencode-session"]).toBe("session-123");
			}
		});

		it("does not add routing headers to unrelated models", () => {
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

			wrapped(stubCodexModel, stubContext, { sessionId: "session-123" });

			expect(calls[0]?.options?.headers).toBeUndefined();
		});

		it("maps a standard per-request session override onto Bifrost forwarding", () => {
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

			wrapped(bifrostOpenCodeModel, stubContext, {
				sessionId: "session-123",
				headers: { "X-OpenCode-Session": "caller-session" },
			});

			expect(calls[0]?.options?.headers?.["x-bf-eh-x-opencode-session"]).toBe("caller-session");
			expect(calls[0]?.options?.headers?.["x-bf-session-id"]).toBe("caller-session");
		});

		it("maps a standard model session override onto Bifrost forwarding", () => {
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);
			const model = {
				...bifrostOpenCodeModel,
				headers: { "x-opencode-session": "model-session" },
			} as Model;

			wrapped(model, stubContext, { sessionId: "session-123" });

			expect(calls[0]?.options?.headers?.["x-bf-eh-x-opencode-session"]).toBe("model-session");
			expect(calls[0]?.options?.headers?.["x-bf-session-id"]).toBe("model-session");
		});

		it("merges a mixed-case Bifrost session override without duplicate wire headers", () => {
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(Settings.isolated({}), base);

			wrapped(bifrostOpenCodeModel, stubContext, {
				sessionId: "session-123",
				headers: { "X-BF-EH-X-OpenCode-Session": "caller-session" },
			});

			const sessionHeaders = Object.entries(calls[0]?.options?.headers ?? {}).filter(
				([name]) => name.toLowerCase() === "x-bf-eh-x-opencode-session",
			);
			expect(sessionHeaders).toEqual([["X-BF-EH-X-OpenCode-Session", "caller-session"]]);
			expect(calls[0]?.options?.headers?.["x-bf-session-id"]).toBe("caller-session");
		});
	});

	it("keeps assistant prose loop scanning at its configured default", () => {
		const settings = Settings.isolated({});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.loopGuard).toEqual({ enabled: true, checkAssistantContent: true });
	});

	it("keeps thinking summaries visible unless configured otherwise", () => {
		const settings = Settings.isolated({});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(false);
	});

	it("forwards configured hidden thinking summaries", () => {
		const settings = Settings.isolated({ omitThinking: true });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.hideThinkingSummary).toBe(true);
	});

	it("applies Codex text verbosity only when settings or caller options configure it", () => {
		const unconfiguredSettings = Settings.isolated({});
		const { fn: unconfiguredBase, calls: unconfiguredCalls } = captureBase();
		const unconfiguredWrapped = createSettingsAwareStreamFn(unconfiguredSettings, unconfiguredBase);

		unconfiguredWrapped(stubCodexModel, stubContext, undefined);
		unconfiguredWrapped(stubCodexModel, stubContext, { textVerbosity: "medium" });

		expect(unconfiguredCalls[0]?.options?.textVerbosity).toBeUndefined();
		expect(unconfiguredCalls[1]?.options?.textVerbosity).toBe("medium");

		const settings = Settings.isolated({ textVerbosity: "low" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubCodexModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, undefined);
		wrapped(stubResponsesModel, stubContext, { textVerbosity: "medium" });

		expect(calls[0]?.options?.textVerbosity).toBe("low");
		expect(calls[1]?.options?.textVerbosity).toBe("low");
		expect(calls[2]?.options?.textVerbosity).toBe("medium");
	});

	it("forwards configured stream watchdog budgets while preserving caller overrides", () => {
		const settings = Settings.isolated({
			"providers.streamFirstEventTimeoutSeconds": 600,
			"providers.streamIdleTimeoutSeconds": 300,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, {
			streamFirstEventTimeoutMs: 15_000,
			streamIdleTimeoutMs: 10_000,
		});

		expect(calls[0]?.options?.streamFirstEventTimeoutMs).toBe(600_000);
		expect(calls[0]?.options?.streamIdleTimeoutMs).toBe(300_000);
		expect(calls[1]?.options?.streamFirstEventTimeoutMs).toBe(15_000);
		expect(calls[1]?.options?.streamIdleTimeoutMs).toBe(10_000);
	});

	it("forwards retry.maxDelayMs while preserving caller overrides", () => {
		const settings = Settings.isolated({ "retry.maxDelayMs": 300_000 });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);
		wrapped(stubModel, stubContext, { maxRetryDelayMs: 5_000 });

		expect(calls[0]?.options?.maxRetryDelayMs).toBe(300_000);
		expect(calls[1]?.options?.maxRetryDelayMs).toBe(5_000);
	});

	it("treats the default openrouterVariant as absent so the base call carries no variant", () => {
		const settings = Settings.isolated({ "providers.openrouterVariant": "default" });
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, undefined);

		expect(calls[0]?.options?.openrouterVariant).toBeUndefined();
	});

	it("forwards configured cache retention, leaves auto unset, and lets callers override", () => {
		const auto = captureBase();
		createSettingsAwareStreamFn(Settings.isolated({}), auto.fn)(stubModel, stubContext, undefined);
		// auto must stay unset so provider defaults and PI_CACHE_RETENTION apply
		expect(auto.calls[0]?.options?.cacheRetention).toBeUndefined();

		const long = captureBase();
		const settings = Settings.isolated({ "providers.cacheRetention": "long" });
		const wrapped = createSettingsAwareStreamFn(settings, long.fn);
		wrapped(stubModel, stubContext, undefined);
		expect(long.calls[0]?.options?.cacheRetention).toBe("long");

		wrapped(stubModel, stubContext, { cacheRetention: "none" });
		expect(long.calls[1]?.options?.cacheRetention).toBe("none");
	});

	it("lets caller-supplied options override the session settings", () => {
		const settings = Settings.isolated({
			"providers.openrouterVariant": "floor",
			"providers.antigravityEndpoint": "sandbox",
			"providers.maxInFlightRequests": { openrouter: 4 },
			"model.loopGuard.enabled": true,
		});
		const { fn: base, calls } = captureBase();
		const wrapped = createSettingsAwareStreamFn(settings, base);

		wrapped(stubModel, stubContext, {
			openrouterVariant: "nitro",
			antigravityEndpointMode: "production",
			maxInFlightRequests: { openrouter: 1 },
			loopGuard: { enabled: false },
			hideThinkingSummary: false,
		});

		const options = calls[0]?.options;
		expect(options?.openrouterVariant).toBe("nitro");
		expect(options?.antigravityEndpointMode).toBe("production");
		expect(options?.maxInFlightRequests).toEqual({ openrouter: 1 });
		// Loop guard merges per-field: caller wins on `enabled`, settings fill
		// the rest (the inline closure the main agent used has the same shape).
		expect(options?.loopGuard?.enabled).toBe(false);
		expect(options?.loopGuard?.checkAssistantContent).toBe(true);
		expect(options?.hideThinkingSummary).toBe(false);
	});
	describe("providers.anthropic.serverSideFallback (opt-in)", () => {
		const stubFableModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-fable-5",
		} as unknown as Model;
		const stubOpusModel = {
			api: "anthropic-messages",
			provider: "anthropic",
			id: "claude-opus-4-8",
		} as unknown as Model;

		it("stays off by default: no fallbacks injected on any model", () => {
			const settings = Settings.isolated({});
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("injects Opus 4.8 fallback for Fable when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
		});

		it("does NOT inject fallbacks on non-Fable/Mythos Anthropic models even when the setting is on", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubOpusModel, stubContext, { apiKey: "k" });

			expect(calls[0]?.options?.fallbacks).toBeUndefined();
		});

		it("caller-supplied fallbacks always win over the settings default", () => {
			const settings = Settings.isolated({ "providers.anthropic.serverSideFallback": true });
			const { fn: base, calls } = captureBase();
			const wrapped = createSettingsAwareStreamFn(settings, base);

			wrapped(stubFableModel, stubContext, {
				apiKey: "k",
				fallbacks: [{ model: "claude-sonnet-5" }],
			});

			expect(calls[0]?.options?.fallbacks).toEqual([{ model: "claude-sonnet-5" }]);
		});
	});
});
