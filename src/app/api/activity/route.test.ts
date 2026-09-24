import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Establish every state root before importing production modules.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "activity-route-"));
const previous = new Map<string, string | undefined>();
for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
  previous.set(key, process.env[key]);
  const dir = path.join(sandbox, key);
  fs.mkdirSync(dir, { recursive: true });
  process.env[key] = dir;
}
const { NextRequest } = await import("next/server");
const { GET } = await import("./route");
const { indexTranscriptSources } = await import("@/lib/search/transcriptSearch");
const { recordOperatorRequest } = await import("@/lib/activity/requestLedger");

afterAll(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const SECRET_PROMPT = "please rotate the quartz-lantern credential";
const SECRET_REPLY = "rotated the quartz-lantern credential";

function get(query: string, headers: Record<string, string> = {}) {
  return GET(new NextRequest(`http://127.0.0.1/api/activity${query}`, { headers: { host: "127.0.0.1", ...headers } }));
}

test("a cross-origin request is refused", async () => {
  const response = await get("?range=today", { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
  expect(response.status).toBe(403);
});

test("the answer carries both axes and no path, title or message text", async () => {
  const now = Date.now();
  const transcript = path.join(sandbox, "HOME", "session-quartz.jsonl");
  const stamp = (offsetMin: number) => new Date(now - offsetMin * 60_000).toISOString();
  fs.writeFileSync(transcript, [
    { type: "user", timestamp: stamp(50), message: { role: "user", content: SECRET_PROMPT } },
    { type: "assistant", timestamp: stamp(20), message: { role: "assistant", content: [{ type: "text", text: SECRET_REPLY }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  await indexTranscriptSources([{ path: transcript, project: "harbor", engine: "claude", size: fs.statSync(transcript).size, mtimeMs: now }]);
  recordOperatorRequest(
    { headers: new Headers({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0 Safari/537.36" }) },
    { kind: "message", idempotencyKey: "route-test-send", project: "harbor" },
    { now: () => now - 45 * 60_000 },
  );

  /* Out-of-range and malformed parameters are clamped, never refused. */
  const response = await get("?range=7d&tz=Not%2FAZone&window=99&break=1&rounding=weekly");
  expect(response.status).toBe(200);
  const text = await response.text();
  const body = JSON.parse(text) as {
    params: { windowMin: number; breakMin: number; rounding: string; tz: string };
    coverage: { agentIndex: string; hosts: Array<{ host: string; complete: boolean; unread: Array<{ start: number; end: number }>; sources: Array<{ source: string; state: string; scope: string }> }> };
    totals: { humanMs: number; wallMs: number; supervisedMs: number; unattendedMs: number; unattendedUnreadMs: number };
    days: Array<{ hours: unknown[]; projects: Array<{ project: string | null }> }>;
    projects: Array<{ project: string | null; humanMs: number; wallMs: number; byEngine: Record<string, number>; byRole: Record<string, number> }>;
  };
  /* An unknown zone falls back to the settings' zone, Europe/Kyiv by default. */
  expect(body.params).toEqual({ windowMin: 15, breakMin: 15, rounding: "clock-hour", tz: "Europe/Kyiv" });
  expect(body.days).toHaveLength(7);
  expect(body.coverage.agentIndex).toBe("ok");
  expect(body.coverage.hosts.map((host) => [host.host, host.sources.map((source) => `${source.source}:${source.state}:${source.scope}`)]))
    .toEqual([["local", ["ledger:read:delegatus", "ingest:absent:all"]]]);
  /* The ledger read Delegatus requests only; terminal input here had no export. */
  expect(body.coverage.hosts[0]!.complete).toBe(false);
  expect(body.coverage.hosts[0]!.unread).toHaveLength(1);
  /* One request 45 minutes ago with a 15-minute window, and a 30-minute turn
     that began 5 minutes before it: 15 minutes supervised, 15 unattended. */
  expect(body.totals.humanMs).toBe(15 * 60_000);
  expect(body.totals.wallMs).toBe(30 * 60_000);
  expect(body.totals.supervisedMs).toBe(15 * 60_000);
  expect(body.totals.unattendedMs).toBe(15 * 60_000);
  /* The page's presentation fields: that host holds every project and was
     not read, so the unattended part is unclear; one row per clock hour. */
  expect(body.totals.unattendedUnreadMs).toBe(15 * 60_000);
  expect(body.days.at(-1)!.hours.length).toBeGreaterThanOrEqual(23);
  expect([...new Set(body.days.flatMap((day) => day.projects).map((entry) => entry.project))]).toEqual(["harbor"]);
  const harbor = body.projects.find((row) => row.project === "harbor")!;
  expect(harbor.byEngine).toEqual({ claude: 30 * 60_000 });
  expect(harbor.byRole).toEqual({ unregistered: 30 * 60_000 });
  for (const leaked of [SECRET_PROMPT, SECRET_REPLY, "quartz", transcript, "session-quartz", sandbox]) expect(text).not.toContain(leaked);
});

test("with this host's ingest caught up, its coverage is complete and no export exists", async () => {
  const { ingestTranscripts } = await import("@/lib/activity/ingest");
  const { ActivityStore } = await import("@/lib/activity/store");
  const now = Date.now();
  const stamp = (offsetMin: number) => new Date(now - offsetMin * 60_000).toISOString();
  /* A terminal session begun eight days ago and still in use: the backfill
     reads its history, and a prompt typed 20 minutes ago counts. */
  const transcript = path.join(sandbox, "HOME", "session-terminal.jsonl");
  const typed = (offsetMin: number, uuid: string) => ({ type: "user", timestamp: stamp(offsetMin), uuid, sessionId: "s", cwd: "/work/harbor", entrypoint: "cli", promptSource: "typed", message: { role: "user", content: `typed request ${uuid}` } });
  fs.writeFileSync(transcript, [typed(8 * 24 * 60, "t-old"), typed(20, "t-new")].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const store = ActivityStore.open();
  try {
    const stat = fs.statSync(transcript);
    await ingestTranscripts([{ path: transcript, engine: "claude", size: stat.size, mtimeMs: stat.mtimeMs }], {
      complete: true,
      listedAt: now,
      store,
      resolver: () => () => ({ project: "harbor", launch: null, registered: false }),
    });
  } finally {
    store.close();
  }
  expect(fs.existsSync(path.join(process.env.LLV_STATE_DIR!, "activity", "hosts"))).toBeFalse();

  /* Seven days: the history read covers all of it at any hour of the day. */
  const response = await get("?range=7d");
  const body = await response.json() as {
    coverage: { hosts: Array<{ host: string; complete: boolean; unread: unknown[]; sources: Array<{ source: string; state: string; readAt: number | null }> }> };
    totals: { humanMs: number; coverage: { complete: boolean } };
  };
  const host = body.coverage.hosts[0]!;
  expect(host.sources.map((source) => `${source.source}:${source.state}`)).toEqual(["ledger:read", "ingest:read"]);
  expect(host.sources[1]!.readAt).not.toBeNull();
  /* The pass just finished: caught up, so this host is read to now. */
  expect(host.complete).toBeTrue();
  expect(host.unread).toEqual([]);
  expect(body.totals.coverage.complete).toBeTrue();
  expect(body.totals.humanMs).toBeGreaterThan(0);
});
