import type { Flow } from "./flows/types";
import type { Pipeline } from "./pipelines/types";

/** The board consumes all membership, state, prompts and recovery handles.
 * Execution input/output bodies and the reviewer's spec are not board fields;
 * Frozen attempt scaffolds are execution provenance; previews use the stage
 * scaffold. Their complete values remain on GET /api/pipelines/:id, alongside
 * execution bodies; flow specs remain on GET /api/flows.
 * This opt-in projection never changes a stored record or clips a history. */
export function filesReadSummary(flows: readonly Flow[], pipelines: readonly Pipeline[]) {
  return {
    flows: flows.map(({ spec: _spec, ...flow }) => flow),
    pipelines: pipelines.map(pipeline => ({
      ...pipeline,
      cursor: pipeline.cursor ? { ...pipeline.cursor, input: null } : null,
      runs: pipeline.runs.map(run => ({ ...run, attempts: run.attempts.map(attempt => {
        // Preserve the launched runtime identity, including historical overrides.
        // Only stage scaffolds feed the board's prompt previews.
        const projected = {
          ...attempt,
          ...(attempt.effectiveRole ? { effectiveRole: { ...attempt.effectiveRole, promptScaffold: null } } : {}),
          input: null,
          output: null,
        };
        if (!attempt.report) return projected;
        const { taskSummary: _taskSummary, ...report } = attempt.report;
        return { ...projected, report };
      }) })),
    })),
  };
}
