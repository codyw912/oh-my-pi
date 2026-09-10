import { SpanStatusCode, trace } from "@opentelemetry/api";

export type SkillLoadKind = "agent" | "autoload" | "resource" | "user";

interface SkillIdentity {
	name: string;
	source?: string;
}

const tracer = trace.getTracer("@oh-my-pi/pi-coding-agent");

/** Record normalized skill usage without capturing skill contents, paths, or invocation arguments. */
export async function traceSkillLoad<T>(
	skill: SkillIdentity,
	kind: SkillLoadKind,
	load: () => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(
		"load_skill",
		{
			attributes: {
				"pi.omp.skill.name": skill.name,
				...(skill.source ? { "pi.omp.skill.source": skill.source } : {}),
				"pi.omp.skill.load.kind": kind,
			},
		},
		async span => {
			try {
				const result = await load();
				span.setAttribute("pi.omp.skill.status", "ok");
				span.setStatus({ code: SpanStatusCode.OK });
				return result;
			} catch (error) {
				span.setAttribute("pi.omp.skill.status", "error");
				span.setAttribute("error.type", error instanceof Error ? error.name : "Error");
				span.setStatus({ code: SpanStatusCode.ERROR });
				throw error;
			} finally {
				span.end();
			}
		},
	);
}
