import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { seatMcpHealth } from "./seatMcpHealth";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-seat-mcp-health-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const now = Date.parse("2026-09-27T12:00:00.000Z");
const digest = "a".repeat(64);
const receipt = { spawnCapabilityDigest: digest, createdAt: new Date(now - 30 * 60_000).toISOString() };

test("missing and stale session heartbeats identify a dead stdio MCP after startup grace", () => {
  expect(seatMcpHealth(receipt, new Date(now - 5 * 60_000).toISOString(), root, now).status).toBe("untracked");
  expect(seatMcpHealth(receipt, new Date(now - 20 * 60_000).toISOString(), root, now).status).toBe("dead");
  const filename = path.join(root, "mcp-runtime", "sessions", `${digest}.json`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify({ checkedAt: new Date(now - 3 * 60_000).toISOString(), ready: true }));
  expect(seatMcpHealth(receipt, null, root, now).status).toBe("dead");
  fs.writeFileSync(filename, JSON.stringify({ checkedAt: new Date(now).toISOString(), ready: false, unreadySince: new Date(now - 3 * 60_000).toISOString() }));
  expect(seatMcpHealth(receipt, null, root, now).status).toBe("dead");
  fs.writeFileSync(filename, JSON.stringify({ checkedAt: new Date(now).toISOString(), ready: true, unreadySince: null }));
  expect(seatMcpHealth(receipt, null, root, now).status).toBe("healthy");
});

test("HTTP MCP sessions are outside the stdio launcher heartbeat rule", () => {
  expect(seatMcpHealth(receipt, null, root, now, "http").status).toBe("untracked");
});
