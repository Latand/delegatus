import { expect, test } from "bun:test";
import path from "node:path";
import { spawnSync } from "node:child_process";

const entry = path.join(import.meta.dir, "check-worker-entry.py");
const cases = [
  ["birth before exit", "tasks.born(11); tasks.add(11); tasks.departed(11)"],
  ["exit before parent birth receipt", "tasks.add(11); tasks.departed(11); assert not tasks.born(11)"],
  ["exit before the initial child stop", "tasks.departed(11); assert not tasks.born(11)"],
  ["initial child stop before its parent birth receipt", "tasks.add(11); assert 11 not in tasks.announced; assert tasks.born(11); assert 11 in tasks.announced; assert 11 in tasks; tasks.departed(11)"],
  ["PID reuse after the earlier birth is reconciled", "tasks.add(11); tasks.departed(11); assert not tasks.born(11); assert tasks.born(11); tasks.departed(11)"],
] as const;

for (const [name, events] of cases) test.skipIf(process.platform !== "linux")(`native task receipts finish after ${name}`, () => {
  const script = `import runpy,sys
TaskSet=runpy.run_path(sys.argv[1])["TaskSet"]
tasks=TaskSet(10)
${events}
assert tasks == {10}, tasks
tasks.departed(10)
assert not tasks, tasks
assert not tasks.announced, tasks.announced
assert not tasks.early_exits, tasks.early_exits
`;
  const result = spawnSync("python3", ["-I", "-c", script, entry], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});
