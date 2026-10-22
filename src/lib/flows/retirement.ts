/** S5 compatibility fence. Keep reads and receipt replay for at least 30 days
 * and two released versions after cutover; S9 owns the caller assessment. */
export const FLOW_RETIREMENT = Object.freeze({
  code: "FLOW_RETIRED" as const,
  error: "Flows and workflows are retired; use pipelines.",
  replacement: "/api/pipelines",
  status: 410,
});

export const STAGE_RETIREMENT = Object.freeze({
  code: "STAGE_KIND_RETIRED" as const,
  error: "review-loop stages are retired; use pipeline run stages with review and fix edges. Convert stored legacy definitions explicitly before starting.",
  status: 410,
});

export const FLOW_ARCHIVE = Object.freeze({
  retired: true,
  replacement: "/api/pipelines",
  archive: "/api/flows",
});

export class FlowRetiredError extends Error {
  readonly code = FLOW_RETIREMENT.code;
  readonly status = FLOW_RETIREMENT.status;
  readonly replacement = FLOW_RETIREMENT.replacement;
  constructor() { super(`${FLOW_RETIREMENT.code}: ${FLOW_RETIREMENT.error}`); }
}

/** Keep the old implementation unreachable until its S8 deletion. */
export function assertFlowExecution(): void { throw new FlowRetiredError(); }

export function hasRetiredStage(value: unknown): boolean {
  return Array.isArray(value) && value.some(stage => stage?.kind === "review-loop");
}
