import { expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { ContinuationBindingFactory } from "../src/session/continuation-binding";
import {
	bindContinuationStream,
	ContinuationAdmissionError,
	type ContinuationRequestBoundary,
} from "../src/session/continuation-request";
import { makeIsolationCommitMessage } from "../src/task/isolation-runner";
import type { ToolSession } from "../src/tools";
import { SpeechEnhancer } from "../src/tts/speech-enhancer";
import { anthropicSse } from "./fixtures/continuation/scripted-providers";

it("admits automatic isolation commit and speech requests, then sends neither while paused or unwrapped", async () => {
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			requests++;
			return anthropicSse("Preserve exact progress");
		},
	});
	try {
		const model = buildModel({
			provider: "anthropic",
			api: "anthropic-messages",
			id: "fixture",
			name: "Fixture",
			baseUrl: server.url.origin,
			reasoning: false,
			input: ["text"],
			contextWindow: 32000,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		const settings = Settings.isolated({ "task.isolation.commits": "ai" });
		settings.setModelRole("smol", "anthropic/fixture");
		settings.setModelRole("tiny", "anthropic/fixture");
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "synthetic-local-fixture",
			resolver: () => async () => "synthetic-local-fixture",
		} as unknown as ModelRegistry;
		let paused = false;
		const boundary: ContinuationRequestBoundary = {
			async admit() {
				if (paused) throw new ContinuationAdmissionError({ kind: "defer", reason: "Operator paused" });
				return {
					admitHttp: async () => ({ received: async () => {}, failed: async () => {} }),
					settle: async () => {},
					beforeRetryWait: async () => {},
				};
			},
		};
		const factory: ContinuationBindingFactory = {
			bindSession() {
				throw new Error("The auxiliary callback does not open sessions");
			},
		};
		const inferenceStreamFn = bindContinuationStream(streamSimple, boundary, "maintenance");
		const session = {
			settings,
			modelRegistry: registry,
			getSessionId: () => "auxiliary-fixture",
			continuationFactory: factory,
			inferenceStreamFn,
		} as unknown as ToolSession;
		const makeCommit = makeIsolationCommitMessage(session)();
		if (!makeCommit) throw new Error("AI isolation commits must be enabled in this fixture");
		const speech = new SpeechEnhancer({
			settings,
			registry,
			sessionId: "auxiliary-fixture",
			continuationEnrolled: true,
			inferenceStreamFn,
		});
		const diff = "diff --git a/file b/file\n+Preserve exact progress\n";
		expect(await makeCommit(diff)).toBe("Preserve exact progress");
		expect(await speech.rewrite("Preserve **exact progress**")).toBe("Preserve exact progress");
		expect(requests).toBe(2);

		paused = true;
		expect(await makeCommit(diff)).toBeNull();
		expect(await speech.rewrite("Do not send this block")).toBeNull();
		expect(requests).toBe(2);

		const unwrapped = makeIsolationCommitMessage({ ...session, inferenceStreamFn: undefined })();
		if (!unwrapped) throw new Error("The missing-stream case must still exercise the selected AI callback");
		expect(await unwrapped(diff)).toBeNull();
		const unwrappedSpeech = new SpeechEnhancer({
			settings,
			registry,
			sessionId: "auxiliary-fixture",
			continuationEnrolled: true,
		});
		expect(await unwrappedSpeech.rewrite("No admitted stream is available")).toBeNull();
		expect(requests).toBe(2);
	} finally {
		await server.stop(true);
	}
});
