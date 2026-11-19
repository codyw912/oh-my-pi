import { prompt } from "@oh-my-pi/pi-utils";
import type { DaemonCompletionNotification } from "../launch/protocol";
import launchCompletionTemplate from "../prompts/session/launch-completion.md" with { type: "text" };
import type { CustomMessage } from "./messages";

/** Yield-queue kind for broker-owned supervised process completions. */
export const LAUNCH_COMPLETION_MESSAGE_TYPE = "launch-completion";

/** One broker completion awaiting injection into its owning session. */
export type LaunchCompletionEntry = DaemonCompletionNotification;

/** Whether a broker completion belongs to the primary session or its advisor. */
export function isLaunchCompletionOwner(owner: string, sessionId: string): boolean {
	return owner === sessionId || owner === `${sessionId}-advisor`;
}

/** Map a captured source owner onto the committed successor, including advisors. */
export function continuationCompletionSuccessorOwner(
	fromOwner: string | undefined,
	sourceSessionId: string,
	successorSessionId: string,
): string | undefined {
	if (!fromOwner) return undefined;
	if (fromOwner === sourceSessionId) return successorSessionId;
	if (fromOwner === `${sourceSessionId}-advisor`) return `${successorSessionId}-advisor`;
	return undefined;
}

/** Rebind a broker completion onto the successor without changing daemon.owner. */
export function rebindLaunchCompletionOwner(
	notification: DaemonCompletionNotification,
	sourceSessionId: string,
	successorSessionId: string,
): DaemonCompletionNotification {
	const owner = continuationCompletionSuccessorOwner(notification.owner, sourceSessionId, successorSessionId);
	if (!owner || owner === notification.owner) return notification;
	return { ...notification, owner };
}

/** Durable identity for one supervised-process generation. */
export function launchCompletionGenerationKey(daemon: { id: string; startedAt: number }): string {
	return `${daemon.id}\0${daemon.startedAt}`;
}

export function launchCompletionDetailsContainDaemon(
	details: unknown,
	daemon: { id: string; startedAt: number },
): boolean {
	if (!details || typeof details !== "object" || Array.isArray(details) || !("daemons" in details)) return false;
	const daemons = details.daemons;
	if (!Array.isArray(daemons)) return false;
	return daemons.some(item => {
		if (!item || typeof item !== "object" || !("id" in item) || !("startedAt" in item)) return false;
		return item.id === daemon.id && item.startedAt === daemon.startedAt;
	});
}

/** Build one model-visible notification per terminal supervised process exit. */
export function buildLaunchCompletionBatchMessage(entries: LaunchCompletionEntry[]): CustomMessage {
	return {
		role: "custom",
		customType: LAUNCH_COMPLETION_MESSAGE_TYPE,
		content: entries
			.map(({ daemon }) =>
				prompt.render(launchCompletionTemplate, {
					name: daemon.name,
					state: daemon.state,
					exitCode: daemon.exitCode,
					hasExitCode: daemon.exitCode !== undefined,
				}),
			)
			.join("\n"),
		display: true,
		attribution: "agent",
		details: { daemons: entries.map(entry => entry.daemon) },
		timestamp: Date.now(),
	};
}
