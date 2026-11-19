import { scheduler } from "node:timers/promises";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import {
	streamSimple,
	type AssistantMessage,
	type Context,
	type FetchImpl,
	type Model,
	type SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { AdmissionOutcome } from "./continuation-binding";
import type { ContinuationRole } from "./continuation-policy";

export type { ContinuationRole };

export type ContinuationRequestOutcome =
	| { kind: "returned"; message: AssistantMessage }
	| { kind: "threw"; error: unknown; partial?: AssistantMessage; unobservedTransport?: true }
	| { kind: "not-started"; reason: unknown };

export interface ContinuationHttpReceipt {
	/** Headers are not completion of a streaming response; the enclosing request remains pending. */
	received(response: Response): Promise<void>;
	/**
	 * `dispatched` is false when the HTTP intent never entered `fetch`
	 * (abort or a post-admit race). True once `fetch` was entered, even if the
	 * socket outcome is unknown.
	 */
	failed(error: unknown, dispatched: boolean): Promise<void>;
}

export interface ContinuationRequestReceipt {
	/** Every wire attempt, including provider-internal retries, needs its own durable intent. */
	admitHttp(input: string | URL | Request, init: RequestInit | undefined): Promise<ContinuationHttpReceipt>;
	settle(outcome: ContinuationRequestOutcome): Promise<void>;
	/** Recheck account blocks and operator intent before any provider retry wait. */
	beforeRetryWait(signal?: AbortSignal): Promise<void>;
}

export interface ContinuationRequestBoundary {
	admit(
		request: { role: ContinuationRole; model: Model; context: Context; options: SimpleStreamOptions | undefined },
		signal?: AbortSignal,
	): Promise<ContinuationRequestReceipt>;
}

export class ContinuationRequestBoundaryError extends Error {
	override name = "ContinuationRequestBoundaryError";
}

/** Policy/pause denial. Not a storage fault and must not latch the binding. */
export class ContinuationAdmissionError extends ContinuationRequestBoundaryError {
	override name = "ContinuationAdmissionError";
	readonly outcome: Exclude<AdmissionOutcome, { kind: "allow" }>;

	constructor(outcome: Exclude<AdmissionOutcome, { kind: "allow" }>, options?: ErrorOptions) {
		super(outcome.reason, options);
		this.outcome = outcome;
	}
}

/** A candidate failed capability/headroom checks before ownership changed. */
export class ContinuationDestinationRejection extends ContinuationAdmissionError {
	override name = "ContinuationDestinationRejection";
}

// Enrollment is limited to HTTP APIs covered by the actual-dispatch fixtures.
// Additional provider encoders and hosted-agent transports need their own
// certification before they can participate in a continuation run.
const FETCH_APIS: Record<string, true> = {
	"anthropic-messages": true,
	"openai-responses": true,
	"openai-codex-responses": true,
};

const continuationTransports = new WeakSet<StreamFn>([streamSimple]);

/**
 * Internal SDK registration for audited wrappers that forward the admitted
 * fetch to streamSimple. This module is excluded from package exports.
 * Registration trusts the in-tree caller's audit; it does not inspect a
 * callback or sandbox arbitrary code running in this process. Never register
 * a user-supplied stream merely because its model has a supported API name.
 */
export function registerContinuationTransport(stream: StreamFn, base: StreamFn = streamSimple): StreamFn {
	if (!continuationTransports.has(base)) {
		throw new ContinuationRequestBoundaryError("Continuation wrapper has an uncertified underlying transport");
	}
	continuationTransports.add(stream);
	return stream;
}

function isAbortReason(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	if (!error || typeof error !== "object") return false;
	const name = "name" in error ? error.name : undefined;
	const message = "message" in error ? error.message : undefined;
	return name === "AbortError" || message === "Request was aborted." || message === "Request was aborted";
}

function unsupportedTransportReason(model: Model, options: SimpleStreamOptions | undefined): string | undefined {
	if (model.transport === "pi-native") {
		return `Continuation HTTP admission is unsupported for pi-native transport (${model.api})`;
	}
	if (!FETCH_APIS[model.api]) {
		return `Continuation HTTP admission is unsupported for ${model.api}`;
	}
	if (options && "client" in options && options.client != null) {
		return "Continuation HTTP admission is unsupported for injected provider clients";
	}
	return undefined;
}

/** Install only for an enrolled session; ordinary sessions retain their original stream function. */
export function bindContinuationStream(
	stream: StreamFn,
	boundary: ContinuationRequestBoundary,
	role: ContinuationRole,
): StreamFn {
	let persistenceFault: ContinuationRequestBoundaryError | undefined;
	const latch = (error: unknown): ContinuationRequestBoundaryError => {
		if (error instanceof ContinuationAdmissionError) return error;
		persistenceFault ??= new ContinuationRequestBoundaryError(
			`Continuation request persistence failed: ${error instanceof Error ? error.message : String(error)}`,
			{
				cause: error,
			},
		);
		return persistenceFault;
	};

	return async (model, context, options) => {
		if (persistenceFault) throw persistenceFault;
		if (!continuationTransports.has(stream)) {
			throw new ContinuationAdmissionError({
				kind: "stop",
				attention: true,
				reason: "Continuation requires a certified HTTP transport; custom stream functions are unsupported",
			});
		}

		let receipt: ContinuationRequestReceipt;
		try {
			receipt = await boundary.admit({ role, model, context, options }, options?.signal);
		} catch (error) {
			if (error instanceof ContinuationAdmissionError) throw error;
			throw latch(error);
		}

		let settled = false;
		const settle = async (outcome: ContinuationRequestOutcome): Promise<void> => {
			if (settled) return;
			settled = true;
			try {
				await receipt.settle(outcome);
			} catch (error) {
				if (error instanceof ContinuationAdmissionError) throw error;
				throw latch(error);
			}
			if (persistenceFault) throw persistenceFault;
		};

		if (persistenceFault) {
			await settle({ kind: "not-started", reason: persistenceFault });
			throw persistenceFault;
		}

		const unsupported = unsupportedTransportReason(model, options);
		if (unsupported) {
			const error = new ContinuationRequestBoundaryError(unsupported);
			await settle({ kind: "not-started", reason: error });
			throw error;
		}

		if (options?.signal?.aborted) {
			await settle({ kind: "not-started", reason: options.signal.reason });
			options.signal.throwIfAborted();
		}

		let dispatchedHttp = false;
		let unknownHttpEffect = false;
		let unobservedResponse: AssistantMessage | undefined;
		let transportError: ContinuationRequestBoundaryError | undefined;
		let admissionError: ContinuationAdmissionError | undefined;
		const transportAbort = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, transportAbort.signal]) : transportAbort.signal;
		const stopUnknownTransport = (error: unknown): ContinuationRequestBoundaryError => {
			unknownHttpEffect = true;
			transportError ??=
				error instanceof ContinuationRequestBoundaryError
					? error
					: new ContinuationRequestBoundaryError("HTTP request outcome is unknown", { cause: error });
			transportAbort.abort(transportError);
			return transportError;
		};
		const underlyingFetch: FetchImpl = options?.fetch ?? globalThis.fetch;
		const fetch: FetchImpl = async (input, init) => {
			if (persistenceFault) throw persistenceFault;
			if (transportError) throw transportError;
			if (settled) throw new ContinuationRequestBoundaryError("Request scope has already settled");
			let wireReceipt: ContinuationHttpReceipt;
			const suppliedSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
			const manualInit: RequestInit = {
				...init,
				redirect: "manual",
				signal: suppliedSignal ? AbortSignal.any([suppliedSignal, signal]) : signal,
			};
			const manualInput = input instanceof Request ? new Request(input, manualInit) : input;
			try {
				wireReceipt = await receipt.admitHttp(manualInput, manualInit);
			} catch (error) {
				if (error instanceof ContinuationAdmissionError) {
					admissionError = error;
					transportAbort.abort(error);
					throw error;
				}
				const fault = latch(error);
				transportAbort.abort(fault);
				throw fault;
			}
			if (persistenceFault) {
				try {
					await wireReceipt.failed(persistenceFault, false);
				} catch (failure) {
					if (!(failure instanceof ContinuationAdmissionError)) throw latch(failure);
				}
				throw persistenceFault;
			}

			let enteredFetch = false;
			let response: Response;
			try {
				manualInit.signal?.throwIfAborted();
				if (persistenceFault) throw persistenceFault;
				enteredFetch = true;
				dispatchedHttp = true;
				response = await underlyingFetch(manualInput, manualInit);
			} catch (error) {
				if (enteredFetch) stopUnknownTransport(error);
				try {
					await wireReceipt.failed(error, enteredFetch);
				} catch (failure) {
					if (enteredFetch) unknownHttpEffect = true;
					if (failure instanceof ContinuationAdmissionError) throw failure;
					throw latch(failure);
				}
				if (enteredFetch) throw transportError;
				if (error instanceof ContinuationAdmissionError) throw error;
				if (persistenceFault) throw persistenceFault;
				throw error;
			}
			if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
				await response.body?.cancel().catch(() => {});
				const error = new ContinuationRequestBoundaryError(
					`Continuation does not follow HTTP redirects (${response.status})`,
				);
				stopUnknownTransport(error);
				try {
					await wireReceipt.failed(error, true);
				} catch (failure) {
					if (failure instanceof ContinuationAdmissionError) throw failure;
					throw latch(failure);
				}
				throw error;
			}
			try {
				await wireReceipt.received(response);
			} catch (error) {
				unknownHttpEffect = true;
				const fault = error instanceof ContinuationAdmissionError ? error : latch(error);
				transportAbort.abort(fault);
				await response.body?.cancel().catch(() => {});
				throw fault;
			}
			if (persistenceFault) throw persistenceFault;
			return response;
		};

		const requestOptions: SimpleStreamOptions = {
			...options,
			fetch,
			signal,
			// Enrolled HTTP-only: pin websocket and Anthropic cache-refresh so
			// session/model defaults cannot bypass StreamOptions.fetch admission.
			preferWebsockets: false,
			anthropicCacheRefresh: false,
			anthropicCacheRefreshRequest: false,
			// A provider-native fallback must not change model behind the owner.
			fallbacks: [],
			providerRetryWait: async (delayMs, signal) => {
				if (persistenceFault) throw persistenceFault;
				if (transportError) throw transportError;
				try {
					await receipt.beforeRetryWait(signal);
				} catch (error) {
					if (error instanceof ContinuationAdmissionError) {
						admissionError = error;
						transportAbort.abort(error);
						throw error;
					}
					throw latch(error);
				}
				if (persistenceFault) throw persistenceFault;
				if (options?.providerRetryWait) await options.providerRetryWait(delayMs, signal);
				else await scheduler.wait(delayMs, { signal });
			},
		};

		const settleUnstarted = (error: unknown): ContinuationRequestOutcome =>
			!dispatchedHttp && (isAbortReason(error, options?.signal) || error instanceof ContinuationAdmissionError)
				? { kind: "not-started", reason: options?.signal?.reason ?? error }
				: {
						kind: "threw",
						error,
						...(unobservedResponse ? { partial: unobservedResponse, unobservedTransport: true as const } : {}),
					};
		const terminalOutcome = (message: AssistantMessage): ContinuationRequestOutcome => {
			if (!dispatchedHttp && message.stopReason !== "error" && message.stopReason !== "aborted") {
				unobservedResponse = message;
				throw new ContinuationRequestBoundaryError("Model output arrived without an admitted HTTP attempt");
			}
			return !dispatchedHttp && (options?.signal?.aborted || admissionError)
				? { kind: "not-started", reason: admissionError ?? options?.signal?.reason }
				: { kind: "returned", message };
		};

		let upstream: AssistantMessageEventStream;
		try {
			upstream = await stream(
				model.api === "openai-codex-responses" && model.preferWebsockets !== false
					? { ...model, preferWebsockets: false }
					: model,
				context,
				requestOptions,
			);
		} catch (error) {
			await settle(settleUnstarted(error));
			throw error;
		}

		const output = new AssistantMessageEventStream();
		output.forwardLocalWorkFrom(upstream);
		void (async () => {
			let partial: AssistantMessage | undefined;
			try {
				for await (const event of upstream) {
					if (event.type === "done" || event.type === "error") {
						const message = event.type === "done" ? event.message : event.error;
						if (unknownHttpEffect || persistenceFault) {
							const error = persistenceFault ?? transportError ?? message;
							await output.trackLocalWork(settle({ kind: "threw", error, partial: message }));
							output.fail(error);
							return;
						}
						await output.trackLocalWork(settle(terminalOutcome(message)));
						output.push(event);
						output.end();
						return;
					}
					if ("partial" in event) partial = event.partial;
					output.push(event);
				}
				const message = await upstream.result();
				if (unknownHttpEffect || persistenceFault) {
					const error = persistenceFault ?? transportError ?? message;
					await output.trackLocalWork(settle({ kind: "threw", error, partial: message }));
					output.fail(error);
					return;
				}
				await output.trackLocalWork(settle(terminalOutcome(message)));
				output.end(message);
			} catch (error) {
				try {
					await settle(
						unknownHttpEffect || persistenceFault
							? { kind: "threw", error: persistenceFault ?? error, partial }
							: settleUnstarted(error),
					);
					output.fail(persistenceFault ?? error);
				} catch (failure) {
					output.fail(failure);
				}
			} finally {
				output.forwardLocalWorkFrom(undefined);
			}
		})();
		return output;
	};
}
