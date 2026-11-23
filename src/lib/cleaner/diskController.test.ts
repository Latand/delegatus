import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { DISK_CLEANER_COOLDOWN_MS, diskCleanerThreshold } from "./diskController";

const NOW = Date.UTC(2031, 10, 23, 18);
const PROJECT = "repo-cleaner-fixture";

test("the cleaner threshold is configurable in decimal GB", () => {
  expect(diskCleanerThreshold({})).toBe(150e9);
  expect(diskCleanerThreshold({ LLV_CLEANER_FREE_GB: "12.5" })).toBe(12.5e9);
  expect(diskCleanerThreshold({ LLV_CLEANER_FREE_GB: "-1" })).toBe(150e9);
});

test("pressure admission, cooldown, journal and seat report survive Viewer restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-controller-"));
  const env = isolatedEnvironment(root, process.env);
  env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state");
  delete env.LLV_CLEANER;
  delete env.LLV_CLEANER_FREE_GB;
  delete env.PORT;
  const run = async (at: number, free: number, level: string) => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { reconcileAutomaticDiskCleaner } from "./src/lib/cleaner/diskController";
      import { cleanerJournal } from "./src/lib/cleaner/diskJournal";
      import { diskCleanerReport, diskCleanerSignals } from "./src/lib/cleaner/diskReport";
      import { readDiskCleanerPass } from "./src/lib/cleaner/diskState";
      import { ensureSeatTickCard } from "./src/lib/monitor/seatTickController";
      import { loadTasksForList } from "./src/lib/tasks/store";
      const at = ${at}, free = ${free}, project = ${JSON.stringify(PROJECT)};
      const pressure = { at: new Date(at).toISOString(), episode: null,
        volumes: [{ roles: ["state"], freeBytes: free, level: ${JSON.stringify(level)} }],
        consumers: [], warningBytes: 0, criticalBytes: 0 };
      let releases = 0, cards = 0;
      const ports = {
        now: () => at, active: () => true, project: async () => project,
        measure: () => [{ volume: "fixture", roles: ["state"], freeBytes: free + releases * 4096 }],
        card: async pass => {
          cards++;
          return ensureSeatTickCard(project, { ref: "seat-disk-pressure", kind: "disk-pressure",
            instance: pass.id, state: "resolved", detail: diskCleanerReport(pass), cleanupReport: true }, pressure.at);
        },
        releases: async id => {
          releases++;
          const journal = cleanerJournal(id, "release");
          journal("intent", "/fixture/release", 4096, "verified release");
          journal("removed", "/fixture/release", 4096, "verified release");
          await Bun.sleep(20);
          return { kept: [{ path: "/fixture/running", bytes: 8192, reason: "serving" }], errors: 0 };
        },
        sweep: async () => ({ kept: [], errors: 0, next: null, more: false }),
      };
      await Promise.all([reconcileAutomaticDiskCleaner(pressure, ports), reconcileAutomaticDiskCleaner(pressure, ports)]);
      const pass = readDiskCleanerPass();
      if (pass?.finished) ensureSeatTickCard(project, { ref: "seat-disk-pressure", kind: "disk-pressure",
        instance: pass.id, state: "open", detail: "A stale pressure observation" }, pressure.at);
      console.log(JSON.stringify({ releases, cards, pass: readDiskCleanerPass(),
        signals: diskCleanerSignals(project), other: diskCleanerSignals("repo-other"), tasks: loadTasksForList() }));
    `], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  };
  try {
    expect((await run(NOW, 150e9, "ok")).releases).toBe(0);
    const first = await run(NOW + 1, 150e9 - 1, "ok");
    expect(first).toMatchObject({ releases: 1, cards: 1, other: [],
      pass: { finished: { removed: { release: 4096 }, uncertain: 0 } },
      tasks: [{ project: PROJECT, status: "done" }] });
    expect(first.signals).toEqual([expect.objectContaining({
      id: `disk-cleaner:${first.pass.id}`, actionable: true, label: expect.stringContaining("running (0.00 GiB, serving)"),
    })]);
    expect(first.tasks[0].text).toContain("Прибирання диска завершено");
    const duringCooldown = await run(NOW + DISK_CLEANER_COOLDOWN_MS, 1e9, "critical");
    expect(duringCooldown).toMatchObject({ releases: 0, cards: 0, pass: { id: first.pass.id } });
    const later = await run(NOW + 1 + DISK_CLEANER_COOLDOWN_MS, 170e9, "warning");
    expect(later.releases).toBe(1);
    expect(later.pass.id).not.toBe(first.pass.id);
    expect(later.signals).toHaveLength(2);
    const rows = fs.readFileSync(path.join(env.LLV_STATE_DIR!, "disk-cleaner", `${first.pass.id}.ndjson`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(rows).toEqual(["intent", "removed"].map(phase => expect.objectContaining({
      phase, class: "release", path: "/fixture/release", bytes: 4096, proof: "verified release",
    })));
    const interruptedId = createHash("sha256").update("interrupted cleaner fixture").digest("hex").slice(0, 36);
    const cleaner = path.join(env.LLV_STATE_DIR!, "disk-cleaner");
    fs.writeFileSync(path.join(cleaner, "latest.json"), JSON.stringify({
      id: interruptedId, project: PROJECT, episode: null, mode: "on", startedAt: NOW, before: [],
    }));
    fs.writeFileSync(path.join(cleaner, `${interruptedId}.ndjson`), JSON.stringify({
      phase: "intent", path: "/fixture/interrupted", class: "attempt-temp", bytes: 16384, proof: "verified scratch",
    }) + "\n");
    const interrupted = await run(NOW + 2 * DISK_CLEANER_COOLDOWN_MS, 1e9, "warning");
    expect(interrupted).toMatchObject({ releases: 0, cards: 1, pass: {
      id: interruptedId, finished: { incomplete: true, uncertain: 1, removed: { "attempt-temp": 0 } },
    } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
