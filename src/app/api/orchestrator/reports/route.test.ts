import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { NextRequest } from "next/server";

/* The report log's read route (#2146): one project's bridge reports, a bounded
   page at a time, newest first. A sandboxed state directory, pinned before
   the stores load. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-report-log-route-"));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = SANDBOX;
fs.writeFileSync(path.join(SANDBOX, "project-remotes.json"), JSON.stringify({ schemaVersion: 1, remotes: { "repo-widgets": "github.com/acme/widgets" } }));

const { GET } = await import("./route");
const { appendBridgeReports, readBridgeChannel } = await import("@/lib/bridge/store");
const { setBridgeReports } = await import("@/lib/projects/settings");

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const ORIGIN = "http://127.0.0.1:8899";
const get = (query: string) => GET(new NextRequest(`${ORIGIN}/api/orchestrator/reports?${query}`));

appendBridgeReports(Array.from({ length: 45 }, (_, index) => ({
  key: `widgets-${index + 1}`,
  class: (["completed", "failed", "blocked", "question", "review_verdict", "status"] as const)[index % 6],
  at: new Date(Date.UTC(2026, 8, 24, 6, index)).toISOString(),
  body: `widgets report ${index + 1}, PR #${2100 + index}`,
  project: index === 3 ? "repo-other" : "repo-widgets",
  targetSeatConversationId: "conversation_seat_widgets",
})));

test("the route pages one project's reports newest first with its GitHub repository", async () => {
  const response = await get("project=repo-widgets&limit=20");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const page = await response.json();
  expect(page).toMatchObject({ ok: true, project: "repo-widgets", bridgeReports: true, github: "acme/widgets" });
  expect(page.entries).toHaveLength(20);
  expect(page.entries[0]).toMatchObject({ seq: 45, class: "blocked", body: "widgets report 45, PR #2144", cards: [] });
  expect(page.entries.every((entry: { body: string }) => !entry.body.startsWith("widgets report 4,"))).toBe(true);

  const older = await (await get(`project=repo-widgets&limit=20&before=${page.nextBefore}`)).json();
  expect(older.entries[0].seq).toBe(page.entries.at(-1).seq - 1);
  const last = await (await get(`project=repo-widgets&limit=20&before=${older.nextBefore}`)).json();
  /* 45 reports, one of them another project's. */
  expect(page.entries.length + older.entries.length + last.entries.length).toBe(44);
  expect(last.nextBefore).toBeNull();

  const unchanged = await (await get(`project=repo-widgets&since=${encodeURIComponent(page.revision)}`)).json();
  expect(unchanged).toMatchObject({ unchanged: true, entries: [] });
  expect(readBridgeChannel({ project: "repo-widgets", seatConversationId: "conversation_seat_widgets" })).toBeNull();
});

test("the route clamps its page, refuses a request without a project and says when reports are off", async () => {
  expect((await (await get("project=repo-widgets&limit=5000")).json()).entries).toHaveLength(44);
  expect((await (await get("project=repo-widgets&limit=0")).json()).entries).toHaveLength(1);
  expect((await get("")).status).toBe(400);
  expect((await (await get("project=repo-empty")).json())).toMatchObject({ entries: [], nextBefore: null, github: null });
  setBridgeReports("repo-widgets", false, "operator");
  const off = await (await get("project=repo-widgets")).json();
  expect(off.bridgeReports).toBe(false);
  expect(off.entries.length).toBeGreaterThan(0);
});
