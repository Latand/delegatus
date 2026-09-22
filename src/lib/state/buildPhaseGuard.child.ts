/*
 * The module load `next build` performs, in a process of its own.
 *
 * `collectAppRouteSegments` loads every route module to read its segment
 * config. `src/app/api/accounts/codex/limits/route.ts` pulls in
 * `@/lib/accounts/claudeLogin`, which builds its supervisor at module scope,
 * and the constructor's `reconcilePersisted()` reads an account source. That
 * is the load that imported the operator's live account files in #1905, so it
 * is the load this child performs — the real module, not a stand-in.
 */
const [mode] = process.argv.slice(2);

/** The deployment adapter's step: it owns the release fence for a Viewer it
    has established is dead, in a process that never activated and never named
    a state directory of its own. */
async function adapterCheckpoint(): Promise<void> {
  const barrier = await import("./stateMutationBarrier");
  const { checkpointLegacyCollectionMirrorsForDemotion, ensureLegacyCollectionsImported } =
    await import("./legacyCollections");
  barrier.openStateMutationActivation();
  await ensureLegacyCollectionsImported();
  barrier.closeStateMutationActivationForTests();

  let refused: string | null = null;
  try {
    await checkpointLegacyCollectionMirrorsForDemotion();
  } catch (error) {
    refused = error instanceof Error ? error.name : String(error);
  }
  await barrier.withStateMutationActivation(checkpointLegacyCollectionMirrorsForDemotion);
  /* The scope closes behind the step: the process is under the barrier again. */
  const stillRefused = barrier.stateMutationActivationOpen();
  console.log(JSON.stringify({ refused, gateLeftOpen: stillRefused }));
}

async function main(): Promise<void> {
  if (mode === "adapter-checkpoint") return adapterCheckpoint();
  if (mode === "activated") {
    const { openStateMutationActivation } = await import("./stateMutationBarrier");
    openStateMutationActivation();
  }
  await import("@/lib/accounts/claudeLogin");
  const { readAccountSource } = await import("@/lib/accounts/accountsStore");
  /* Give the supervisor's constructor promise a turn to reach its read, then
     read one ourselves the way an API route would. */
  await new Promise((resolve) => setTimeout(resolve, 50));
  const read = readAccountSource("claude-accounts.json");
  /* A bridge read the way the MCP bridge tools and the files route make one
     (#1870 slice 4): before the activation it answers from the legacy files. */
  const bridge = await import("@/lib/bridge/store");
  bridge.readBridgeReportLog();
  bridge.readBridgeChannel();
  bridge.readBridgeChannel({ project: "seeded-project", seatConversationId: "seeded-seat" });
  /* The operator-facing small stores (#1870 slice 5), read the way
     `request_attention`, `suggest_replies` and `seat_tick_settings` read them. */
  const attention = (await import("@/lib/attention/store")).readAttentionFile();
  (await import("@/lib/suggestions/store")).readReplySuggestionsFile();
  (await import("@/lib/monitor/seatTickSettings")).readSeatTickSettingsFile();
  if (attention.revision !== 57) throw new Error(`attention revision ${attention.revision}, expected 57`);
  console.log(JSON.stringify({ kind: read.kind }));
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  },
);
