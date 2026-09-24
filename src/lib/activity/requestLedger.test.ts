import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RegistryFile } from "@/lib/agent/registry";

import { LEDGER_RETENTION_DAYS, readRequests, recordOperatorRequest, type RequestLedgerDependencies } from "./requestLedger";

const DAY = 24 * 60 * 60 * 1000;
const anchorsOf = (read: ReturnType<typeof readRequests>) => read.rows.map(({ at, project, surface, kind }) => ({ at, project, surface, kind }));
const NOW = Date.parse("2026-09-21T10:00:00Z");
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let root: string;
let reports: Array<{ event: string; fields: Record<string, unknown> }>;

function request(userAgent: string | null) {
  return { headers: new Headers(userAgent ? { "user-agent": userAgent } : {}) };
}

function deps(overrides: Partial<RequestLedgerDependencies> = {}): Partial<RequestLedgerDependencies> {
  return {
    now: () => NOW,
    dir: () => path.join(root, "activity"),
    registrySnapshot: () => ({ conversations: {} }) as unknown as RegistryFile,
    report: (event, fields) => reports.push({ event, fields }),
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "activity-ledger-"));
  reports = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("recording operator requests", () => {
  test("a row is appended and read back, and a retry of the same request is one anchor", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recordOperatorRequest(request(DESKTOP), { kind: "message", idempotencyKey: "task-send:fanout-0001", project: "harbor" }, deps());
    }
    recordOperatorRequest(request(PHONE), { kind: "voice", idempotencyKey: "realtime:abc", project: "lantern" }, deps({ now: () => NOW + 60_000 }));
    const read = readRequests(NOW - DAY, NOW + DAY, { dir: () => path.join(root, "activity") });
    expect(anchorsOf(read)).toEqual([
      { at: NOW, project: "harbor", surface: "desktop", kind: "message" },
      { at: NOW + 60_000, project: "lantern", surface: "phone", kind: "voice" },
    ]);
    expect(read.ledgerStartMs).toBe(NOW);
    expect(reports).toEqual([]);
  });

  test("requests with no idempotency key are never merged", () => {
    recordOperatorRequest(request(DESKTOP), { kind: "task", project: "harbor" }, deps());
    recordOperatorRequest(request(DESKTOP), { kind: "task", project: "harbor" }, deps());
    expect(readRequests(NOW - DAY, NOW + DAY, { dir: () => path.join(root, "activity") }).rows).toHaveLength(2);
  });

  test("a row carries exactly the six allowed keys and nothing that names the target", () => {
    recordOperatorRequest(request(DESKTOP), {
      kind: "answer",
      idempotencyKey: "question:toolu_secret_id",
      conversationId: "conversation_0123456789abcdef",
      path: "/home/user/.claude/projects/x/session.jsonl",
      fallbackEntry: { project: "harbor", cwd: null },
    }, deps());
    const file = fs.readdirSync(path.join(root, "activity"))[0]!;
    expect(file).toBe("requests-2026-09-21.jsonl");
    const text = fs.readFileSync(path.join(root, "activity", file), "utf8");
    const row = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(["at", "key", "kind", "project", "surface", "v"]);
    expect(row).toMatchObject({ v: 1, at: NOW, kind: "answer", surface: "desktop", project: "harbor" });
    expect(row.key).toMatch(/^[0-9a-f]{64}$/);
    for (const leaked of ["toolu_secret_id", "conversation_", "/home/", "session.jsonl"]) expect(text).not.toContain(leaked);
    expect(fs.statSync(path.join(root, "activity", file)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, "activity")).mode & 0o777).toBe(0o700);
  });

  test("the surface comes from the user agent", () => {
    const surfaces = [DESKTOP, PHONE, "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1", "curl/8.9.1", null].map((ua, index) =>
      recordOperatorRequest(request(ua), { kind: "message", project: "harbor", idempotencyKey: `ua-${index}` }, deps())?.surface);
    expect(surfaces).toEqual(["desktop", "phone", "tablet", "other", "other"]);
  });

  test("an unresolved project is kept as null, and a registry failure does not lose the row", () => {
    const unresolved = recordOperatorRequest(request(DESKTOP), { kind: "spawn", project: "project_unresolved" }, deps());
    expect(unresolved?.project).toBeNull();
    const broken = recordOperatorRequest(request(DESKTOP), { kind: "message", conversationId: "conversation_x", fallbackEntry: { project: "harbor" } }, deps({
      registrySnapshot: () => { throw new Error("registry unreadable"); },
    }));
    expect(broken?.project).toBe("harbor");
  });

  test("an unwritable ledger does not throw and reports one outcome class", () => {
    const blocker = path.join(root, "not-a-directory");
    fs.writeFileSync(blocker, "");
    const row = recordOperatorRequest(request(DESKTOP), { kind: "message", project: "harbor" }, deps({ dir: () => path.join(blocker, "activity") }));
    expect(row).toBeNull();
    expect(reports).toEqual([{ event: "request_not_stored", fields: { outcome: "ENOTDIR" } }]);
    expect(JSON.stringify(reports)).not.toContain(root);
  });

  test("an invalid clock or kind stores nothing and says so", () => {
    expect(recordOperatorRequest(request(DESKTOP), { kind: "message", project: "harbor" }, deps({ now: () => Number.NaN }))).toBeNull();
    expect(recordOperatorRequest(request(DESKTOP), { kind: "gossip" as "message", project: "harbor" }, deps())).toBeNull();
    expect(reports.map((entry) => entry.fields.outcome)).toEqual(["invalid", "invalid"]);
  });
});

describe("retention and reading", () => {
  test("creating a new day file prunes day files older than the retention", () => {
    const dir = path.join(root, "activity");
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(NOW - (LEDGER_RETENTION_DAYS + 5) * DAY).toISOString().slice(0, 10);
    const kept = new Date(NOW - 30 * DAY).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, `requests-${old}.jsonl`), "");
    fs.writeFileSync(path.join(dir, `requests-${kept}.jsonl`), "");
    fs.writeFileSync(path.join(dir, "unrelated.txt"), "");
    recordOperatorRequest(request(DESKTOP), { kind: "message", project: "harbor" }, deps());
    expect(fs.readdirSync(dir).sort()).toEqual([`requests-${kept}.jsonl`, "requests-2026-09-21.jsonl", "unrelated.txt"]);
  });

  test("malformed and foreign lines are skipped, the range is inclusive, and the start is the earliest row", () => {
    const dir = path.join(root, "activity");
    fs.mkdirSync(dir, { recursive: true });
    const key = (n: number) => n.toString(16).padStart(64, "0");
    const lines = [
      JSON.stringify({ v: 1, key: key(1), at: NOW - 2 * DAY, kind: "message", surface: "desktop", project: "harbor" }),
      "{not json",
      JSON.stringify({ v: 2, key: key(2), at: NOW - 2 * DAY, kind: "message", surface: "desktop", project: "harbor" }),
      JSON.stringify({ v: 1, key: key(3), at: NOW - 2 * DAY, kind: "shout", surface: "desktop", project: "harbor" }),
    ];
    fs.writeFileSync(path.join(dir, "requests-2026-09-19.jsonl"), lines.join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "requests-2026-09-21.jsonl"), JSON.stringify({ v: 1, key: key(4), at: NOW, kind: "task", surface: "phone", project: null }) + "\n");
    const read = readRequests(NOW, NOW, { dir: () => dir });
    expect(anchorsOf(read)).toEqual([{ at: NOW, project: null, surface: "phone", kind: "task" }]);
    expect(read.ledgerStartMs).toBe(NOW - 2 * DAY);
    expect(readRequests(NOW - 3 * DAY, NOW, { dir: () => dir }).rows).toHaveLength(2);
  });

  test("a home with no ledger reads as nothing recorded", () => {
    expect(readRequests(0, NOW, { dir: () => path.join(root, "missing") })).toEqual({ rows: [], ledgerStartMs: null });
  });
});
