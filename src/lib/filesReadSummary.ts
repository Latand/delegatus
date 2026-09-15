import type { Flow } from "./flows/types";
import type { Pipeline } from "./pipelines/types";

/** The board consumes all membership, state, prompts and recovery handles.
 * Execution input/output bodies and the reviewer's spec are not board fields;
 * their complete values remain on GET /api/flows and /api/pipelines/:id.
 * This opt-in projection never changes a stored record or clips a history. */
export function filesReadSummary(flows: readonly Flow[], pipelines: readonly Pipeline[]) {
  return {
    flows: flows.map(({ spec: _spec, ...flow }) => flow),
    pipelines: pipelines.map(pipeline => ({
      ...pipeline,
      cursor: pipeline.cursor ? { ...pipeline.cursor, input: null } : null,
      runs: pipeline.runs.map(run => ({ ...run, attempts: run.attempts.map(attempt => ({ ...attempt, input: null, output: null })) })),
    })),
  };
}
