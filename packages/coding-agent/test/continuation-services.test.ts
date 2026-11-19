import { describe, expect, it } from "bun:test";
import * as events from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { daemonClientForProject, inspectProjectDaemons } from "@oh-my-pi/pi-coding-agent/launch/client";
import { daemonBrokerEndpoint, daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import type { DaemonCompletionNotification } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { openContinuationRun } from "@oh-my-pi/pi-coding-agent/session/continuation-controller";
import {
	bindContinuationCompletionOwners,
	routeContinuationCompletions,
	verifyContinuationServices,
} from "@oh-my-pi/pi-coding-agent/session/continuation-handoff";
import { LAUNCH_COMPLETION_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/session/launch-completion";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	CASE_TIMEOUT_MS,
	DISCOVERY_SUMMARY,
	DRAFT_TEXT,
	PLAN_RELATIVE,
	RETAINED_INSTRUCTION,
	ROLE_OBLIGATION,
	openPortableHarness,
} from "./fixtures/continuation/portable-session";

const SERVICE_NAME = "portable-svc";

function serviceSpec(cwd: string) {
	return {
		name: SERVICE_NAME,
		application: process.execPath,
		// Child stays alive on stdin, not a test-side timer. Broker readiness is the start RPC.
		args: ["-e", "process.stdout.write('ready\\n'); process.stdin.resume();"],
		env: {},
		cwd,
		pty: false,
		ready: { log: "ready", timeoutMs: 10_000 },
		restart: "no" as const,
		persist: true,
		detached: false,
	};
}

function exitingServiceSpec(cwd: string, name = "portable-exit") {
	return {
		name,
		application: process.execPath,
		args: [
			"-e",
			"process.stdout.write('ready\\n'); process.stdin.once('data', () => process.exit(0)); process.stdin.resume();",
		],
		env: {},
		cwd,
		pty: false,
		ready: { log: "ready", timeoutMs: 10_000 },
		restart: "no" as const,
		persist: true,
		detached: false,
	};
}

function launchCompletionDaemons(session: AgentSession): Array<{ id: string; name: string; owner?: string }> {
	const daemons: Array<{ id: string; name: string; owner?: string }> = [];
	for (const message of session.agent.state.messages) {
		if (message.role !== "custom" || message.customType !== LAUNCH_COMPLETION_MESSAGE_TYPE) continue;
		const details = message.details as { daemons?: Array<{ id: string; name: string; owner?: string }> } | undefined;
		for (const daemon of details?.daemons ?? []) daemons.push(daemon);
	}
	return daemons;
}

async function waitForLaunchCompletion(session: AgentSession, name: string) {
	await session.waitForIdle();
	const found = launchCompletionDaemons(session).filter(daemon => daemon.name === name);
	if (found.length > 0) return found;
	await session.waitForIdle();
	const again = launchCompletionDaemons(session).filter(daemon => daemon.name === name);
	if (again.length > 0) return again;
	throw new Error(`Timed out waiting for launch completion of ${name}`);
}

function waitForJsonFile(filePath: string): Promise<unknown> {
	if (fs.existsSync(filePath)) return Promise.resolve(JSON.parse(fs.readFileSync(filePath, "utf8")));
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	const watcher = fs.watch(path.dirname(filePath), () => {
		if (!fs.existsSync(filePath)) return;
		watcher.close();
		try {
			resolve(JSON.parse(fs.readFileSync(filePath, "utf8")));
		} catch (error) {
			reject(error);
		}
	});
	if (fs.existsSync(filePath)) {
		watcher.close();
		return Promise.resolve(JSON.parse(fs.readFileSync(filePath, "utf8")));
	}
	return promise;
}

describe("PT-08 live project service continuation", () => {
	it(
		"preserves a verified hub service across fresh continuation and successor access",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			try {
				expect(await inspectProjectDaemons(h.root)).toBeUndefined();

				const started = await client.request({
					op: "start",
					spec: serviceSpec(h.root),
					owner: h.session.sessionManager.getSessionId(),
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				expect(started.daemon.name).toBe(SERVICE_NAME);
				expect(started.daemon.id).toBeTruthy();
				const identity = {
					name: started.daemon.name,
					id: started.daemon.id,
					pid: started.daemon.pid,
					startedAt: started.daemon.startedAt,
					owner: started.daemon.owner,
					persist: started.daemon.persist,
					detached: started.daemon.detached,
				};

				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				expect(prepared.briefing.text).toContain(SERVICE_NAME);
				expect(prepared.briefing.text).toContain(identity.id);
				expect(prepared.briefing.text).not.toContain(process.execPath);
				const staged = await SessionManager.open(prepared.session.sessionFile, h.sessionsDir);
				try {
					expect(staged.getContinuationServices()).toEqual([
						{
							name: identity.name,
							id: identity.id,
							...(identity.pid !== undefined ? { pid: identity.pid } : {}),
							startedAt: identity.startedAt,
							...(identity.owner !== undefined ? { owner: identity.owner } : {}),
							persist: identity.persist,
							detached: identity.detached,
						},
					]);
				} finally {
					await staged.close();
				}

				const activated = await h.session.activateContinuation(prepared);
				expect(activated.sessionId).toBe(h.session.sessionManager.getSessionId());
				expect(h.session.sessionManager.getContinuationServices()[0]?.id).toBe(identity.id);

				const successorClient = await daemonClientForProject(h.session.sessionManager.getCwd());
				const described = await successorClient.request({ op: "describe", name: SERVICE_NAME });
				if (described.op !== "describe") throw new Error(`expected describe, got ${described.op}`);
				expect(described.daemon.id).toBe(identity.id);
				expect(described.daemon.startedAt).toBe(identity.startedAt);
				expect(described.daemon.state === "ready" || described.daemon.state === "running").toBe(true);
				expect(described.spec.application).toBe(process.execPath);
			} finally {
				try {
					await client.request({ op: "stop", name: SERVICE_NAME, timeoutMs: 5_000 });
				} catch {
					//
				}
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"rejects commit when a captured service disappears",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			try {
				const started = await client.request({
					op: "start",
					spec: serviceSpec(h.root),
					owner: h.session.sessionManager.getSessionId(),
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				const stopped = await client.request({ op: "stop", name: SERVICE_NAME, timeoutMs: 5_000 });
				if (stopped.op !== "stop") throw new Error(`expected stop, got ${stopped.op}`);
				const replacement = await client.request({
					op: "start",
					spec: serviceSpec(h.root),
					owner: "foreign-session",
				});
				if (replacement.op !== "start") throw new Error(`expected start, got ${replacement.op}`);

				await expect(h.session.activateContinuation(prepared)).rejects.toThrow(
					/Handoff inputs changed|no longer available|could not be established/,
				);
				expect(h.session.sessionManager.getSessionId()).toBe(prepared.ticket.sourceSessionId);

				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") throw new Error(`expected list, got ${listed.op}`);
				expect(
					listed.daemons.some(
						daemon => daemon.id === started.daemon.id && (daemon.state === "ready" || daemon.state === "running"),
					),
				).toBe(false);
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"keeps ordinary no-service handoffs and fails closed without spawning a broker",
		async () => {
			const h = await openPortableHarness();
			try {
				expect(await inspectProjectDaemons(h.root)).toBeUndefined();
				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				const staged = await SessionManager.open(prepared.session.sessionFile, h.sessionsDir);
				try {
					expect(staged.getContinuationServices()).toEqual([]);
				} finally {
					await staged.close();
				}
				const activated = await h.session.activateContinuation(prepared);
				expect(activated.sessionId).toBe(h.session.sessionManager.getSessionId());
				expect(await inspectProjectDaemons(h.root)).toBeUndefined();
			} finally {
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"rejects retained service handles when their broker is missing",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			try {
				const started = await client.request({
					op: "start",
					spec: serviceSpec(h.root),
					owner: h.session.sessionManager.getSessionId(),
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				const staged = await SessionManager.open(prepared.session.sessionFile, h.sessionsDir);
				try {
					const expected = staged.getContinuationServices();
					expect(expected).toHaveLength(1);
					const socket = net.createConnection(daemonBrokerEndpoint(h.root, daemonRuntimeDir(h.root)));
					await events.once(socket, "connect");
					const closed = events.once(socket, "close");
					await client.request({ op: "shutdown" });
					await closed;
					client.close();
					expect(await inspectProjectDaemons(h.root)).toBeUndefined();
					await expect(verifyContinuationServices(h.root, expected)).rejects.toThrow(
						/could not be established|no longer available/,
					);
				} finally {
					await staged.close();
				}
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"delivers a real broker completion once to the successor after handoff",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			const exitName = "portable-exit";
			try {
				const sourceOwner = h.session.sessionManager.getSessionId();
				client.onCompletion(sourceOwner, notification => h.session.queueLaunchCompletion(notification));
				const started = await client.request({
					op: "start",
					spec: exitingServiceSpec(h.root, exitName),
					owner: sourceOwner,
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				expect(started.daemon.owner).toBe(sourceOwner);

				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				const activated = await h.session.activateContinuation(prepared);
				expect(activated.sessionId).not.toBe(sourceOwner);
				expect(
					h.session.sessionManager
						.getContinuationCompletionRouting()
						?.routes.some(route => route.id === started.daemon.id),
				).toBe(true);

				const successorOwner = h.session.sessionManager.getSessionId();
				const received: Array<{ owner: string; daemonOwner?: string; id: string }> = [];
				const delivered = Promise.withResolvers<void>();
				client.onCompletion(successorOwner, async notification => {
					received.push({
						owner: notification.owner,
						daemonOwner: notification.daemon.owner,
						id: notification.daemon.id,
					});
					await h.session.queueLaunchCompletion(notification);
					delivered.resolve();
				});
				const sent = await client.request({ op: "send", name: exitName, data: "x" });
				if (sent.op !== "send") throw new Error(`expected send, got ${sent.op}`);
				await delivered.promise;
				expect(received).toEqual([{ owner: successorOwner, daemonOwner: sourceOwner, id: started.daemon.id }]);

				const described = await client.request({ op: "describe", name: exitName });
				if (described.op !== "describe") throw new Error(`expected describe, got ${described.op}`);
				expect(described.daemon.owner).toBe(sourceOwner);
				expect(described.daemon.id).toBe(started.daemon.id);

				const routing = h.session.sessionManager.getContinuationCompletionRouting();
				if (!routing) throw new Error("missing continuation completion routing");
				await routeContinuationCompletions(h.root, routing);
				await bindContinuationCompletionOwners(h.root, [successorOwner], notification =>
					h.session.queueLaunchCompletion(notification),
				);
				await h.session.waitForIdle();
				expect(received).toHaveLength(1);
				const injected = await waitForLaunchCompletion(h.session, exitName);
				expect(new Set(injected.map(daemon => daemon.id)).size).toBe(1);
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"keeps a completion that arrives during commit and does not steal a foreign project service",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			const foreignDir = TempDir.createSync("pt08-foreign-project");
			const foreignRoot = fs.realpathSync(foreignDir.path());
			const foreignClient = await daemonClientForProject(foreignRoot);
			const exitName = "portable-exit";
			try {
				const sourceOwner = h.session.sessionManager.getSessionId();
				client.onCompletion(sourceOwner, notification => h.session.queueLaunchCompletion(notification));
				const started = await client.request({
					op: "start",
					spec: exitingServiceSpec(h.root, exitName),
					owner: sourceOwner,
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				const foreign = await foreignClient.request({
					op: "start",
					spec: exitingServiceSpec(foreignRoot, "foreign-exit"),
					owner: "foreign-owner",
				});
				if (foreign.op !== "start") throw new Error(`expected start, got ${foreign.op}`);

				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				const exiting = client.request({ op: "send", name: exitName, data: "x" });
				const activated = await h.session.activateContinuation(prepared);
				await exiting;
				expect(activated.sessionId).toBe(h.session.sessionManager.getSessionId());

				await waitForLaunchCompletion(h.session, exitName);
				expect(launchCompletionDaemons(h.session).filter(daemon => daemon.id === started.daemon.id)).toHaveLength(
					1,
				);

				await foreignClient.request({ op: "send", name: "foreign-exit", data: "x" });
				await h.session.waitForIdle();
				expect(launchCompletionDaemons(h.session).some(daemon => daemon.name === "foreign-exit")).toBe(false);
				await expect(
					client.request({
						op: "route-completion",
						name: "foreign-exit",
						id: foreign.daemon.id,
						startedAt: foreign.daemon.startedAt,
						fromOwner: "foreign-owner",
						toOwner: activated.sessionId,
					}),
				).rejects.toThrow();
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				try {
					await foreignClient.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
				await foreignDir.remove();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"relaunches a committed successor in a new process and delivers one native completion",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			const exitName = "portable-exit";
			const fixture = path.join(import.meta.dir, "fixtures/continuation/run-service-relaunch-process.ts");
			const readyPath = path.join(h.root, "relaunch-ready.json");
			const resultPath = path.join(h.root, "relaunch-result.json");
			const configPath = path.join(h.root, "relaunch-config.json");
			try {
				const sourceOwner = h.session.sessionManager.getSessionId();
				client.onCompletion(sourceOwner, notification => h.session.queueLaunchCompletion(notification));
				const started = await client.request({
					op: "start",
					spec: exitingServiceSpec(h.root, exitName),
					owner: sourceOwner,
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				const activated = await h.session.activateContinuation(prepared);
				const runId = h.run.getState().run.id;
				fs.writeFileSync(
					configPath,
					`${JSON.stringify({
						cwd: h.root,
						sessionsDir: h.sessionsDir,
						sessionFile: activated.sessionFile,
						planPath: PLAN_RELATIVE,
						runId,
						policy: h.policy,
						serviceName: exitName,
						readyPath,
						resultPath,
					})}\n`,
				);
				await h.session.dispose();
				await h.run.close();

				const child = Bun.spawn([process.execPath, fixture, configPath], {
					cwd: h.root,
					stdout: "ignore",
					stderr: "pipe",
				});
				const ready = (await waitForJsonFile(readyPath)) as { ok?: boolean; sessionId?: string };
				expect(ready.ok).toBe(true);
				expect(ready.sessionId).toBe(activated.sessionId);
				const exitCode = await child.exited;
				const result = (await waitForJsonFile(resultPath)) as {
					ok?: boolean;
					sessionId?: string;
					received?: Array<{ owner: string; daemonOwner?: string; id: string; completionId: string }>;
				};
				expect(exitCode).toBe(0);
				expect(result.ok).toBe(true);
				expect(result.sessionId).toBe(activated.sessionId);
				expect(result.received).toHaveLength(1);
				expect(result.received?.[0]?.id).toBe(started.daemon.id);
				expect(result.received?.[0]?.owner).toBe(activated.sessionId);
				expect(result.received?.[0]?.daemonOwner).toBe(sourceOwner);
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"delivers one completion to the latest successor after two handoffs",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			const exitName = "portable-exit";
			try {
				const sourceOwner = h.session.sessionManager.getSessionId();
				client.onCompletion(sourceOwner, notification => h.session.queueLaunchCompletion(notification));
				const started = await client.request({
					op: "start",
					spec: exitingServiceSpec(h.root, exitName),
					owner: sourceOwner,
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				const first = await h.session.activateContinuation(
					await h.session.prepareContinuation({
						retainedInstructions: [RETAINED_INSTRUCTION],
						roleObligations: [ROLE_OBLIGATION],
						discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
						readDraft: () => DRAFT_TEXT,
						maxBriefingBytes: 256_000,
						settlementTimeoutMs: 5_000,
					}),
				);
				await h.session.whenContinuationReady();
				const firstSuccessor = first.sessionId;
				expect(firstSuccessor).not.toBe(sourceOwner);

				const second = await h.session.activateContinuation(
					await h.session.prepareContinuation({
						retainedInstructions: [RETAINED_INSTRUCTION],
						roleObligations: [ROLE_OBLIGATION],
						discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
						readDraft: () => DRAFT_TEXT,
						maxBriefingBytes: 256_000,
						settlementTimeoutMs: 5_000,
					}),
				);
				await h.session.whenContinuationReady();
				expect(second.sessionId).not.toBe(firstSuccessor);
				const routing = h.session.sessionManager.getContinuationCompletionRouting();
				expect(routing?.sourceSessionId).toBe(firstSuccessor);
				expect(routing?.successorSessionId).toBe(second.sessionId);
				expect(routing?.routes).toEqual([
					{
						name: exitName,
						id: started.daemon.id,
						startedAt: started.daemon.startedAt,
						fromOwner: firstSuccessor,
						toOwner: second.sessionId,
					},
				]);

				const received: Array<{ owner: string; daemonOwner?: string; id: string }> = [];
				const delivered = Promise.withResolvers<void>();
				const original = h.session.queueLaunchCompletion.bind(h.session);
				h.session.queueLaunchCompletion = async notification => {
					received.push({
						owner: notification.owner,
						daemonOwner: notification.daemon.owner,
						id: notification.daemon.id,
					});
					delivered.resolve();
					return original(notification);
				};
				const sent = await client.request({ op: "send", name: exitName, data: "x" });
				if (sent.op !== "send") throw new Error(`expected send, got ${sent.op}`);
				await delivered.promise;
				expect(received).toEqual([{ owner: second.sessionId, daemonOwner: sourceOwner, id: started.daemon.id }]);
				const described = await client.request({ op: "describe", name: exitName });
				if (described.op !== "describe") throw new Error(`expected describe, got ${described.op}`);
				expect(described.daemon.owner).toBe(sourceOwner);
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"does not duplicate a persisted completion after reload or concurrent replay",
		async () => {
			const h = await openPortableHarness();
			const client = await daemonClientForProject(h.root);
			const exitName = "portable-exit";
			try {
				const sourceOwner = h.session.sessionManager.getSessionId();
				client.onCompletion(sourceOwner, notification => h.session.queueLaunchCompletion(notification));
				const started = await client.request({
					op: "start",
					spec: exitingServiceSpec(h.root, exitName),
					owner: sourceOwner,
				});
				if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
				const activated = await h.session.activateContinuation(
					await h.session.prepareContinuation({
						retainedInstructions: [RETAINED_INSTRUCTION],
						roleObligations: [ROLE_OBLIGATION],
						discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
						readDraft: () => DRAFT_TEXT,
						maxBriefingBytes: 256_000,
						settlementTimeoutMs: 5_000,
					}),
				);
				await h.session.whenContinuationReady();
				const received = Promise.withResolvers<DaemonCompletionNotification>();
				const unregister = client.onCompletion(activated.sessionId, async notification => {
					received.resolve(notification);
					await h.session.queueLaunchCompletion(notification);
				});
				await client.request({ op: "send", name: exitName, data: "x" });
				const replay = await received.promise;
				await waitForLaunchCompletion(h.session, exitName);
				unregister({ preservePending: true });
				await Promise.all([
					h.session.queueLaunchCompletion({ ...replay, completionId: "concurrent-a" }),
					h.session.queueLaunchCompletion({ ...replay, completionId: "concurrent-b" }),
				]);
				expect(
					h.session.sessionManager.hasLaunchCompletionReceipt({
						id: started.daemon.id,
						startedAt: started.daemon.startedAt,
					}),
				).toBe(true);
				const sessionFile = h.session.sessionManager.getSessionFile();
				if (!sessionFile) throw new Error("missing successor session file");
				await h.session.dispose();
				await h.run.close();
				await h.session.sessionManager.close();

				const manager = await SessionManager.open(sessionFile, h.sessionsDir);
				const recoveredRun = await openContinuationRun({
					...h.run.options,
					sessionManager: manager,
					source: activated.destination,
					recoverRunId: activated.runId,
				});
				const reloaded = new AgentSession({
					agent: new Agent({
						getApiKey: () => "synthetic-local-fixture",
						initialState: {
							model: h.model,
							systemPrompt: ["PT-08 reload"],
							tools: [],
							messages: [],
						},
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
					modelRegistry: new ModelRegistry(h.authStorage),
					thinkingLevel: ThinkingLevel.Off,
					continuationFactory: recoveredRun,
					disableExtensionDiscovery: true,
				});
				try {
					await reloaded.whenContinuationReady();
					expect(
						manager.hasLaunchCompletionReceipt({
							id: started.daemon.id,
							startedAt: started.daemon.startedAt,
						}),
					).toBe(true);
					await reloaded.queueLaunchCompletion({
						...replay,
						completionId: "replay-after-reload",
					});
					const receipts = manager
						.getBranch()
						.filter(item => item.type === "custom_message" && item.customType === LAUNCH_COMPLETION_MESSAGE_TYPE);
					expect(receipts).toHaveLength(1);
				} finally {
					await reloaded.dispose();
					await recoveredRun.close();
					await manager.close();
				}
			} finally {
				try {
					await client.request({ op: "shutdown" });
				} catch {
					//
				}
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);
});
