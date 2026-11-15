/** Flows and workflows are retired: the engines, their HTTP actions and their
 * MCP tools are gone. Stored rows and round artifacts stay as review history. */
export const FLOW_RETIREMENT = Object.freeze({
  code: "FLOW_RETIRED" as const,
  error: "Flows and workflows are retired; use pipelines.",
  replacement: "/api/pipelines",
  archive: "/api/review-history",
  status: 410,
});

export const STAGE_RETIREMENT = Object.freeze({
  code: "STAGE_KIND_RETIRED" as const,
  error: "review-loop stages are retired; use pipeline run stages with review and fix edges. Convert stored legacy definitions explicitly before starting.",
  status: 410,
});

export class FlowRetiredError extends Error {
  readonly code = FLOW_RETIREMENT.code;
  readonly status = FLOW_RETIREMENT.status;
  readonly replacement = FLOW_RETIREMENT.replacement;
  constructor() { super(`${FLOW_RETIREMENT.code}: ${FLOW_RETIREMENT.error}`); }
}

export function hasRetiredStage(value: unknown): boolean {
  return Array.isArray(value) && value.some(stage => stage?.kind === "review-loop");
}
