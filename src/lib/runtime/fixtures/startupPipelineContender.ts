import { createPipelineFromRequest, defaultPipelinePorts } from "@/lib/pipelines/engine";
import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import path from "node:path";

// The parent supplies an empty private environment before this module loads.
const directory = process.argv[2]!;
try {
  const result = await createPipelineFromRequest({
    task: "Create during historical startup reconciliation",
    repoDir: directory,
    autoStart: false,
    stages: [],
  }, {
    ...defaultPipelinePorts(),
    preflightRepo: () => ({ ok: true, repoDir: directory, gitCommonDir: path.join(directory, ".git"), worktreeParent: directory }),
  }, { allowOperatorDraftWithoutLineage: true });
  console.log(JSON.stringify({ created: Boolean(result.pipeline), error: result.error ?? null, persisted: loadPipelinesForProjection().length }));
} catch (error) {
  console.log(JSON.stringify({ created: false, error: error instanceof Error ? error.message : String(error), persisted: loadPipelinesForProjection().length }));
}
