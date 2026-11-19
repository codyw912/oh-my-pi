import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ContinuationWorkflow } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ContinuationPreparationOptions } from "@oh-my-pi/pi-coding-agent/session/continuation-handoff";

export type PilotStrategy = "ordinary" | "focused" | "full-history";

export interface PilotModel {
	provider: "fireworks-messages" | "fireworks-responses";
	id: string;
	api: "anthropic-messages" | "openai-responses";
	contextWindow: number;
	maxTokens: number;
}

export interface PilotManifest {
	version: 1;
	id: string;
	mode: "scripted" | "live";
	source: PilotModel;
	destination: PilotModel;
	route: "direct-fireworks";
	maxPaidUsd: 5;
	paidFallback: false;
	maxOutputTokens: 16384;
	maxRequestBodyBytes: 524288;
	deadlineMinutes: 30;
	repetitions: 2;
	gatewaySocket: string;
}

export interface PilotCheck {
	id: string;
	passed: boolean;
	evidence: string;
}

export interface PilotWorkload {
	root: string;
	planPath: string;
	workflow: ContinuationWorkflow;
	systemPrompt: string;
	sourcePrompt: string;
	continuationPrompt: string;
	tools: AgentTool[];
	preparation: Omit<ContinuationPreparationOptions, "destination">;
	/** Reset observation counters after the shared source transcript is captured. */
	resetObservations(): void;
	/** Independent checks; semantic review still requires human inspection. */
	verify(): Promise<{ checks: PilotCheck[]; review: unknown; operations: unknown[] }>;
}
