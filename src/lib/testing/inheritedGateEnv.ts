/** What a run under gate-slot, or inside a stage agent, hands to its test
 * process: the held slot lease, the owned runner's context, the CPU wait
 * ledgers and slice, and the stage task's CPU priority binding (which names
 * the operator's state database). A fixture that starts gates of its own
 * starts outside all of them. */
export const INHERITED_GATE_ENV = [
  "LLV_GATE_SLOT_LEASE",
  "LLV_OWNED_TEST_RUNNER_PID",
  "LLV_OWNED_TEST_RUN_CGROUP",
  "LLV_OWNED_RUN_PARENT_IDENTITY",
  "LLV_OWNED_RUN_CPU_SLICE",
  "LLV_OWNED_RUN_CPU_QUOTA",
  "LLV_CPU_WAIT_ROOTS",
  "LLV_GATE_CPU_PRIORITY_SOURCE",
] as const;

/** Unsets the inherited gate context in a fixture environment, and the agent
 * signal-domain marker unless `keepSandbox`. Keys are set to `undefined`, never
 * deleted: helpers such as realExec spread `process.env` under the fixture's
 * environment, so a deleted key comes back from the test process, and spawn
 * omits an undefined one. */
export function withoutInheritedGate<T extends NodeJS.ProcessEnv>(env: T, options: { keepSandbox?: boolean } = {}): T {
  const keys: string[] = [...INHERITED_GATE_ENV];
  if (!options.keepSandbox) keys.push("LLV_SIGNAL_SANDBOX");
  for (const key of keys) (env as NodeJS.ProcessEnv)[key] = undefined;
  return env;
}
