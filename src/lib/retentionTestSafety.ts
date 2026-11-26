import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const declaredTest = () => process.env.NODE_ENV === "test"
  || !!process.env.LLV_FIXTURE_PARENT_IDENTITY || !!process.env.LLV_TEST_STARTUP_HOME;
// Keep the original boundary even when a fixture changes NODE_ENV or TMPDIR.
const startedUnderTest = declaredTest();
const testRoot = startedUnderTest ? fs.realpathSync(os.tmpdir()) : undefined;
export const retentionUnderTest = () => startedUnderTest || declaredTest();
export class RetentionTestSafetyError extends Error {}

/** Test retention may only reach its private temp tree. Resolve existing
 * ancestors so a link inside that tree cannot grant access to live state.
 * This check precedes locks, ledger writes, discovery and removal. */
export function assertRetentionTestPath(filename: string): void {
  if (!retentionUnderTest()) return;
  const root = testRoot ?? fs.realpathSync(os.tmpdir());
  const inside = (target: string) => target !== root && target.startsWith(root + path.sep);
  const suffix: string[] = [];
  let existing = path.resolve(filename);
  if (!inside(existing)) throw new RetentionTestSafetyError("retention test refused a path outside its private temp root");
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) {
    suffix.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const physical = path.join(fs.realpathSync(existing), ...suffix);
  if (inside(physical)) return;
  throw new RetentionTestSafetyError("retention test refused a path outside its private temp root");
}
