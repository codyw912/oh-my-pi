/**
 * Advisor reinitialization aborts an already-dispatched scripted request.
 * Its unknown outcome must fence handoff without losing the unfinished review.
 * Local synthetic transport only; not evidence of model competence.
 */
import { describe, expect, it, spyOn } from "bun:test";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { inspectCommittedRunState } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { SessionAdvisors } from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import {
	CASE_TIMEOUT_MS,
	DISCOVERY_SUMMARY,
	DRAFT_TEXT,
	NEXT_ACTION,
	OPEN_FINDING,
	PLAN_RELATIVE,
	PROTECTED_CONSTRAINT,
	REJECTED_APPROACH,
	RETAINED_INSTRUCTION,
	ROLE_OBLIGATION,
	openPortableHarness,
	payloadText,
	writeCaseEvidence,
} from "./fixtures/continuation/portable-session";
import { anthropicSse } from "./fixtures/continuation/scripted-providers";

const SEED_TURN = "Begin Task 2 review without assuming OPEN_FINDING is approved.";
const ADVISOR_REINIT_PROMPT = "Advisor reinitialized during continuation settlement.";

async function readFetchBody(input: Parameters<FetchImpl>[0], init?: Parameters<FetchImpl>[1]): Promise<string> {
	if (typeof init?.body === "string") return init.body;
	if (init?.body instanceof Uint8Array) return new TextDecoder().decode(init.body);
	if (input instanceof Request) return input.clone().text();
	return "";
}

function installScriptedFetch(agent: Agent, fetch: FetchImpl): () => void {
	const previous = agent.streamFn;
	agent.streamFn = (model, context, options) => previous(model, context, { ...options, fetch });
	return () => {
		agent.streamFn = previous;
	};
}

function abortableResponse(signal: AbortSignal | undefined, response: Promise<Response>): Promise<Response> {
	if (!signal) return response;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const onAbort = () => reject(signal.reason ?? new Error("aborted"));
	signal.addEventListener("abort", onAbort, { once: true });
	response.then(
		value => {
			signal.removeEventListener("abort", onAbort);
			resolve(value);
		},
		error => {
			signal.removeEventListener("abort", onAbort);
			reject(error);
		},
	);
	return promise;
}

describe("PT-00 AgentSession advisor continuation", () => {
	it(
		"preserves review obligations and blocks handoff after advisor reinitialization aborts a dispatched request",
		async () => {
			const h = await openPortableHarness();
			const advisorBodies: string[] = [];
			const seedBodies: string[] = [];
			let advisorRequests = 0;
			let seedRequests = 0;
			const advisorHeld = Promise.withResolvers<void>();
			const advisorRelease = Promise.withResolvers<Response>();
			const pauseEntered = Promise.withResolvers<void>();
			const originalPause = SessionAdvisors.prototype.pauseForContinuation;
			const pauseSpy = spyOn(SessionAdvisors.prototype, "pauseForContinuation").mockImplementation(
				async function (this: SessionAdvisors) {
					const waiting = originalPause.call(this);
					pauseEntered.resolve();
					return waiting;
				},
			);
			try {
				const authorizedModel = h.model;
				h.session.modelRegistry.registerProvider("anthropic", {
					api: "anthropic-messages",
					apiKey: "synthetic-local-fixture",
					baseUrl: h.endpoint.origin,
					models: [
						{
							id: authorizedModel.id,
							name: authorizedModel.name,
							api: "anthropic-messages",
							reasoning: false,
							input: ["text"],
							supportsTools: true,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32_000,
							maxTokens: 4096,
						},
					],
				});
				h.session.settings.setModelRole("advisor", `${authorizedModel.provider}/${authorizedModel.id}:off`);
				h.session.settings.set("advisor.syncBacklog", "off");
				expect(h.session.setAdvisorEnabled(true)).toBe(true);
				expect(h.session.isAdvisorActive()).toBe(true);

				const advisor = h.session.getAdvisorAgent();
				if (!advisor) throw new Error("Expected the advisor runtime to attach");
				expect(advisor.state.model.id).toBe(authorizedModel.id);
				expect(advisor.state.model.provider).toBe(authorizedModel.provider);
				expect(advisor.state.model.baseUrl).toBe(authorizedModel.baseUrl);
				advisor.subscribe(event => {
					if (event.type === "agent_end" && advisorRequests === 0) {
						advisorHeld.reject(
							new Error(`Advisor ended before its scripted request: ${JSON.stringify(event.messages)}`),
						);
					}
				});
				void advisorHeld.promise.catch(() => {});

				installScriptedFetch(advisor, async (input, init) => {
					advisorRequests += 1;
					advisorBodies.push(await readFetchBody(input, init));
					if (advisorRequests === 1) {
						advisorHeld.resolve();
						return abortableResponse(init?.signal ?? undefined, advisorRelease.promise);
					}
					return anthropicSse("advisor-post-handoff-idle");
				});

				const restorePrimary = installScriptedFetch(h.session.agent, async (input, init) => {
					seedRequests += 1;
					seedBodies.push(await readFetchBody(input, init));
					return anthropicSse("seed-turn-complete");
				});
				try {
					await h.session.prompt(SEED_TURN, {
						expandPromptTemplates: false,
						skipCompactionCheck: true,
					});
				} finally {
					restorePrimary();
				}

				await advisorHeld.promise;
				expect(h.effects.completeTask1).toBe(0);
				expect(h.effects.reviewUnfinished).toBe(0);
				expect(h.session.model?.id).toBe(authorizedModel.id);
				expect(h.session.model?.provider).toBe(authorizedModel.provider);
				expect(h.session.model?.baseUrl).toBe(authorizedModel.baseUrl);

				const sourceId = h.session.sessionManager.getSessionId();
				const sourceFile = h.session.sessionManager.getSessionFile();
				if (!sourceFile) throw new Error("file-backed source session is required");
				const sourceGeneration = h.run.getState().owner.generation;
				const sourceRunId = h.run.getState().run.id;
				const sourcePolicy = structuredClone(h.policy);

				const prepareDone = h.session.prepareContinuation({
					retainedInstructions: [RETAINED_INSTRUCTION],
					roleObligations: [ROLE_OBLIGATION],
					discoveries: [{ summary: DISCOVERY_SUMMARY, evidence: [h.discoveryRef] }],
					readDraft: () => DRAFT_TEXT,
					maxBriefingBytes: 256_000,
					settlementTimeoutMs: 5_000,
				});
				await pauseEntered.promise;
				expect(h.session.getAdvisorStatusOverview().advisors.some(entry => entry.status === "running")).toBe(true);

				h.session.setAdvisorContextPrompt(ADVISOR_REINIT_PROMPT);
				const reinitialized = h.session.getAdvisorAgent();
				if (!reinitialized) throw new Error("Expected advisor reinitialization to attach a live runtime");
				installScriptedFetch(reinitialized, async (input, init) => {
					advisorRequests += 1;
					advisorBodies.push(await readFetchBody(input, init));
					return anthropicSse("advisor-post-reinit-idle");
				});
				advisorRelease.resolve(anthropicSse("advisor-aborted-during-reinit"));

				await expect(prepareDone).rejects.toThrow("Transfer requires settled effects and workers");
				const inspected = await inspectCommittedRunState({ worktree: h.root, planPath: PLAN_RELATIVE });
				expect(inspected.state.run.id).toBe(sourceRunId);
				expect(inspected.state.owner.sessionId).toBe(sourceId);
				expect(inspected.state.owner.generation).toBe(sourceGeneration);
				expect(
					inspected.state.pendingEffects.filter(effect => effect.kind === "http" && effect.unresolved),
				).toHaveLength(1);
				const projection = h.run.getProjection();
				expect(projection.current.nextAction).toBe(NEXT_ACTION);
				expect(projection.tasks.find(task => task.number === 2)?.state).toBe("review");
				expect(
					projection.findings.some(finding => finding.status === "open" && finding.summary === OPEN_FINDING),
				).toBe(true);
				expect(projection.constraints.some(constraint => constraint.includes(PROTECTED_CONSTRAINT))).toBe(true);
				expect(projection.rejectedApproaches.some(approach => approach.summary === REJECTED_APPROACH)).toBe(true);

				// Attempt real primary admission: uncertainty cannot become replay permission.
				await h.session
					.prompt(NEXT_ACTION, {
						expandPromptTemplates: false,
						skipCompactionCheck: true,
					})
					.catch(() => {});
				expect(h.endpoint.requests).toBe(0);
				expect(advisorRequests).toBe(1);
				expect(seedRequests).toBe(1);
				expect(h.effects).toEqual({ completeTask1: 0, reviewUnfinished: 0 });
				expect(h.run.getState().owner).toEqual(inspected.state.owner);
				expect(h.session.model).toEqual(authorizedModel);
				expect(h.policy).toEqual(sourcePolicy);
				expect(payloadText(advisorBodies)).toContain(SEED_TURN);
				await writeCaseEvidence("pt00-advisor-reinit-blocked", {
					case: "advisor-reinit-unknown-request",
					owner: inspected.state.owner,
					pendingEffects: inspected.state.pendingEffects,
					projection,
					requests: { primary: seedRequests, advisor: advisorRequests, afterAbort: h.endpoint.requests },
					toolEffects: { ...h.effects },
					advisorPayloads: advisorBodies,
					sourcePayloads: seedBodies,
				});
			} finally {
				pauseSpy.mockRestore();
				advisorRelease.resolve(anthropicSse("advisor-unblocked"));
				await h.cleanup();
			}
		},
		{ timeout: CASE_TIMEOUT_MS },
	);
});
