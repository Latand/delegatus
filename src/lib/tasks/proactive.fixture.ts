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
  const { admitProactiveTask, rejectProactiveCandidate } = await import("./proactive");
  const [file, key, action] = process.argv.slice(2);
  try {
    if (action === "reject") { await rejectProactiveCandidate("atlas", key!, file!); process.stdout.write(`\nRESULT ${JSON.stringify({})}\n`); }
    else { const result = await admitProactiveTask(candidate(key!), context(), file!, authority()); process.stdout.write(`\nRESULT ${JSON.stringify({ id: result.task.id })}\n`); }
  } catch (error) { process.stdout.write(`\nRESULT ${JSON.stringify({ error: (error as Error).message })}\n`); }
}
