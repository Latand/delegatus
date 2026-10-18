import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { AgentRegistry, normalizeRegistry } from "./registry";
import { buildRegistryPerformanceDataset, scaledRegistryPerformanceShape } from "./registryPerformanceDataset";
import { spawnSync } from "node:child_process";
import { IDENTITY_WAVE_MIGRATION } from "./identityWaveMigration";

for (const mode of ["sqlite", "read", "dual-write", "off"]) {
  test(`fresh ${mode} startup commits its identity marker and the next process sees completion`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "identity-fresh-start-"));
    for (const name of ["home", "config", "tmp", "state"]) fs.mkdirSync(path.join(directory, name));
    const entry = new URL("./identityWaveStartup.ts", import.meta.url).href;
    const script = `
      import { runIdentityWaveMigrationAtStartup, readIdentityWaveRegistrySnapshot } from ${JSON.stringify(entry)};
      const result = runIdentityWaveMigrationAtStartup({ now: () => "2026-10-18T00:00:00.000Z", log: () => {} });
      console.log(JSON.stringify({result, marker: readIdentityWaveRegistrySnapshot().identityMigrations[${JSON.stringify(IDENTITY_WAVE_MIGRATION)}]}));
    `;
    try {
      for (const alreadyCompleted of [false, true]) {
        const child = spawnSync(process.execPath, ["--eval", script], {
          cwd: process.cwd(), encoding: "utf8", timeout: 20_000,
          env: { ...process.env, HOME: path.join(directory, "home"), XDG_CONFIG_HOME: path.join(directory, "config"),
            TMPDIR: path.join(directory, "tmp"), LLV_STATE_DIR: path.join(directory, "state"),
            LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1", LLV_AGENT_REGISTRY_SQLITE: mode,
            LLV_STATE_OWNER: undefined, LLV_IDENTITY_WAVE_DRY_RUN: undefined },
        });
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr).toBe(0);
        expect(child.stderr).not.toContain("registry migration failed");
        expect(child.stderr).not.toContain("SQLiteError");
        const output = JSON.parse(child.stdout);
        expect(output.result).toEqual({ dryRun: false, alreadyCompleted, retitled: 0, rekeyed: 0, quarantinedRekeys: 0, edgesStamped: 0 });
        expect(output.marker).toEqual({ completedAt: "2026-10-18T00:00:00.000Z", retitled: 0, rekeyed: 0, quarantinedRekeys: 0, edgesStamped: 0 });
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const failure of ["peer-write", "evidence-read"] as const) {
  test(`SQLite legacy migration preserves state after ${failure} and retries successfully`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "identity-legacy-retry-"));
    const filename = path.join(directory, "agent-registry.json");
    const id = "conversation_legacy_fixture";
    const now = "2026-10-18T00:00:00.000Z";
    const transcript = path.join(directory, "native-fixture.jsonl");
    fs.writeFileSync(filename, JSON.stringify(normalizeRegistry({
      version: 2, entries: {}, receipts: {}, conversations: { [id]: {
        id, engine: "codex", generations: [{ id: "native-fixture", path: transcript, accountId: null,
          launchProfile: { title: "Codex session" }, host: null, historyHash: null, createdAt: now, archivedAt: null }],
        createdAt: now, updatedAt: now, continuityPaths: [], migration: null,
        turn: { state: "unknown", source: "empty", terminalAt: null, observedAt: null },
      } },
    })));
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const writer = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    let fail = true;
    const peerPath = path.join(directory, "peer-continuity.jsonl");
    const input = { now, orchestratorSeats: [], transcriptTitle: () => "Recovered legacy title",
      sharedPathForLegacy: () => {
        if (fail) {
          fail = false;
          if (failure === "evidence-read") throw new Error("fixture evidence unavailable");
          writer.recordConversationContinuityPath(id, peerPath);
        }
        return null;
      },
    };
    try {
      expect(() => registry.runIdentityWaveMigration(input)).toThrow(failure === "peer-write"
        ? "state changed while reading evidence" : "fixture evidence unavailable");
      expect(writer.snapshot().identityMigrations[IDENTITY_WAVE_MIGRATION]).toBeUndefined();
      expect(writer.conversation(id)?.generations[0]?.launchProfile.title).toBe("Codex session");
      expect(registry.runIdentityWaveMigration(input)).toMatchObject({ alreadyCompleted: false, retitled: 1 });
      expect(writer.conversation(id)?.generations[0]?.launchProfile.title).toBe("Recovered legacy title");
      if (failure === "peer-write") expect(writer.conversation(id)?.continuityPaths).toContain(peerPath);
    } finally { registry.close(); writer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const dryRun of [false, true]) {
  test(`completed identity migration leaves retained history unread and takes no write lease (dryRun=${dryRun})`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "identity-completed-history-"));
    const dataset = buildRegistryPerformanceDataset(directory, scaledRegistryPerformanceShape(0.03));
    const filename = path.join(directory, "agent-registry.json");
    const reads = new Map<string, number>();
    const registry = new AgentRegistry(filename, undefined, undefined, {
      sqliteMode: "sqlite",
      onSqliteRowPayloadRead: (collection, count) => reads.set(collection, (reads.get(collection) ?? 0) + count),
    });
    const writer = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    try {
      expect(dataset.coldRows).toBeGreaterThan(500);
      registry.readOnlySnapshot();
      // An unrelated writer's revision must not make a completed migration
      // clone the archive or attempt another migration transaction.
      writer.ensureConversation("codex", "/sessions/external-new.jsonl", null);
      reads.clear();
      const result = registry.runIdentityWaveMigration({
        dryRun,
        now: new Date().toISOString(),
        orchestratorSeats: [],
        transcriptTitle: () => { throw new Error("completed migration read transcript evidence"); },
        sharedPathForLegacy: () => { throw new Error("completed migration read rekey evidence"); },
        commitExternalPathRekeys: () => { throw new Error("completed migration wrote external state"); },
      }, () => { throw new Error("completed migration entered a write transaction"); });
      expect(result).toEqual({ dryRun, alreadyCompleted: true, retitled: 0, rekeyed: 0, quarantinedRekeys: 0, edgesStamped: 0 });
      expect([...reads.values()].reduce((total, count) => total + count, 0)).toBeLessThan(50);
      expect(writer.conversationForPath("/sessions/external-new.jsonl")).not.toBeNull();
    } finally {
      registry.close();
      writer.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
