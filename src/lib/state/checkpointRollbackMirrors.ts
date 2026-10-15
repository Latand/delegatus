import type { HotStateCheckpoint } from "./hotStateAuthority";

export async function checkpointHotStateRollbackMirrorsForDemotion(): Promise<HotStateCheckpoint["revisions"]> {
  const [flows, pipelines, workflows] = await Promise.all([
    import("@/lib/flows/store"),
    import("@/lib/pipelines/store"),
    import("@/lib/workflows/store"),
  ]);
  const flowRevision = await flows.checkpointFlowRollbackMirrorForDemotionAsync();
  const pipelineRevisions = await pipelines.checkpointPipelineRollbackMirrorsForDemotionAsync();
  const workflowRevision = await workflows.checkpointWorkflowRollbackMirrorForDemotionAsync();
  /* Stores moved by #1870 record their mirror in `state_imports`, not in the
     checkpoint record older adapters parse. */
  const { checkpointLegacyCollectionMirrorsForDemotion } = await import("@/lib/state/legacyCollections");
  await checkpointLegacyCollectionMirrorsForDemotion();
  return {
    flows: flowRevision,
    pipelines: pipelineRevisions.pipelines,
    pipelinesArchive: pipelineRevisions.pipelinesArchive,
    workflows: workflowRevision,
  };
}
