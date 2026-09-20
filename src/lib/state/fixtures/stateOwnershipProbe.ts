import path from "node:path";

/**
 * A separate process that resolves state the way an unsuspecting one does
 * (#1905). `stateOwnership.test.ts` drives it with the environment of a
 * production build, of a plain script, and of each declared owner, because the
 * question — what does a process with THIS environment reach — cannot be asked
 * inside a test runner that has already pinned `LLV_STATE_DIR` for itself.
 *
 *   bun src/lib/state/fixtures/stateOwnershipProbe.ts resolve
 *   bun src/lib/state/fixtures/stateOwnershipProbe.ts load-stores
 *   bun src/lib/state/fixtures/stateOwnershipProbe.ts open-registry
 *
 * `resolve` prints the state directory it reached. `load-stores` additionally
 * walks the path the incident took: the instrumentation entry point, then a
 * store read that runs the first-boot import on first use. Both print one JSON
 * line on stdout; a refusal exits non-zero with the message on stderr.
 */
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "resolve";
  const { statePath } = await import("@/lib/configDir");

  if (mode === "load-stores") {
    const instrumentation = await import("@/instrumentation");
    await instrumentation.register();
    const { loadTasksFile } = await import("@/lib/tasks/store");
    const state = loadTasksFile();
    console.log(JSON.stringify({
      stateDirectory: path.dirname(statePath("probe")),
      tasks: state.tasks.length,
    }));
    return;
  }

  if (mode === "open-registry") {
    const { agentRegistry } = await import("@/lib/agent/registry");
    const registry = agentRegistry();
    registry.close();
  }

  console.log(JSON.stringify({ stateDirectory: path.dirname(statePath("probe")) }));
}

await main();
