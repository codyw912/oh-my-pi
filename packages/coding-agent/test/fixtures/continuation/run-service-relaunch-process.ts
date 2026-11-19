/**
 * Committed-successor relaunch in a fresh process. Recovers the owner session,
 * awaits AgentSession.whenContinuationReady(), then proves one native broker
 * completion is delivered to the successor owner.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { daemonClientForProject } from "../../../src/launch/client";
import type { DaemonCompletionNotification } from "../../../src/launch/protocol";
import { AgentSession } from "../../../src/session/agent-session";
import { openContinuationRun } from "../../../src/session/continuation-controller";
import type { ContinuationPolicyV1 } from "../../../src/session/continuation-policy";
import { convertToLlm } from "../../../src/session/messages";
import { SessionManager } from "../../../src/session/session-manager";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

interface ProcessConfig {
	cwd: string;
	sessionsDir: string;
	sessionFile: string;
	planPath: string;
	runId: string;
	policy: ContinuationPolicyV1;
	serviceName: string;
	readyPath: string;
	resultPath: string;
}

function writeJson(filePath: string, payload: unknown): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`);
}

const configPath = Bun.argv[2];
if (!configPath) throw new Error("run-service-relaunch-process requires a config path");
const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as ProcessConfig;

try {
	const manager = await SessionManager.open(config.sessionFile, config.sessionsDir);
	const source = config.policy.candidates[0];
	if (!source) throw new Error("Relaunch policy has no candidate");
	const run = await openContinuationRun({
		sessionManager: manager,
		planPath: config.planPath,
		policy: config.policy,
		source,
		recoverRunId: config.runId,
		workflow: {
			id: "service-relaunch",
			exportProjection: async () => {
				throw new Error("Relaunch recover must not re-export a projection");
			},
		},
		observeRequest: async () => ({
			account: source.account,
			dataScope: source.dataScope ?? "fixture",
			contextTokens: 8_192,
			allowances: [
				{
					provider: source.provider,
					account: source.account,
					window: "fixture-window",
					headroom: "healthy",
				},
			],
		}),
	});
	const model = buildModel({
		provider: "anthropic",
		api: "anthropic-messages",
		id: "pt08-relaunch",
		name: "PT-08 relaunch",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		contextWindow: 32_000,
		maxTokens: 256,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const authStorage = createInMemoryAuthStorage();
	authStorage.setRuntimeApiKey("anthropic", "synthetic-local-fixture");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "synthetic-local-fixture",
			initialState: { model, systemPrompt: ["PT-08 relaunch"], tools: [], messages: [] },
			convertToLlm,
			streamFn: streamSimple,
		}),
		sessionManager: manager,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"advisor.enabled": false,
			"retry.enabled": false,
			"memories.enabled": false,
			defaultThinkingLevel: "off",
		}),
		modelRegistry: new ModelRegistry(authStorage),
		thinkingLevel: ThinkingLevel.Off,
		continuationFactory: run,
		disableExtensionDiscovery: true,
	});
	await session.whenContinuationReady();

	const received: Array<{ owner: string; daemonOwner?: string; id: string; completionId: string }> = [];
	const delivered = Promise.withResolvers<void>();
	const original = session.queueLaunchCompletion.bind(session);
	session.queueLaunchCompletion = async (notification: DaemonCompletionNotification) => {
		received.push({
			owner: notification.owner,
			daemonOwner: notification.daemon.owner,
			id: notification.daemon.id,
			completionId: notification.completionId,
		});
		delivered.resolve();
		return original(notification);
	};

	writeJson(config.readyPath, {
		ok: true,
		sessionId: session.sessionManager.getSessionId(),
		pid: process.pid,
	});

	const client = await daemonClientForProject(config.cwd);
	const sent = await client.request({ op: "send", name: config.serviceName, data: "x" });
	if (sent.op !== "send") throw new Error(`expected send, got ${sent.op}`);
	await delivered.promise;

	writeJson(config.resultPath, {
		ok: true,
		sessionId: session.sessionManager.getSessionId(),
		received,
	});
	await session.dispose();
	await run.close();
	await manager.close();
	authStorage.close();
	process.exit(received.length === 1 ? 0 : 1);
} catch (error) {
	const payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
	writeJson(config.resultPath, payload);
	if (!fs.existsSync(config.readyPath)) writeJson(config.readyPath, payload);
	process.exit(1);
}
