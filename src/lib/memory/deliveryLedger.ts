import { declaredIndexes } from "@/lib/state/declaredIndexes";
import { engineMemoryOff } from "@/lib/memory/source";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { statePath } from "@/lib/configDir";
import { stateLockAttempt, waitForStateLock } from "@/lib/state/lockWait";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { repositoryRootForPath } from "@/lib/projects/identity";
import { spawnLeasedHelper } from "@/lib/helperLease";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import type { learnedRulesSnapshot } from "./roleStore";

export const DELIVERY_LEDGER_STARTS = 10_000;
export const DELIVERY_LEDGER_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

function sqliteDatabase(): typeof import("bun:sqlite").Database {
  /* Resolve Bun's builtin only when the ledger is used. Route modules that
     import role-launch policy are also loaded by Next's Node build workers. */
  const sqlite = process.getBuiltinModule?.("bun:sqlite") as typeof import("bun:sqlite") | undefined;
  if (!sqlite) throw new Error("The memory delivery ledger requires the Bun runtime");
  return sqlite.Database;
}

export interface MemoryEngineStart {
  engine: "codex" | "claude";
  conversationId: string;
  attempt?: { pipelineId: string; stageId: string; attempt: number };
  cwd: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Effective native-memory decision resolved by the launch policy. */
  nativeMemoryEnabled?: boolean;
  /** Fallback used by the native Claude spawn policy when home settings are absent. */
  claudeSettingsPath?: string | null;
  /** Claude provider starts pass --setting-sources "" and exclude home/project settings. */
  providerAccount?: boolean;
}
type Selection = Pick<ReturnType<typeof learnedRulesSnapshot>, "block" | "scopes" | "rules"> & { reason?: string; shadowIds?: string[]; removed?: import("./roleSelection").SelectionRemoval[] };
export interface MemoryDelivery {
  schemaVersion: 1;
  conversationId: string;
  attempt?: MemoryEngineStart["attempt"];
  engine: MemoryEngineStart["engine"];
  at: string;
  scopes: Selection["scopes"];
  rules: Selection["rules"];
  bytes: number;
  reason?: string;
  shadowIds?: string[];
  removed?: import("./roleSelection").SelectionRemoval[];
  engineMemory: { kind: "claude-index" | "codex-summary"; hash: string; bytes: number; loadedBytes: number }[];
}
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function optionalFile(file: string): Promise<Buffer | null> {
  try {
    const handle = await fs.promises.open(file, "r");
    try {
      // One extra byte detects growth after stat without an unbounded allocation.
      const data = Buffer.alloc(MAX_FILE_BYTES + 1);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > MAX_FILE_BYTES) throw Error("engine memory file exceeds snapshot limit");
      return data.subarray(0, offset);
    } finally { await handle.close(); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function engineMemory(start: MemoryEngineStart, clean: boolean) {
  if (engineMemoryOff({ cleanMemory: clean }) || start.nativeMemoryEnabled === false) return [];
  const home = start.home ?? path.join(start.env?.HOME ?? process.env.HOME ?? os.homedir(), start.engine === "codex" ? ".codex" : ".claude");
  let file: string;
  if (start.engine === "codex") {
    if (start.nativeMemoryEnabled !== true) {
      const configFile = await optionalFile(path.join(home, "config.toml"));
      const config = configFile ? Bun.TOML.parse(configFile.toString("utf8")) as { features?: { memories?: boolean }; memories?: { use_memories?: boolean } } : {};
      if (config.features?.memories === false || config.memories?.use_memories === false) return [];
    }
    file = path.join(home, "memories", "memory_summary.md");
  } else {
    let root = repositoryRootForPath(start.cwd) ?? start.cwd;
    // A linked checkout loads its parent repository index, including arbitrary paths.
    try {
      const gitFile = path.join(root, ".git");
      const git = (await fs.promises.stat(gitFile)).isFile() ? (await fs.promises.readFile(gitFile, "utf8")).match(/^gitdir:\s*(.+)/) : null;
      if (git) {
        const gitDir = path.resolve(root, git[1].trim());
        const common = (await fs.promises.readFile(path.join(gitDir, "commondir"), "utf8")).trim();
        root = path.dirname(path.resolve(gitDir, common));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    type Settings = { autoMemoryEnabled?: boolean; autoMemoryDirectory?: string; env?: Record<string, string> };
    const homeSettings = await optionalFile(path.join(home, "settings.json"));
    const baseSettings = !homeSettings && start.claudeSettingsPath ? await optionalFile(start.claudeSettingsPath) : null;
    let settings: Settings = start.providerAccount
      ? (homeSettings ? {} : baseSettings ? JSON.parse(baseSettings.toString("utf8")) as Settings : {})
      : (homeSettings ?? baseSettings) ? JSON.parse((homeSettings ?? baseSettings)!.toString("utf8")) as Settings : {};
    if (!start.providerAccount) {
      for (const settingsFile of [path.join(root, ".claude", "settings.json"), path.join(root, ".claude", "settings.local.json")]) {
        const data = await optionalFile(settingsFile);
        if (data) { const next = JSON.parse(data.toString("utf8")) as Settings; settings = { ...settings, ...next, env: { ...settings.env, ...next.env } }; }
      }
    }
    if (settings.autoMemoryEnabled === false || settings.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1") return [];
    if (start.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1" && !settings.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY) return [];
    const configuredDirectory = settings.autoMemoryDirectory;
    const directory = configuredDirectory === "~" || configuredDirectory?.startsWith("~/")
      ? path.resolve(home, configuredDirectory === "~" ? "." : configuredDirectory.slice(2))
      : configuredDirectory ?? path.join(home, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"), "memory");
    file = path.resolve(start.cwd, directory, "MEMORY.md");
  }
  const data = await optionalFile(file);
  if (!data) return [];
  const loaded = start.engine === "claude" ? Buffer.from(data.toString("utf8").split("\n").slice(0, 200).join("\n")).subarray(0, 25_000) : data;
  return [{ kind: start.engine === "claude" ? "claude-index" as const : "codex-summary" as const, hash: hash(data), bytes: data.length, loadedBytes: loaded.length, data }];
}

const deliveryLedgerIndexes = declaredIndexes([
  `CREATE INDEX IF NOT EXISTS files_hash ON files(hash)`,
  `CREATE INDEX IF NOT EXISTS deliveries_attempt ON deliveries(json_extract(body,'$.attempt.pipelineId'), json_extract(body,'$.attempt.stageId'), json_extract(body,'$.attempt.attempt'), json_extract(body,'$.conversationId'))`,
]);
const indexPreparations = new Map<string, Promise<void>>();

function deliveryLedgerIndexWorkerPath(cwd = process.cwd()): string {
  const bundled = path.join(cwd, ".next/server/role-memory-delivery-index-worker.js");
  return fs.existsSync(bundled) ? bundled : path.join(cwd, "src/lib/roleMemoryDeliveryIndex.worker.ts");
}

/** Build retained-history indexes in a leased worker before a launch uses the ledger. */
export async function prepareDeliveryLedgerIndexes(): Promise<void> {
  const requestedDirectory = statePath("role-memory");
  await fs.promises.mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
  const directory = await fs.promises.realpath(requestedDirectory);
  if (repositoryRootForPath(directory)) throw Error("memory delivery archive requires state outside a checkout");
  assertStateStartupMutation(directory, "memory delivery index preparation");
  const filename = path.join(directory, "delivery.sqlite");
  try {
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1) throw Error("memory delivery archive must be an unlinked regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const Database = sqliteDatabase();
  try {
    if (fs.existsSync(filename)) {
      const db = new Database(filename, { readonly: true });
      try {
        const indexes = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
        if (deliveryLedgerIndexes.ready(indexes)) return;
      } finally { db.close(); }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const pending = indexPreparations.get(filename);
  if (pending) return pending;
  const preparation = new Promise<void>((resolve, reject) => {
    const child = spawnLeasedHelper("role-memory-delivery-index", {
      command: process.execPath,
      args: [deliveryLedgerIndexWorkerPath()],
      cwd: process.cwd(),
      env: { ...process.env, LLV_ROLE_MEMORY_DELIVERY_DIRECTORY: directory },
    }, statePath());
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      indexPreparations.delete(filename);
      error ? reject(error) : resolve();
    };
    child.once("error", error => settle(error));
    child.once("exit", (code, signal) => settle(code === 0 ? undefined : Error(`memory delivery index worker exited with ${code ?? signal}`)));
  });
  indexPreparations.set(filename, preparation);
  return preparation;
}

/** One owner, no module cache: rows, private content-addressed copies and their
 * eviction commit together. Readers page by sequence. No ledger content is
 * included in prompts, known values, or public API responses. */
export async function recordMemoryDelivery(start: MemoryEngineStart, clean: boolean, select: () => Selection | undefined): Promise<string | undefined> {
  return withViewerOperation("memory.engine-start", async () => {
    await prepareDeliveryLedgerIndexes();
    const directory = statePath("role-memory");
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await fs.promises.realpath(directory);
    if (repositoryRootForPath(canonicalDirectory)) throw Error("memory delivery archive requires state outside a checkout");
    const filename = path.join(canonicalDirectory, "delivery.sqlite");
    return waitForStateLock("memory.delivery", async () => {
      const files = await engineMemory(start, clean);
      return stateLockAttempt("memory.delivery", () => {
        try {
          const stat = fs.lstatSync(filename);
          if (!stat.isFile() || stat.nlink !== 1) throw Error("memory delivery archive must be an unlinked regular file");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const Database = sqliteDatabase();
        const db = new Database(filename, { create: true });
        fs.chmodSync(filename, 0o600);
        try {
          deliveryLedgerIndexes.assertRepairAuthority(db, path.dirname(filename));
          db.exec("PRAGMA busy_timeout=0");
          db.exec("PRAGMA foreign_keys=ON");
          db.exec("BEGIN IMMEDIATE");
          try {
            db.exec("CREATE TABLE IF NOT EXISTS deliveries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
            db.exec("CREATE TABLE IF NOT EXISTS versions (hash TEXT PRIMARY KEY, content BLOB NOT NULL)");
            db.exec("CREATE TABLE IF NOT EXISTS files (sequence INTEGER REFERENCES deliveries(sequence) ON DELETE CASCADE, hash TEXT REFERENCES versions(hash), PRIMARY KEY(sequence, hash))");
            const indexes = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
            if (!deliveryLedgerIndexes.ready(indexes)) throw Error("memory delivery indexes are not prepared");
            // Select after asynchronous admission; rules and their ordered metadata
            // are captured together, including omissions at the byte ceiling.
            const selection = select();
            const row: MemoryDelivery = { schemaVersion: 1, conversationId: start.conversationId, ...(start.attempt ? { attempt: start.attempt } : {}), engine: start.engine, at: new Date().toISOString(), scopes: selection?.scopes ?? [], rules: selection?.rules ?? [], bytes: Buffer.byteLength(selection?.block ?? ""), ...(selection?.reason ? { reason: selection.reason, shadowIds: selection.shadowIds, removed: selection.removed } : {}), engineMemory: files.map(({ kind, hash, bytes, loadedBytes }) => ({ kind, hash, bytes, loadedBytes })) };
            const body = JSON.stringify(row);
            if (Buffer.byteLength(body) > 256 * 1024) throw Error("memory delivery metadata exceeds ledger limit");
            const sequence = Number(db.query("INSERT INTO deliveries(body) VALUES (?)").run(body).lastInsertRowid);
            for (const file of files) {
              db.query("INSERT OR IGNORE INTO versions(hash,content) VALUES (?,?)").run(file.hash, file.data);
              db.query("INSERT INTO files(sequence,hash) VALUES (?,?)").run(sequence, file.hash);
            }
            db.query("DELETE FROM deliveries WHERE sequence <= ?").run(sequence - DELIVERY_LEDGER_STARTS);
            const collect = () => db.exec("DELETE FROM versions WHERE NOT EXISTS (SELECT 1 FROM files WHERE files.hash=versions.hash)");
            collect();
            const versions = db.query<{ bytes: number; lastSequence: number }, []>("SELECT length(content) AS bytes, MAX(sequence) AS lastSequence FROM versions JOIN files USING(hash) GROUP BY hash ORDER BY lastSequence").all();
            let bytes = versions.reduce((sum, version) => sum + version.bytes, 0), cutoff = 0;
            for (const version of versions) {
              if (bytes <= DELIVERY_LEDGER_FILE_BYTES) break;
              cutoff = version.lastSequence;
              bytes -= version.bytes;
            }
            if (cutoff) { db.query("DELETE FROM deliveries WHERE sequence<=?").run(cutoff); collect(); }
            db.exec("COMMIT");
            return selection?.block;
          } catch (error) { db.exec("ROLLBACK"); throw error; }
        } finally { db.close(); }
      });
    });
  });
}

/** Private analysis seam. A sequence cursor never materializes the full ledger. */
export function memoryDeliveries(after = 0, limit = 100): { sequence: number; delivery: MemoryDelivery }[] {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("invalid memory delivery page");
  const filename = statePath("role-memory", "delivery.sqlite");
  if (!fs.existsSync(filename)) return [];
  const Database = sqliteDatabase();
  const db = new Database(filename, { readonly: true });
  try { return db.query<{ sequence: number; body: string }, [number, number]>("SELECT sequence,body FROM deliveries WHERE sequence>? ORDER BY sequence LIMIT ?").all(after, limit).map(row => ({ sequence: row.sequence, delivery: JSON.parse(row.body) as MemoryDelivery })); }
  finally { db.close(); }
}

/** Answer authority comes from delivered ids, including earlier starts of this
 * attempt. A currently readable rule or a shadow id grants no authority. */
export function deliveredRuleIds(attempt: NonNullable<MemoryEngineStart["attempt"]>, conversationId: string): Set<string> {
  const filename = statePath("role-memory", "delivery.sqlite");
  if (!fs.existsSync(filename)) return new Set();
  const Database = sqliteDatabase();
  const db = new Database(filename, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout=0");
    const rows = db.query<{ body: string }, [string, string, number, string]>(`SELECT body FROM deliveries
      WHERE json_extract(body,'$.attempt.pipelineId')=? AND json_extract(body,'$.attempt.stageId')=?
      AND json_extract(body,'$.attempt.attempt')=? AND json_extract(body,'$.conversationId')=?`).all(attempt.pipelineId, attempt.stageId, attempt.attempt, conversationId);
    return new Set(rows.flatMap(row => (JSON.parse(row.body) as MemoryDelivery).rules.map(rule => rule.id)));
  } finally { db.close(); }
}
export function engineMemoryVersion(hash: string): Buffer | null {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("invalid engine memory hash");
  const filename = statePath("role-memory", "delivery.sqlite");
  if (!fs.existsSync(filename)) return null;
  const Database = sqliteDatabase();
  const db = new Database(filename, { readonly: true });
  try { const row = db.query<{ content: Uint8Array }, [string]>("SELECT content FROM versions WHERE hash=?").get(hash); if (!row) return null; const data = Buffer.from(row.content); if (createHash("sha256").update(data).digest("hex") !== hash) throw Error("engine memory copy failed integrity check"); return data; }
  finally { db.close(); }
}
