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
 *   bun src/lib/state/fixtures/stateOwnershipProbe.ts resolve-then-disown
 *   bun src/lib/state/fixtures/stateOwnershipProbe.ts resolve-then-chdir
 *   bun src/lib/state/fixtures/stateOwnershipProbe.ts write-task
 *   bun src/lib/state/fixtures/stateOwnershipProbe.ts registry-at
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

  if (mode === "resolve-then-disown") {
    /* The same process resolves as an owner, then loses its claim (#1987): a
       remembered admission must not outlive the owner that earned it. */
    const owned = path.dirname(statePath("probe"));
    delete process.env.LLV_STATE_OWNER;
    let afterDisown: string;
    try {
      afterDisown = path.dirname(statePath("probe"));
    } catch (error) {
      afterDisown = error instanceof Error ? `refused: ${error.name}` : "refused";
    }
    console.log(JSON.stringify({ stateDirectory: owned, afterDisown }));
    return;
  }

  if (mode === "resolve-then-chdir") {
    /* A relative config root resolves against the working directory, so the
       same environment names a sandbox from one directory and the operator's
       installation from another (#1987). */
    process.chdir(process.env.PROBE_FIRST_CWD!);
    const first = path.resolve(path.dirname(statePath("probe")));
    process.chdir(process.env.PROBE_SECOND_CWD!);
    let afterChdir: string;
    try {
      afterChdir = path.resolve(path.dirname(statePath("probe")));
    } catch (error) {
      afterChdir = error instanceof Error ? `refused: ${error.name}` : "refused";
    }
    console.log(JSON.stringify({ stateDirectory: first, afterChdir }));
    return;
  }

  if (mode === "write-task") {
    /* What the leaked reviewer fixture did (2026-09-23): a launch reserved
       outside any task, whose membership the default task store records. */
    const { commitTaskMembership } = await import("@/lib/tasks/membership");
    const result = commitTaskMembership({
      project: "dir-probe",
      origin: { kind: "launch", key: "probe-launch" },
      title: "Exercise legacy spawn fixture",
      identity: { launchId: "probe-launch", conversationId: "conversation_probe" },
    });
    console.log(JSON.stringify({ stateDirectory: path.dirname(statePath("probe")), ok: result.ok }));
    return;
  }

  if (mode === "registry-at") {
    /* A registry handed the operator's path explicitly, never resolved. */
    const { AgentRegistry } = await import("@/lib/agent/registry");
    const registry = new AgentRegistry(process.env.PROBE_REGISTRY_FILE!, undefined, undefined, { sqliteMode: "off" });
    registry.close();
    console.log(JSON.stringify({ stateDirectory: path.dirname(process.env.PROBE_REGISTRY_FILE!) }));
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
