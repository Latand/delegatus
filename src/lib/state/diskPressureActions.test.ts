import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { productionDiskPressureActions, reconcileDiskPressure, diskPressureNotice } from "./diskPressureActions";
import { diskVolumes, observeDiskPressure } from "./diskPressure";

test("one board card and one bridge report per episode survive real process restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pressure-actions-"));
  const env = isolatedEnvironment(root, checkEnvironment(process.env));
  const observations: Array<{ cards: Array<{ status: string }>; reports: { reports: unknown[] } }> = [];
  try {
    for (const [at, free] of [["2026-10-28T12:00:00Z", 55], ["2026-10-28T12:01:00Z", 54], ["2026-10-28T12:02:00Z", 53], ["2026-10-28T12:16:00Z", 52], ["2026-10-28T12:17:00Z", 121], ["2026-10-28T12:18:00Z", 55], ["2026-10-28T12:19:00Z", 54]] as const) {
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "diskPressureActions.fixture.ts"), at, String(free)], { env, stdout: "pipe", stderr: "pipe" });
      const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, error).toBe(0);
      observations.push(JSON.parse(out));
    }
    for (const observation of observations.slice(0, 5)) expect(observation.cards).toHaveLength(1);
    expect(observations[4]!.cards[0]!.status).toBe("done");
    expect(observations.at(-1)!.cards).toHaveLength(2);
    expect(observations.at(-1)!.cards.filter(card => card.status === "done")).toHaveLength(1);
    expect(fs.readFileSync(path.join(env.LLV_STATE_DIR!, "early-passes.ndjson"), "utf8").trim().split("\n")).toHaveLength(3);
    // The bridge's own persisted log is the receipt, across all seven writers.
    expect(observations.at(-1)!.reports.reports).toHaveLength(2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("a failed notice effect is retried, and categories are largest first", async () => {
  const pressure = observeDiskPressure(diskVolumes([{ role: "state", directory: "/srv/state" }],
    () => ({ volume: "fixture", totalBytes: 1742 * 1024 ** 3, freeBytes: 55 * 1024 ** 3 })), null, "2031-10-28T12:00:00Z");
  pressure.consumers = [{ kind: "temp", bytes: 1, measuredAt: pressure.at }, { kind: "worktrees", bytes: 100, measuredAt: pressure.at }];
  expect(diskPressureNotice(pressure).indexOf("worktrees")).toBeLessThan(diskPressureNotice(pressure).indexOf("temp:"));
  const ports = productionDiskPressureActions();
  ports.project = async () => "repo-5678abcd"; ports.early = () => {};
  let cards = 0, reports = 0;
  ports.card = async () => { if (++cards === 1) throw new Error("fixture notice refused"); return true; };
  ports.report = async () => ++reports > 1;
  await expect(reconcileDiskPressure(pressure, ports)).rejects.toThrow("fixture notice refused");
  await reconcileDiskPressure(pressure, ports);
  await reconcileDiskPressure(pressure, ports);
  expect(cards).toBe(2); expect(reports).toBe(2);
});
