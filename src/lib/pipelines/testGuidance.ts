import { resolveSignalTooling } from "@/lib/runtime/agentSignalSandbox";

/** The Viewer runs from its install or its standalone server directory.
    Resolve there, never relative to the project's worktree. An install whose
    gate tooling cannot be resolved still composes a usable brief. */
export function resolveStageTestGuidance(toolingCwd = process.cwd()): string {
  let wrapper: string;
  try { ({ gate: wrapper } = resolveSignalTooling(toolingCwd)); }
  catch {
    return "Gate wrapper unavailable: installed Delegatus gate tooling could not be resolved. Run test files by explicit path using the project's test command from its instruction files or package scripts, with the runner's file-selection syntax and isolated HOME, XDG_CONFIG_HOME, TMPDIR and any state-directory variable the project's instruction files name. Run heavy checks one at a time directly and report that shared gate containment was unavailable; keep subprocess deadlines and cleanup required by the project.";
  }
  const quoted = `'${wrapper.replaceAll("'", "'\\''")}'`;
  return `Run test files by explicit path using the project's test command from its instruction files or package scripts: bash ${quoted} <project-test-command> <file>, with the runner's file-selection syntax and isolated HOME, XDG_CONFIG_HOME, TMPDIR and any state-directory variable the project's instruction files name. Run heavy checks (test suites, typecheck, builds) one at a time through this wrapper by default, since agent scopes have a 4–8 GB memory cap: bash ${quoted} <command>. For a long Codex check, build an immutable manifest with the gate's buildManifest export, including the original absolute deadline, execution allowance, exact selection, source/script hashes, registered evidence/configuration roots and final completion manifest. Start bash ${quoted} --record "$TMPDIR/check.log" --manifest "$TMPDIR/manifest.json" -- <command> once through the engine's background-command facility. After recording starts, call recorded_check action handoff with that ticket and one stable request key. Only custody-accepted proves the job and its roots will survive a needs_decision checkpoint. One bounded --wait is optional. An active wait timeout supplies no command verdict. Without accepted custody, preserve partial source, patches and evidence, label the checkpoint interrupted or unknown, and await recovery. Never promise survival or start another command from PID absence. Completion supplies one durable result; read its current revision and explicitly acknowledge retained evidence before releasing roots. Use no repeated model waits, clock sleeps or background-output polls. Give each run a fresh log path. The owned runner ends detached descendants on deadline or cancellation; never bypass it for lifecycle tests.`;
}
