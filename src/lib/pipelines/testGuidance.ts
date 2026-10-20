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
  return `Run test files by explicit path using the project's test command from its instruction files or package scripts: bash ${quoted} <project-test-command> <file>, with the runner's file-selection syntax and isolated HOME, XDG_CONFIG_HOME, TMPDIR and any state-directory variable the project's instruction files name. Run heavy checks one at a time through this wrapper. The owned runner ends detached descendants on deadline or cancellation; never bypass it for lifecycle tests.`;
}
