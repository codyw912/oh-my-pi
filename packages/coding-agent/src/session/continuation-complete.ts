import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { ContinuationRequestBoundaryError } from "./continuation-request";

/** Convert an enrolled stream into completeSimple's shape. */
export function completeImplFromStreamFn(streamFn: StreamFn): typeof completeSimple {
	return async (model, context, options) => {
		const stream = await streamFn(model, context, options);
		return stream.result();
	};
}

/**
 * Enrolled inference must use the admitted stream. Ordinary sessions keep
 * completeSimple. Missing enrollment stream fails closed before dispatch.
 */
export function completeImplFromEnrollment(streamFn: StreamFn | undefined, enrolled: boolean): typeof completeSimple {
	if (streamFn) return completeImplFromStreamFn(streamFn);
	if (enrolled) {
		return async () => {
			throw new ContinuationRequestBoundaryError("Continuation HTTP admission is required for this inference path");
		};
	}
	return completeSimple;
}

/** Local tiny / non-HTTP inference is not an admitted provider path. */
export function rejectEnrolledUnsupportedInference(enrolled: boolean, reason: string): void {
	if (!enrolled) return;
	throw new ContinuationRequestBoundaryError(reason);
}
