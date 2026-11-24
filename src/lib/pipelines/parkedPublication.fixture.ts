import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

/** Store modules bind paths at import time. Give each group its own process
 * and keep its deadline within the publication gate's per-file budget. */
export function isolatedParkedPublicationTest(file: string, group: "controls" | "recovery"): void {
  test(`isolated parked publication ${group}`, () => {
    const result = spawnSync(process.execPath, ["test", file], {
      env: { ...process.env, LLV_PARKED_PUBLICATION_GROUP: group },
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
  }, 245_000);
}
