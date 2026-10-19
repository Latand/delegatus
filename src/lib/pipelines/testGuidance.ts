import { resolveSignalTooling } from "@/lib/runtime/agentSignalSandbox";

/** Resolve the installation before composing a stage. */
export function resolveStageTestGuidance(toolingCwd = process.cwd()): string {
  const { gate: wrapper } = resolveSignalTooling(toolingCwd);
  const quoted = `'${wrapper.replaceAll("'", "'\\''")}'`;
  return `Run test files by explicit path using the project's test command from its instruction files or package scripts: bash ${quoted} <project-test-command> <file>, with the runner's file-selection syntax and isolated HOME, XDG_CONFIG_HOME, TMPDIR and any state-directory variable the project's instruction files name. Run heavy checks one at a time through this wrapper. The owned runner ends detached descendants on deadline or cancellation; never bypass it for lifecycle tests.`;
}
