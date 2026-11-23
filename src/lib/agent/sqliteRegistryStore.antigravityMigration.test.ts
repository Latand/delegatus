import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { AgentRegistry, type AgentRegistryEntry, type RegistryFile } from "./registry";
import { SqliteAgentRegistryStore } from "./sqliteRegistryStore";

/**
 * Exact v1 (3-engine) native caller host predicate from the previous release
 * before Antigravity (`antigravity-acp`) was added.
 */
const PREVIOUS_RELEASE_NATIVE_CALLER_HOST = `collection='entries'
  AND json_extract(value_json,'$.structuredHost.kind') IN ('codex-app-server','claude-broker','copilot-acp')
  AND NOT COALESCE((
    json_extract(value_json,'$.status')='dead'
    AND json_extract(value_json,'$.structuredHost.endpoint')='stdio:released'
    AND (
      (json_extract(value_json,'$.structuredHost.signalDomain.policyVersion')=1
        AND json_type(value_json,'$.structuredHost.signalDomain.retired')='true')
      OR (json_extract(value_json,'$.structuredHost.signalDomain') IS NULL
        AND json_type(value_json,'$.structuredHost.eventCursor') IN ('integer','real')
        AND json_extract(value_json,'$.structuredHost.eventCursor')>0
        AND json_extract(value_json,'$.structuredHost.exitProcess') IS NULL
        AND json_extract(value_json,'$.hostExitProcess') IS NULL
        AND COALESCE(json_array_length(value_json,'$.pendingHostExits'),0)=0)
    )
    AND json_extract(value_json,'$.host') IS NULL
    AND json_extract(value_json,'$.structuredHost.process') IS NULL
    AND json_extract(value_json,'$.structuredHost.scope') IS NULL
    AND json_extract(value_json,'$.structuredHost.memory.unit') IS NULL
    AND json_extract(value_json,'$.claimOwner') IS NULL
    AND json_extract(value_json,'$.pendingAction') IS NULL
    AND COALESCE(json_array_length(value_json,'$.structuredTerminationSurvivors'),0)=0
  ),0)`;

function makeLiveEntry(
  engine: "claude" | "codex" | "copilot" | "antigravity",
  sessionId: string,
  artifactPath: string,
): Omit<AgentRegistryEntry, "updatedAt"> {
  const kind = engine === "claude"
    ? "claude-broker"
    : engine === "codex"
      ? "codex-app-server"
      : engine === "copilot"
        ? "copilot-acp"
        : "antigravity-acp";
  return {
    key: { engine, sessionId },
    artifactPath,
    cwd: path.dirname(artifactPath),
    accountId: null,
    status: "live",
    host: null,
    structuredHost: {
      kind,
      endpoint: `stdio:${kind}`,
      process: { pid: 99001, startIdentity: `99001:${sessionId}`, bootEpoch: "test-boot" },
      protocolVersion: "1",
      writerClaimEpoch: 1,
      eventCursor: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${engine}`,
    pendingAction: null,
  };
}

/**
 * Downgrades a freshly initialized SQLite registry back to the exact previous-release
 * native caller artifacts schema (v1 only: 3-engine partial index, v1 triggers,
 * `native_caller_artifacts_version='1'`, no `native_caller_artifacts_revision`,
 * no `registry_caller_native_host_artifact_v2`).
 */
function downgradeToPreviousReleaseNativeCallerSchema(sqlitePath: string): void {
  const db = new Database(sqlitePath);
  try {
    const pathFrom = (row: "OLD" | "NEW") => `json_extract(${row}.value_json,'$.artifactPath')`;
    const eligible = (row: "OLD" | "NEW") => `COALESCE((${PREVIOUS_RELEASE_NATIVE_CALLER_HOST
      .replaceAll("collection", `${row}.collection`).replaceAll("value_json", `${row}.value_json`)}
      AND json_type(${row}.value_json,'$.artifactPath')='text' AND ${pathFrom(row)}<>''),0)`;
    const add = `INSERT INTO registry_native_host_paths(path)
      SELECT ${pathFrom("NEW")} WHERE ${eligible("NEW")} ON CONFLICT(path) DO NOTHING;`;
    const remove = `DELETE FROM registry_native_host_paths WHERE path=${pathFrom("OLD")} AND ${eligible("OLD")}
      AND NOT EXISTS (SELECT 1 FROM registry_rows INDEXED BY registry_caller_native_host_artifact
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST} AND json_extract(value_json,'$.artifactPath')=${pathFrom("OLD")});`;
    db.exec(`
      DROP TRIGGER IF EXISTS registry_native_host_paths_insert;
      DROP TRIGGER IF EXISTS registry_native_host_paths_delete;
      DROP TRIGGER IF EXISTS registry_native_host_paths_update;
      DROP INDEX IF EXISTS registry_caller_native_host_artifact_v2;
      DROP INDEX IF EXISTS registry_caller_native_host_artifact;
      CREATE INDEX registry_caller_native_host_artifact ON registry_rows(json_extract(value_json,'$.artifactPath'))
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST};
      DELETE FROM registry_native_host_paths;
      INSERT INTO registry_native_host_paths
        SELECT DISTINCT json_extract(value_json,'$.artifactPath')
        FROM registry_rows INDEXED BY registry_caller_native_host_artifact
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST}
          AND json_type(value_json,'$.artifactPath')='text'
          AND json_extract(value_json,'$.artifactPath')<>'';
      CREATE TRIGGER registry_native_host_paths_insert AFTER INSERT ON registry_rows WHEN ${eligible("NEW")} BEGIN ${add} END;
      CREATE TRIGGER registry_native_host_paths_delete AFTER DELETE ON registry_rows WHEN ${eligible("OLD")} BEGIN ${remove} END;
      CREATE TRIGGER registry_native_host_paths_update AFTER UPDATE ON registry_rows
        WHEN (${eligible("OLD")} OR ${eligible("NEW")})
          AND (${pathFrom("OLD")} IS NOT ${pathFrom("NEW")} OR ${eligible("OLD")} IS NOT ${eligible("NEW")})
        BEGIN ${remove} ${add} END;
      DELETE FROM registry_meta WHERE key='native_caller_artifacts_revision';
      INSERT OR REPLACE INTO registry_meta(key,value) VALUES ('native_caller_artifacts_version','1');
    `);
  } finally {
    db.close();
  }
}

describe("SqliteAgentRegistryStore native caller index migration for Antigravity", () => {
  let root: string;
  let prevStateDir: string | undefined;
  let prevStateOwner: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-ag-sqlite-mig-"));
    prevStateDir = process.env.LLV_STATE_DIR;
    prevStateOwner = process.env.LLV_STATE_OWNER;
    process.env.LLV_STATE_DIR = root;
    process.env.LLV_STATE_OWNER = "test";
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = prevStateDir;
    if (prevStateOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = prevStateOwner;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("upgrades a previous-release registry in place, preserves rows, uses versioned indexes for all engines, and remains rollback-compatible", () => {
    const registryJsonPath = path.join(root, "agent-registry.json");
    const sqlitePath = path.join(root, "agent-registry.sqlite");
    const artifactsDir = path.join(root, "artifacts");
    fs.mkdirSync(artifactsDir, { recursive: true });

    const claudeArtifact = path.join(artifactsDir, "claude-1.jsonl");
    const codexArtifact = path.join(artifactsDir, "codex-1.jsonl");
    const copilotArtifact = path.join(artifactsDir, "copilot-1.jsonl");
    const antigravityArtifact = path.join(artifactsDir, "antigravity-1.jsonl");
    for (const file of [claudeArtifact, codexArtifact, copilotArtifact, antigravityArtifact]) {
      fs.writeFileSync(file, "{\"type\":\"session.start\"}\n", "utf8");
    }

    // 1. Seed a SQLite-backed registry with the three existing engines, then rewrite its
    //    native caller schema to the exact previous-release (v1) index & triggers.
    const initial = new AgentRegistry(registryJsonPath, undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: sqlitePath,
    });
    initial.upsert(makeLiveEntry("claude", "claude-1", claudeArtifact));
    initial.upsert(makeLiveEntry("codex", "codex-1", codexArtifact));
    initial.upsert(makeLiveEntry("copilot", "copilot-1", copilotArtifact));
    initial.close();

    downgradeToPreviousReleaseNativeCallerSchema(sqlitePath);

    // Sanity-check that we truly recreated the exact previous-release schema.
    const beforeDb = new Database(sqlitePath, { readonly: true });
    try {
      const indexes = beforeDb.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'registry_caller_native_host_artifact%'",
      ).all().map((row) => row.name);
      expect(indexes).toEqual(["registry_caller_native_host_artifact"]);
      expect(
        beforeDb.query<{ value: string }, []>(
          "SELECT value FROM registry_meta WHERE key='native_caller_artifacts_revision'",
        ).get(),
      ).toBeNull();
    } finally {
      beforeDb.close();
    }

    // 2. Open the previous-release DB with the new store: it must upgrade in place
    //    without losing rows, and index both legacy engines and Antigravity.
    const upgraded = new AgentRegistry(registryJsonPath, undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: sqlitePath,
    });
    upgraded.upsert(makeLiveEntry("antigravity", "ag-1", antigravityArtifact));

    const snap = upgraded.readOnlySnapshot();
    expect(Object.keys(snap.entries).sort()).toEqual([
      "antigravity:ag-1",
      "claude:claude-1",
      "codex:codex-1",
      "copilot:copilot-1",
    ]);

    // Verify all four engines are tracked in registry_native_host_paths and visible on a second connection.
    const second = new SqliteAgentRegistryStore(sqlitePath, {
      initialSnapshot: () => ({} as RegistryFile),
      normalize: (file) => file as RegistryFile,
      allowArchiveMigration: false,
    });
    const inspectDb = new Database(sqlitePath, { readonly: true });
    try {
      const trackedPaths = inspectDb.query<{ path: string }, []>(
        "SELECT path FROM registry_native_host_paths ORDER BY path",
      ).all().map((row) => row.path);
      expect(trackedPaths).toEqual([
        antigravityArtifact,
        claudeArtifact,
        codexArtifact,
        copilotArtifact,
      ].sort());

      // New release query MUST use registry_caller_native_host_artifact_v2 (no `no query solution`).
      const v2Plan = inspectDb.query<{ detail: string }, [string]>(`
        EXPLAIN QUERY PLAN
        SELECT row_key,value_json FROM json_each(?) AS alias
        CROSS JOIN registry_rows INDEXED BY registry_caller_native_host_artifact_v2
        WHERE collection='entries'
          AND json_extract(value_json,'$.structuredHost.kind') IN ('codex-app-server','claude-broker','copilot-acp','antigravity-acp')
          AND NOT COALESCE((
            json_extract(value_json,'$.status')='dead'
            AND json_extract(value_json,'$.structuredHost.endpoint')='stdio:released'
            AND (
              (json_extract(value_json,'$.structuredHost.signalDomain.policyVersion')=1
                AND json_type(value_json,'$.structuredHost.signalDomain.retired')='true')
              OR (json_extract(value_json,'$.structuredHost.signalDomain') IS NULL
                AND json_type(value_json,'$.structuredHost.eventCursor') IN ('integer','real')
                AND json_extract(value_json,'$.structuredHost.eventCursor')>0
                AND json_extract(value_json,'$.structuredHost.exitProcess') IS NULL
                AND json_extract(value_json,'$.hostExitProcess') IS NULL
                AND COALESCE(json_array_length(value_json,'$.pendingHostExits'),0)=0)
            )
            AND json_extract(value_json,'$.host') IS NULL
            AND json_extract(value_json,'$.structuredHost.process') IS NULL
            AND json_extract(value_json,'$.structuredHost.scope') IS NULL
            AND json_extract(value_json,'$.structuredHost.memory.unit') IS NULL
            AND json_extract(value_json,'$.claimOwner') IS NULL
            AND json_extract(value_json,'$.pendingAction') IS NULL
            AND COALESCE(json_array_length(value_json,'$.structuredTerminationSurvivors'),0)=0
          ),0)
          AND json_extract(value_json,'$.artifactPath')=alias.value
        LIMIT 257
      `).all(JSON.stringify([antigravityArtifact, claudeArtifact]));
      expect(v2Plan.some((row) => row.detail.includes("USING INDEX registry_caller_native_host_artifact_v2"))).toBe(true);

      // 3. Rollback compatibility: the previous release MUST see native_caller_artifacts_version='1'
      //    (so it does NOT re-run non-idempotent CREATE TABLE), and its exact 3-engine query
      //    against INDEXED BY registry_caller_native_host_artifact MUST still use the v1 index
      //    and return Claude/Codex/Copilot rows cleanly.
      expect(
        inspectDb.query<{ value: string }, []>(
          "SELECT value FROM registry_meta WHERE key='native_caller_artifacts_version'",
        ).get()?.value,
      ).toBe("1");
      expect(
        inspectDb.query<{ value: string }, []>(
          "SELECT value FROM registry_meta WHERE key='native_caller_artifacts_revision'",
        ).get()?.value,
      ).toBe("2");

      const rollbackPlan = inspectDb.query<{ detail: string }, [string]>(`
        EXPLAIN QUERY PLAN
        SELECT row_key,value_json FROM json_each(?) AS alias
        CROSS JOIN registry_rows INDEXED BY registry_caller_native_host_artifact
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST}
          AND json_extract(value_json,'$.artifactPath')=alias.value
        LIMIT 257
      `).all(JSON.stringify([claudeArtifact, codexArtifact, copilotArtifact]));
      expect(rollbackPlan.some((row) => row.detail.includes("USING INDEX registry_caller_native_host_artifact "))).toBe(true);

      const rollbackRows = inspectDb.query<{ row_key: string }, [string]>(`
        SELECT row_key FROM json_each(?) AS alias
        CROSS JOIN registry_rows INDEXED BY registry_caller_native_host_artifact
        WHERE ${PREVIOUS_RELEASE_NATIVE_CALLER_HOST}
          AND json_extract(value_json,'$.artifactPath')=alias.value
        ORDER BY row_key
      `).all(JSON.stringify([claudeArtifact, codexArtifact, copilotArtifact, antigravityArtifact]));
      expect(rollbackRows.map((row) => row.row_key)).toEqual([
        "claude:claude-1",
        "codex:codex-1",
        "copilot:copilot-1",
      ]);

      // Second read-only connection sees all four entries via registry_rows as well.
      const secondEntries = Object.keys(second.readOnlySnapshot().file.entries).sort();
      expect(secondEntries).toEqual([
        "antigravity:ag-1",
        "claude:claude-1",
        "codex:codex-1",
        "copilot:copilot-1",
      ]);
    } finally {
      inspectDb.close();
      second.close();
    }

    // 4. Verify delete trigger works cleanly after upgrade (removes path from registry_native_host_paths).
    const writeDb = new Database(sqlitePath);
    try {
      writeDb.query("DELETE FROM registry_rows WHERE collection='entries' AND row_key='antigravity:ag-1'").run();
      const remaining = writeDb.query<{ path: string }, []>(
        "SELECT path FROM registry_native_host_paths ORDER BY path",
      ).all().map((row) => row.path);
      expect(remaining).toEqual([claudeArtifact, codexArtifact, copilotArtifact].sort());
    } finally {
      writeDb.close();
    }

    upgraded.close();
  });

  test("unmigrated previous-release DB opened with allowArchiveMigration=false still queries v1 index cleanly", () => {
    const registryJsonPath = path.join(root, "readonly-registry.json");
    const sqlitePath = path.join(root, "readonly-registry.sqlite");
    const claudeArtifact = path.join(root, "claude-ro.jsonl");
    fs.writeFileSync(claudeArtifact, "{\"type\":\"session.start\"}\n", "utf8");

    const seed = new AgentRegistry(registryJsonPath, undefined, undefined, {
      sqliteMode: "sqlite",
      sqliteFilename: sqlitePath,
    });
    seed.upsert(makeLiveEntry("claude", "claude-ro", claudeArtifact));
    seed.close();

    downgradeToPreviousReleaseNativeCallerSchema(sqlitePath);

    const noMigrate = new SqliteAgentRegistryStore(sqlitePath, {
      initialSnapshot: () => ({} as RegistryFile),
      normalize: (file) => file as RegistryFile,
      allowArchiveMigration: false,
    });
    try {
      // Does not throw `no query solution` even though revision '2' was not installed.
      expect(noMigrate.readOnlySnapshot().file.entries["claude:claude-ro"]?.artifactPath).toBe(claudeArtifact);
    } finally {
      noMigrate.close();
    }
  });
});
