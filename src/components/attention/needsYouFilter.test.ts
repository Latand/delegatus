import { expect, test } from "bun:test";
import { join } from "node:path";

/*
 * The «Needs you» filter reads one attribute on <main> and one CSS block
 * (docs/design/needs-me-filter.md). The channel that once carried the waiting
 * conversations' paths into the boards, and the scheme's dimming helper it fed,
 * were removed with it: nothing under src/ may name them again.
 */

const REMOVED = ["attentionPaths", "dimClass"];

test("the removed filter channel and the scheme's dim helper have no importers or mentions left", async () => {
  const root = join(import.meta.dir, "..", "..");
  const offenders: string[] = [];
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
    if (file === "components/attention/needsYouFilter.test.ts") continue;
    const text = await Bun.file(join(root, file)).text();
    for (const name of REMOVED) if (text.includes(name)) offenders.push(`${file}: ${name}`);
  }
  expect(offenders).toEqual([]);
});
