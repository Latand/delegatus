import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { DISK_CLEANER_COOLDOWN_MS, diskCleanerThreshold, measureCleanerSpace } from "./diskController";

const NOW = Date.UTC(2031, 10, 23, 18);
const PROJECT = "repo-cleaner-fixture";

test("the cleaner threshold is configurable in decimal GB", () => {
  expect(diskCleanerThreshold({})).toBe(150e9);
  expect(diskCleanerThreshold({ LLV_CLEANER_FREE_GB: "12.5" })).toBe(12.5e9);
  expect(diskCleanerThreshold({ LLV_CLEANER_FREE_GB: "-1" })).toBe(150e9);
});

test("a pressure reading through a host-only view is retained before and becomes unknown when its view disappears", () => {
  const pressure = { at: new Date(NOW).toISOString(), episode: "host-view-episode",
    volumes: [{ volume: "host-only-volume", roles: ["temp"], freeBytes: 42, level: "warning" as const, views: ["mnt:[host]:fixture"] }],
    consumers: [], warningBytes: 100, criticalBytes: 10 };
  expect(measureCleanerSpace(pressure, true)).toContainEqual({ volume: "host-only-volume", roles: ["temp"], freeBytes: 42 });
  expect(measureCleanerSpace(pressure, false)).toContainEqual({ volume: "host-only-volume", roles: ["temp"], freeBytes: null });
});

test("unchanged zero-byte passes back off across restarts and wake on a retained root change or audit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-backoff-"));
  const env = isolatedEnvironment(root, process.env);
  env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state");
  delete env.PORT;
  const kept = path.join(env.LLV_STATE_DIR, "scratch", "fixture");
  fs.mkdirSync(kept, { recursive: true });
  const run = async (beat: number) => {
    const command = `
      import { reconcileAutomaticDiskCleaner } from "./src/lib/cleaner/diskController";
      import { readDiskCleanerPass } from "./src/lib/cleaner/diskState";
      const [at, kept] = process.argv.slice(1);
      const pressure = { at: new Date(+at).toISOString(), episode: "fixture",
        volumes: [{ volume: "fixture", roles: ["temp"], freeBytes: 1, level: "warning" }],
        consumers: [], warningBytes: 10, criticalBytes: 1 };
      let walks = 0;
      await reconcileAutomaticDiskCleaner(pressure, {
        now: () => +at, active: () => true, project: async () => "fixture", card: async () => true,
        env: { LLV_CLEANER: "dry-run" },
        measure: () => [{ volume: "fixture", roles: ["temp"], freeBytes: 1 }],
        releases: async () => ({ kept: [], errors: 0 }),
        sweep: async request => ({ kept: request.class === "attempt-temp"
          ? (++walks, [{ path: kept, reason: "fixture hold", bytes: 4096 }]) : [], errors: 0, next: null, more: false }),
      });
      console.log(JSON.stringify({ walks, retry: readDiskCleanerPass()?.finished?.retained?.retryAt }));
    `;
    const child = Bun.spawn([process.execPath, "-e", command, String(NOW + beat * DISK_CLEANER_COOLDOWN_MS), kept], {
      env, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  };
  try {
    expect((await run(0)).walks).toBe(1);
    expect(await run(1)).toEqual({ walks: 1, retry: NOW + 5 * DISK_CLEANER_COOLDOWN_MS });
    expect((await run(2)).walks).toBe(0);
    fs.writeFileSync(path.join(kept, "changed"), "data");
    expect((await run(3)).walks).toBe(1);
    expect((await run(6)).walks).toBe(0);
    expect((await run(7)).walks).toBe(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("a contended slice resumes the same cleaner pass and selection on the short retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-resume-"));
  const env = isolatedEnvironment(root, process.env);
  env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state"); delete env.PORT;
  const child = Bun.spawn([process.execPath, "-e", `
    import { reconcileAutomaticDiskCleaner } from "./src/lib/cleaner/diskController";
    import { readDiskCleanerPass } from "./src/lib/cleaner/diskState";
    import { SweepWalkDeferred } from "./src/lib/pipelines/sweepWalkAdmission";
    let at = 100000, evidence = 0, scratch = 0;
    const pressure = { at: new Date(at).toISOString(), episode: "fixture", volumes: [
      { volume: "fixture", roles: ["temp"], freeBytes: 1, level: "warning" }], consumers: [], warningBytes: 10, criticalBytes: 1 };
    const ports = { now: () => at, active: () => true, project: async () => "fixture", card: async () => true,
      env: { LLV_CLEANER: "dry-run" }, measure: () => [{ volume: "fixture", roles: ["temp"], freeBytes: 1 }],
      releases: async () => ({ kept: [], errors: 0 }), sweep: async request => {
        if (request.class === "evidence" && evidence++ === 0) throw new SweepWalkDeferred("busy");
        if (request.class === "attempt-temp") scratch++;
        return { kept: [], errors: 0, next: null, more: false };
      } };
    await reconcileAutomaticDiskCleaner(pressure, ports);
    const interrupted = readDiskCleanerPass();
    at += 30001; pressure.at = new Date(at).toISOString();
    await reconcileAutomaticDiskCleaner(pressure, ports);
    console.log(JSON.stringify({ interrupted, final: readDiskCleanerPass(), evidence, scratch }));
  `], { env, stdout: "pipe", stderr: "pipe" });
  try {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const result = JSON.parse(out.trim().split("\n").at(-1)!);
    expect(result.interrupted).toMatchObject({ id: expect.any(String), deferredAt: expect.any(Number), evidenceSlices: 0 });
    expect(result.final).toMatchObject({ id: result.interrupted.id, finished: { incomplete: false } });
    expect(result).toMatchObject({ evidence: 2, scratch: 1 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("critical pressure wakes the cleaner during unchanged warning backoff", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-critical-wake-"));
  const env = isolatedEnvironment(root, process.env);
  env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state"); delete env.PORT;
  const run = async (minutes: number, free: number, level: "warning" | "critical", volume = "fixture") => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { reconcileAutomaticDiskCleaner } from "./src/lib/cleaner/diskController";
      import { readDiskCleanerPass } from "./src/lib/cleaner/diskState";
      const at = ${NOW} + ${minutes} * 60000, free = ${free}, level = ${JSON.stringify(level)}, volume = ${JSON.stringify(volume)};
      const pressure = { at: new Date(at).toISOString(), episode: "same-episode",
        volumes: [{ volume, roles: ["temp"], freeBytes: free, level }], consumers: [], warningBytes: 10, criticalBytes: 1 };
      let releases = 0;
      await reconcileAutomaticDiskCleaner(pressure, { now: () => at, active: () => true, project: async () => "fixture", card: async () => true,
        env: { LLV_CLEANER: "dry-run" }, measure: () => [{ volume, roles: ["temp"], freeBytes: free }],
        releases: async () => { releases++; return { kept: [], errors: 0 }; },
        sweep: async () => ({ kept: [], errors: 0, next: null, more: false }) });
      console.log(JSON.stringify({ releases, pass: readDiskCleanerPass()?.id }));
    `], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    return JSON.parse(out.trim().split("\n").at(-1)!);
  };
  try {
    const first = await run(0, 2.25 * 1024 ** 3, "warning");
    const second = await run(15, 2.25 * 1024 ** 3, "warning");
    expect(first.releases).toBe(1);
    expect(second.releases).toBe(1);
    expect((await run(20, 2.25 * 1024 ** 3, "warning")).pass).toBe(second.pass);
    expect((await run(20, 1.75 * 1024 ** 3, "critical")).releases).toBe(1);
    expect((await run(21, 1.75 * 1024 ** 3, "warning")).releases).toBe(0);
    expect((await run(22, 1.75 * 1024 ** 3, "critical", "new-critical-volume")).releases).toBe(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("pressure admission, cooldown, journal and seat report survive Viewer restarts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "disk-cleaner-controller-"));
  const env = isolatedEnvironment(root, process.env);
  env.LLV_STATE_DIR = path.join(env.TMPDIR!, "state");
  delete env.LLV_CLEANER;
  delete env.LLV_CLEANER_FREE_GB;
  delete env.PORT;
  const run = async (at: number, free: number, level: string, volume = "pressure-mount") => {
    const child = Bun.spawn([process.execPath, "-e", `
      import { reconcileAutomaticDiskCleaner } from "./src/lib/cleaner/diskController";
      import { cleanerJournal } from "./src/lib/cleaner/diskJournal";
      import { diskCleanerReport, diskCleanerSignals } from "./src/lib/cleaner/diskReport";
      import { readDiskCleanerPass } from "./src/lib/cleaner/diskState";
      import { ensureSeatTickCard } from "./src/lib/monitor/seatTickController";
      import { loadTasksForList } from "./src/lib/tasks/store";
      const at = ${at}, free = ${free}, project = ${JSON.stringify(PROJECT)};
      const pressure = { at: new Date(at).toISOString(), episode: null,
        volumes: [{ volume: ${JSON.stringify(volume)}, roles: ["worktrees"], freeBytes: free, level: ${JSON.stringify(level)} }],
        consumers: [], warningBytes: 0, criticalBytes: 0 };
      let releases = 0, cards = 0;
      const ports = {
        now: () => at, active: () => true, project: async () => project,
        measure: observed => [
          { volume: "fixture", roles: ["state"], freeBytes: free + releases * 4096 },
          ...observed.volumes.map(volume => ({ volume: volume.volume!, roles: volume.roles, freeBytes: free + releases * 4096 })),
        ],
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
        signals: await diskCleanerSignals(project), other: await diskCleanerSignals("repo-other"), tasks: loadTasksForList() }));
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
    expect(first.pass.before).toContainEqual({ volume: "pressure-mount", roles: ["worktrees"], freeBytes: 150e9 - 1 });
    expect(first.pass.finished.after).toContainEqual({ volume: "pressure-mount", roles: ["worktrees"], freeBytes: 150e9 - 1 + 4096 });
    expect(first.signals[0].label).toContain("worktrees 139.70 GiB → 139.70 GiB");
    expect(first.tasks[0].text).toContain("Прибирання диска завершено");
    const duringCooldown = await run(NOW + DISK_CLEANER_COOLDOWN_MS, 1e9, "critical");
    expect(duringCooldown.releases).toBe(1);
    expect(duringCooldown.pass.id).not.toBe(first.pass.id);
    const newlyCritical = await run(NOW + DISK_CLEANER_COOLDOWN_MS + 1, 1e9, "critical", "new-critical-volume");
    expect(newlyCritical.releases).toBe(1);
    expect(newlyCritical.pass.id).not.toBe(duringCooldown.pass.id);
    const later = await run(NOW + 1 + DISK_CLEANER_COOLDOWN_MS, 170e9, "warning", "new-critical-volume");
    expect(later.releases).toBe(0);
    expect(later.pass.id).toBe(newlyCritical.pass.id);
    expect(later.signals).toHaveLength(3);
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
