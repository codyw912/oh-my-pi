import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { createNodeDurableIo, inspectCommittedRunState } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import {
	CASE_TIMEOUT_MS,
	DISCOVERY_SUMMARY,
	DRAFT_TEXT,
	NEXT_ACTION,
	OPEN_FINDING,
	PLAN_RELATIVE,
	PROTECTED_CONSTRAINT,
	QUEUED_INSTRUCTION,
	REJECTED_APPROACH,
	RETAINED_INSTRUCTION,
	ROLE_OBLIGATION,
	SOURCE_HISTORY_MARKER,
	openPortableHarness,
	payloadText,
	writeCaseEvidence,
} from "./fixtures/continuation/portable-session";
import { anthropicSse } from "./fixtures/continuation/scripted-providers";

const QUEUED_DEVELOPER = "QUEUED_DEVELOPER_INSTRUCTION";

describe("PT-00 AgentSession portable continuation", () => {
	it(
		"preserves arrival order across pending input queues",
		async () => {
			const h = await openPortableHarness();
			try {
				h.session.agent.followUp({ role: "user", content: "EARLIER_PENDING_INSTRUCTION", timestamp: 100 });
				h.session.agent.steer({ role: "user", content: "LATER_PENDING_INSTRUCTION", timestamp: 200 });
				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [],
					roleObligations: [],
					discoveries: [],
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				const staged = await SessionManager.open(prepared.session.sessionFile, h.sessionsDir);
				try {
					const context = JSON.stringify(staged.buildSessionContext().messages);
					expect(context.indexOf("EARLIER_PENDING_INSTRUCTION")).toBeGreaterThanOrEqual(0);
					expect(context.indexOf("LATER_PENDING_INSTRUCTION")).toBeGreaterThan(
						context.indexOf("EARLIER_PENDING_INSTRUCTION"),
					);
				} finally {
					await staged.close();
				}
				expect(h.endpoint.requests).toBe(0);
			} finally {
				await h.cleanup();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"settles suppressed work and carries its unread result into the successor",
		async () => {
			const h = await openPortableHarness(undefined, { asyncJobs: true });
			const finish = Promise.withResolvers<void>();
			try {
				const manager = h.session.asyncJobManager!;
				const started = Promise.withResolvers<void>();
				const jobId = manager.register(
					"task",
					"suppressed-review",
					async () => {
						started.resolve();
						await finish.promise;
						return "SUPPRESSED_REVIEW_RESULT";
					},
					{ ownerId: "pt00-owner" },
				);
				manager.suppressDeliveries([jobId]);
				await started.promise;
				const preparation = h.session.prepareContinuation({
					retainedInstructions: [],
					roleObligations: [],
					discoveries: [],
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				finish.resolve();
				const prepared = await preparation;
				expect(manager.isJobResultConsumed(jobId)).toBe(true);
				expect(h.run.getState().pendingEffects).toEqual([]);
				const staged = await SessionManager.open(prepared.session.sessionFile, h.sessionsDir);
				try {
					const context = JSON.stringify(staged.buildSessionContext().messages);
					expect(context.split("SUPPRESSED_REVIEW_RESULT").length - 1).toBe(1);
				} finally {
					await staged.close();
				}
				expect(h.endpoint.requests).toBe(0);
			} finally {
				finish.resolve();
				await h.cleanup();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"A: prepare then activate same-provider fresh session and prompt next action",
		async () => {
			const h = await openPortableHarness();
			try {
				const sourceId = h.session.sessionManager.getSessionId();
				const sourceFile = h.session.sessionManager.getSessionFile();
				if (!sourceFile) throw new Error("file-backed source session is required");
				const sourceGeneration = h.run.getState().owner.generation;
				const sourceRunId = h.run.getState().run.id;

				await h.session.sendUserMessage(QUEUED_INSTRUCTION, { deliverAs: "followUp" });
				await h.session.followUp(QUEUED_DEVELOPER, undefined, {
					synthetic: true,
					expandPromptTemplates: false,
				});

				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				expect(prepared.ticket.runId).toBe(sourceRunId);
				expect(prepared.ticket.sourceSessionId).toBe(sourceId);
				expect(prepared.session.sessionId).not.toBe(sourceId);

				const unboundManager = await SessionManager.open(prepared.session.sessionFile, h.sessionsDir);
				const unboundAuth = createInMemoryAuthStorage();
				try {
					expect(
						() =>
							new AgentSession({
								agent: new Agent({
									initialState: {
										model: h.model,
										systemPrompt: ["unbound"],
										tools: [],
										messages: [],
									},
									convertToLlm,
								}),
								sessionManager: unboundManager,
								settings: Settings.isolated({
									"compaction.enabled": false,
									"todo.enabled": false,
									defaultThinkingLevel: "off",
								}),
								modelRegistry: new ModelRegistry(unboundAuth),
								thinkingLevel: ThinkingLevel.Off,
								disableExtensionDiscovery: true,
							}),
					).toThrow(/enrolled continuation session requires its explicit committed run controller/i);
				} finally {
					unboundAuth.close();
					await unboundManager.close();
				}

				const activated = await h.session.activateContinuation(prepared);
				expect(activated.runId).toBe(sourceRunId);
				expect(activated.sessionId).not.toBe(sourceId);
				expect(activated.sessionId).toBe(h.session.sessionManager.getSessionId());
				expect(activated.generation).toBeGreaterThan(sourceGeneration);
				expect(activated.draft).toBe(DRAFT_TEXT);
				expect(await h.session.sessionManager.consumeDraft()).toBe(DRAFT_TEXT);

				const sourceText = await fs.readFile(sourceFile, "utf8");
				expect(sourceText).toContain(SOURCE_HISTORY_MARKER);
				const destText = await fs.readFile(activated.sessionFile, "utf8");
				expect(destText).not.toContain(SOURCE_HISTORY_MARKER);
				expect(destText).toContain(QUEUED_INSTRUCTION);
				expect(destText).toContain(QUEUED_DEVELOPER);
				expect(destText).toContain(ROLE_OBLIGATION);
				const inspected = await inspectCommittedRunState({ worktree: h.root, planPath: PLAN_RELATIVE });
				expect(inspected.state.run.id).toBe(sourceRunId);
				expect(inspected.state.owner.sessionId).toBe(activated.sessionId);
				expect(inspected.state.owner.generation).toBe(activated.generation);
				expect(inspected.state.owner.generation).toBeGreaterThan(sourceGeneration);

				await h.session.prompt(NEXT_ACTION, {
					expandPromptTemplates: false,
					skipCompactionCheck: true,
				});

				expect(h.effects.completeTask1).toBe(0);
				expect(h.effects.reviewUnfinished).toBe(1);
				expect(h.endpoint.requests).toBeGreaterThan(0);
				expect(h.endpoint.requests).toBeLessThanOrEqual(32);

				const payload = payloadText(h.endpoint.bodies);
				expect(payload).toContain(PROTECTED_CONSTRAINT);
				expect(payload).toContain(OPEN_FINDING);
				expect(payload).toContain(REJECTED_APPROACH);
				expect(payload).toContain(NEXT_ACTION);
				expect(payload).toContain(QUEUED_INSTRUCTION);
				expect(payload).toContain(QUEUED_DEVELOPER);
				expect(payload).toContain(ROLE_OBLIGATION);
				expect(payload).toContain(RETAINED_INSTRUCTION);
				expect(payload).not.toContain(SOURCE_HISTORY_MARKER);
				expect(payload).not.toContain(DRAFT_TEXT);

				await writeCaseEvidence("pt00-case-a", {
					case: "A",
					runId: activated.runId,
					sourceSessionId: sourceId,
					destinationSessionId: activated.sessionId,
					sourceGeneration,
					destinationGeneration: activated.generation,
					requests: h.endpoint.requests,
					toolEffects: { ...h.effects },
					draftActivated: activated.draft === DRAFT_TEXT,
					payloadHasProtectedFacts: payload.includes(PROTECTED_CONSTRAINT) && payload.includes(OPEN_FINDING),
					payloadHasQueuedInstruction: payload.includes(QUEUED_INSTRUCTION),
					payloadHasObligations: payload.includes(ROLE_OBLIGATION),
					payloadHasHistoryDump: payload.includes(SOURCE_HISTORY_MARKER),
					payloadHasUnsentDraft: payload.includes(DRAFT_TEXT),
					predecessorTranscriptRetained: sourceText.includes(SOURCE_HISTORY_MARKER),
				});
			} finally {
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"B: operator pause during preparation rejects activation with zero endpoint and tool effects",
		async () => {
			const reachedStage = Promise.withResolvers<void>();
			const publishStage = Promise.withResolvers<void>();
			const io = createNodeDurableIo();
			let intercepted = false;
			const h = await openPortableHarness({
				...io,
				async rename(from, to) {
					await io.rename(from, to);
					if (intercepted || path.basename(to) !== "state.json") return;
					const state = JSON.parse(await fs.readFile(to, "utf8"));
					if (state.pendingHandoff?.phase !== "staged") return;
					intercepted = true;
					reachedStage.resolve();
					await publishStage.promise;
				},
			});
			try {
				const source = h.run.getState().owner;
				const prepareDone = h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				await reachedStage.promise;
				const pauseDone = h.run.setIntent({ kind: "pause", reason: "operator pause during preparation" });
				publishStage.resolve();
				const prepared = await prepareDone;
				await pauseDone;
				await expect(h.session.activateContinuation(prepared)).rejects.toThrow(
					/Operator intent|paused|activation/i,
				);
				expect(h.run.getState().owner).toEqual(source);

				expect(h.endpoint.requests).toBe(0);
				expect(h.effects.completeTask1).toBe(0);
				expect(h.effects.reviewUnfinished).toBe(0);

				await writeCaseEvidence("pt00-case-b", {
					case: "B",
					requests: h.endpoint.requests,
					toolEffects: { ...h.effects },
					intent: h.run.getState().intent,
				});
			} finally {
				publishStage.resolve();
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	for (const mutation of ["submitted instruction", "draft", "model", "policy"] as const) {
		it(
			`rejects a staged candidate after a ${mutation} change`,
			async () => {
				const h = await openPortableHarness();
				let draft = DRAFT_TEXT;
				try {
					const owner = h.run.getState().owner;
					const preparationOptions = {
						retainedInstructions: [RETAINED_INSTRUCTION],
						roleObligations: [ROLE_OBLIGATION],
						discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
						readDraft: () => draft,
						maxBriefingBytes: 256_000,
						settlementTimeoutMs: 5_000,
					};
					const prepared = await h.session.prepareContinuation(preparationOptions);
					switch (mutation) {
						case "submitted instruction":
							await h.session.followUp("Require another review before completing this task.");
							break;
						case "draft":
							draft = "Changed unsent draft after preparation";
							break;
						case "model":
							await h.session.setModelTemporary(
								{ ...h.model, id: "changed-model-after-preparation" },
								ThinkingLevel.Off,
							);
							expect(h.session.model?.id).toBe("changed-model-after-preparation");
							break;
						case "policy":
							h.policy.revision = "authorization-revoked-after-preparation";
							break;
					}
					await expect(h.session.activateContinuation(prepared)).rejects.toThrow();
					expect(h.run.getState().owner).toEqual(owner);
					expect(h.endpoint.requests).toBe(0);
					expect(h.effects).toEqual({ completeTask1: 0, reviewUnfinished: 0 });
					const evidence: Record<string, unknown> = {
						mutation,
						owner: h.run.getState().owner,
						stagedSession: prepared.session.sessionId,
						requests: h.endpoint.requests,
						toolEffects: { ...h.effects },
					};
					if (mutation === "submitted instruction") {
						await h.run
							.bindSession(h.manager, "primary")
							.handoff!.cancel(prepared.ticket, "Operator retries with the newly submitted instruction");
						const replacement = await h.session.prepareContinuation(preparationOptions);
						await h.session.activateContinuation(replacement);
						await h.session.prompt(NEXT_ACTION, { expandPromptTemplates: false, skipCompactionCheck: true });
						const payload = h.endpoint.bodies[0]!;
						expect(payload.split("Require another review before completing this task.").length - 1).toBe(1);
						expect(h.effects).toEqual({ completeTask1: 0, reviewUnfinished: 1 });
						evidence.retry = {
							owner: h.run.getState().owner,
							firstDestinationPayload: payload,
							toolEffects: { ...h.effects },
						};
					}
					await writeCaseEvidence(`pt01-stale-${mutation.replaceAll(" ", "-")}`, evidence);
				} finally {
					await h.cleanup();
				}
			},
			{ timeout: CASE_TIMEOUT_MS },
		);
	}

	it(
		"F6: a rejected committed destination stops without retry or predecessor resurrection",
		async () => {
			const h = await openPortableHarness();
			try {
				const predecessor = h.run.getState().owner;
				const options = {
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				};
				const activated = await h.session.continueOnApprovedDestination(options);
				const committed = h.run.getState().owner;
				expect(committed.sessionId).toBe(activated.sessionId);
				expect(committed.sessionId).not.toBe(predecessor.sessionId);
				h.endpoint.rejectNext(
					429,
					JSON.stringify({
						type: "error",
						error: { type: "insufficient_quota", message: "Usage limit reached" },
					}),
				);
				await h.session.prompt(NEXT_ACTION);
				await expect(h.session.continueOnApprovedDestination(options)).rejects.toThrow();
				expect(h.endpoint.requests).toBe(1);
				expect(h.effects).toEqual({ completeTask1: 0, reviewUnfinished: 0 });
				expect(h.run.getState().owner).toEqual(committed);
				expect(h.run.getState().stop?.kind).toBe("exhausted");
				await writeCaseEvidence("pt01-f6-destination-rejection", {
					predecessor,
					committed,
					owner: h.run.getState().owner,
					requests: h.endpoint.requests,
					payloads: h.endpoint.bodies,
					toolEffects: { ...h.effects },
					stop: h.run.getState().stop,
				});
			} finally {
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"F7: an inline plan change invalidates staged continuation without sending work",
		async () => {
			const h = await openPortableHarness();
			try {
				const owner = h.run.getState().owner;
				const prepared = await h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				await fs.appendFile(
					h.planPath,
					"\nNew operator constraint: require an additional review before completion.\n",
				);
				await expect(h.session.activateContinuation(prepared)).rejects.toThrow();
				expect(h.run.getState().owner).toEqual(owner);
				expect(h.endpoint.requests).toBe(0);
				expect(h.effects).toEqual({ completeTask1: 0, reviewUnfinished: 0 });
				await writeCaseEvidence("pt01-f7-inline", {
					owner: h.run.getState().owner,
					stagedSession: prepared.session.sessionId,
					requests: h.endpoint.requests,
					toolEffects: { ...h.effects },
					changedPlan: await fs.readFile(h.planPath, "utf8"),
				});
			} finally {
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);

	it(
		"settles a foreground write and carries mid-preparation input once",
		async () => {
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			const preparing = Promise.withResolvers<void>();
			const io = createNodeDurableIo();
			let outputPath = "";
			let aborted = false;
			let foregroundWrites = 0;
			const h = await openPortableHarness(
				{
					...io,
					async rename(from, to) {
						await io.rename(from, to);
						if (path.basename(to) !== "state.json") return;
						const state = JSON.parse(await fs.readFile(to, "utf8"));
						if (state.pendingHandoff?.phase === "preparing") preparing.resolve();
					},
				},
				{
					foregroundWrite: async signal => {
						foregroundWrites++;
						await fs.writeFile(outputPath, "started\n");
						entered.resolve();
						await finish.promise;
						aborted = signal?.aborted === true;
						await fs.appendFile(outputPath, "finished\n");
					},
				},
			);
			outputPath = path.join(h.root, "foreground-write.txt");
			const instruction = "MID_PREPARATION_INSTRUCTION preserve this foreground result.";
			let sourcePrompt: Promise<unknown> | undefined;
			let preparation: Promise<unknown> | undefined;
			try {
				sourcePrompt = h.session
					.prompt("Continue the existing review.", {
						expandPromptTemplates: false,
						skipCompactionCheck: true,
					})
					.catch(error => error);
				await entered.promise;
				const owner = h.run.getState().owner;
				const pending = h.session
					.prepareContinuation({
						retainedInstructions: [RETAINED_INSTRUCTION],
						roleObligations: [ROLE_OBLIGATION],
						discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
						maxBriefingBytes: 256_000,
						settlementTimeoutMs: 5_000,
					})
					.then(
						prepared => ({ prepared }),
						error => ({ error }),
					);
				preparation = pending;
				await preparing.promise;
				await h.session.followUp(instruction);
				expect(await fs.readFile(outputPath, "utf8")).toBe("started\n");
				expect(h.run.getState().owner).toEqual(owner);
				finish.resolve();
				const result = await pending;
				if ("error" in result) throw result.error;
				await sourcePrompt;
				expect(aborted).toBe(false);
				expect(await fs.readFile(outputPath, "utf8")).toBe("started\nfinished\n");
				expect(foregroundWrites).toBe(1);
				expect(h.effects.reviewUnfinished).toBe(0);
				await h.session.activateContinuation(result.prepared);
				const firstDestinationRequest = h.endpoint.requests;
				await h.session.prompt(NEXT_ACTION, { expandPromptTemplates: false, skipCompactionCheck: true });
				const payload = h.endpoint.bodies[firstDestinationRequest]!;
				expect(payload.split(instruction).length - 1).toBe(1);
				expect(foregroundWrites).toBe(1);
				expect(h.effects.reviewUnfinished).toBe(1);
				expect(h.effects.completeTask1).toBe(0);
				await writeCaseEvidence("pt01-foreground-preparation-input", {
					sourceOwner: owner,
					successorOwner: h.run.getState().owner,
					foregroundWrite: await fs.readFile(outputPath, "utf8"),
					foregroundWrites,
					aborted,
					firstDestinationPayload: payload,
					toolEffects: { ...h.effects },
				});
			} finally {
				finish.resolve();
				await sourcePrompt;
				await preparation;
				await h.cleanup();
			}
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"expires settlement without canceling active work or replacing its owner",
		async () => {
			const h = await openPortableHarness();
			const entered = Promise.withResolvers<void>();
			const finish = Promise.withResolvers<void>();
			let promptDone: Promise<unknown> | undefined;
			try {
				h.session.agent.setBeforeModelCall(async () => {
					entered.resolve();
					await finish.promise;
					throw new Error("fixture finishes without dispatch");
				});
				promptDone = h.session
					.prompt("existing review", { expandPromptTemplates: false, skipCompactionCheck: true })
					.catch(() => undefined);
				await entered.promise;
				const owner = h.run.getState().owner;
				await expect(
					h.session.prepareContinuation({
						retainedInstructions: [],
						roleObligations: [],
						discoveries: [],
						maxBriefingBytes: 256_000,
						settlementTimeoutMs: 20,
					}),
				).rejects.toThrow("settlement budget expired");
				expect(h.run.getState().owner).toEqual(owner);
				expect(h.run.getState().pendingHandoff).toBeNull();
				expect(h.session.isStreaming).toBe(true);
				expect(h.endpoint.requests).toBe(0);
			} finally {
				finish.resolve();
				await promptDone;
				await h.cleanup();
			}
		},
		CASE_TIMEOUT_MS,
	);
	it(
		"preserves protected continuation inputs through real soft compaction and the next request",
		async () => {
			const h = await openPortableHarness();
			try {
				await h.session.sendUserMessage(QUEUED_INSTRUCTION, { deliverAs: "followUp" });
				await h.session.activateContinuation(
					await h.session.prepareContinuation({
						retainedInstructions: [RETAINED_INSTRUCTION],
						roleObligations: [ROLE_OBLIGATION],
						discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
						maxBriefingBytes: 256_000,
						settlementTimeoutMs: 5_000,
					}),
				);
				const owner = h.run.getState().owner;
				const projection = h.run.getProjection();
				h.endpoint.respondNext(anthropicSse("Ready to review; no work has been approved."));
				await h.session.prompt("Inspect the existing review context without executing tools.", {
					expandPromptTemplates: false,
					skipCompactionCheck: true,
				});
				h.session.settings.set("compaction.keepRecentTokens", 0);
				h.session.settings.set("compaction.reserveTokens", 4096);
				h.endpoint.respondNext(anthropicSse("Checkpoint summary deliberately omits workflow details."));
				await h.session.compact(undefined, { mode: "soft" });
				const afterCompaction = h.endpoint.requests;
				await h.session.prompt(NEXT_ACTION, { expandPromptTemplates: false, skipCompactionCheck: true });
				const payload = h.endpoint.bodies[afterCompaction]!;
				for (const fact of [
					PROTECTED_CONSTRAINT,
					OPEN_FINDING,
					REJECTED_APPROACH,
					NEXT_ACTION,
					RETAINED_INSTRUCTION,
					ROLE_OBLIGATION,
				]) {
					expect(payload).toContain(fact);
				}
				expect(payload.split(QUEUED_INSTRUCTION).length - 1).toBe(1);
				expect(payload).not.toContain(SOURCE_HISTORY_MARKER);
				expect(h.effects).toEqual({ completeTask1: 0, reviewUnfinished: 1 });
				expect(h.run.getState().owner).toEqual(owner);
				expect(h.run.getProjection()).toEqual(projection);
				await writeCaseEvidence("pt09-compaction-protected-context", {
					owner,
					projection,
					afterCompactionPayload: payload,
					requests: h.endpoint.requests,
					toolEffects: { ...h.effects },
				});
			} finally {
				await h.cleanup();
			}
		},
		CASE_TIMEOUT_MS,
	);
});
