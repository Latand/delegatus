import type { AutonomySetting } from "@/lib/monitor/autonomy";
export const NOW = Date.parse("2026-10-22T00:00:00.000Z");
export const context = (startedAt = new Date(NOW).toISOString()) => ({ project: "atlas", startedAt, conversationId: "seat", seatEpoch: 1 });
export const candidate = (candidateKey: string) => ({ project: "atlas", text: "Keep the useful filter", details: "Preserve the filter after opening a task. Check by opening and closing a task.", candidateKey, sources: ["correction: current filter resets"], score: [2, 2, 2, 2] });
export const authority = (now = NOW, startedAt = new Date(NOW).toISOString()) => ({
  now: () => now,
  settings: () => ({ enabled: true, autonomy: { enabled: true, startedAt, until: null, proactive: { enabled: true } } as AutonomySetting }),
  seat: () => ({ conversationId: "seat", epoch: 1 }),
});
if (import.meta.main) {
  const { admitProactiveTask, readProactiveAllowance, rejectProactiveCandidate, decideProactiveTask, proactiveCandidateDecision, proactiveDecisionToken } = await import("./proactive");
  const [file, key, action, project = "atlas", startedAt = context().startedAt] = process.argv.slice(2);
  const now = Date.parse(startedAt);
  try {
    let result: unknown;
    if (action === "pipeline-record") {
      const { findPipelineRecord } = await import("@/lib/pipelines/store");
      result = findPipelineRecord(key!);
    } else if (action === "lane-error") {
      const { proactiveTaskExecutionError } = await import("./proactiveExecution");
      const { findPipelineRecord } = await import("@/lib/pipelines/store");
      const saved = await Bun.file(key!).json();
      const pipeline = findPipelineRecord(saved.id);
      if (!pipeline?.proactiveTaskIds?.length) throw new Error("retained proactive pipeline authority is missing");
      result = { error: proactiveTaskExecutionError(pipeline.proactiveTaskIds, file!, { pipeline, stageId: pipeline.cursor?.stageId, phase: "effect" }) };
    } else if (action === "reserve-lane") {
      const { reserveProactiveLane } = await import("./proactiveLane");
      const pipeline = await Bun.file(key!).json();
      await reserveProactiveLane(pipeline, pipeline.creationRequest.key, file!);
      result = { laneId: pipeline.id };
    } else if (action === "alias") {
      const { persistProjectAliases } = await import("@/lib/projects/aliases");
      if (!persistProjectAliases([{ source: project, target: key!, displayName: "Atlas" }])) throw new Error("alias refused");
      result = {};
    } else if (action === "adopt" || action === "decision") {
      const { loadTasks } = await import("./store");
      const task = loadTasks(file!).find(task => task.proactive?.candidateKey === key);
      if (!task) throw new Error("task not found");
      if (action === "adopt") await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task, file!), file!, () => new Date(now).toISOString());
      result = { ...proactiveCandidateDecision(task, file!), token: proactiveDecisionToken(task, file!) };
    } else if (action === "allowance") result = readProactiveAllowance(project, startedAt, now, file!);
    else if (action === "reject") { await rejectProactiveCandidate(project, key!, file!); result = {}; }
    else {
      const admitted = await admitProactiveTask({ ...candidate(key!), project }, { ...context(startedAt), project }, file!, authority(now, startedAt));
      result = { id: admitted.task.id, replay: admitted.replay };
    }
    process.stdout.write(`\nRESULT ${JSON.stringify(result)}\n`);
  } catch (error) { process.stdout.write(`\nRESULT ${JSON.stringify({ error: (error as Error).message })}\n`); }
}
