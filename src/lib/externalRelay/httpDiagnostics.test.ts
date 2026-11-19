import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { noteRelayHttpRefusal, relayHttpRefusal } from "./httpDiagnostics";
import { startTestRelay } from "./testRelay";

test("HTTP refusal journal bounds repeated and flapping errors and reports suppression", () => {
  const log = spyOn(console, "info").mockImplementation(() => {});
  const start = Date.parse("2026-01-01T00:00:00Z");
  try {
    const record = { path: "/requests/:request/heartbeat" as const, status: 409, reason: "lease_lost" as const };
    for (let i = 0; i < 100; i++) noteRelayHttpRefusal(record, start + i);
    expect(log).toHaveBeenCalledTimes(1);
    noteRelayHttpRefusal(record, start + 600_000);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[1]![1] as string)).toMatchObject({ status: 409, reason: "lease_lost", suppressed: 99 });
    for (let i = 0; i < 100; i++) noteRelayHttpRefusal({ ...record, status: i % 2 ? 409 : 403 }, start + 600_001 + i);
    expect(log).toHaveBeenCalledTimes(31);
    noteRelayHttpRefusal(record, start + 1_200_000);
    expect(log).toHaveBeenCalledTimes(32);
    expect(JSON.parse(log.mock.calls[31]![1] as string).suppressed).toBe(71);
    expect(relayHttpRefusal("/other/private-request", 409, {})).toBeNull();
    expect(relayHttpRefusal("/requests/claim", 200, {})).toBeNull();
  } finally { log.mockRestore(); }
});

test("the real client journal rate limit resets after restarting its process", async () => {
  let calls = 0;
  const server = await startTestRelay(() => ({ status: ++calls % 2 ? 409 : 403, body: { error: { code: "lease_lost" } } }));
  const roots: string[] = [];
  try {
    for (let run = 0; run < 2; run++) {
      const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "http-observation-")); roots.push(root);
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "httpDiagnostics.fixture.ts"), `${server.origin}/v1`], {
        env: isolatedEnvironment(root, process.env), stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0); expect(err).toBe("");
      const records = out.split("\n").filter(line => line.startsWith("External relay HTTP refusal "));
      expect(records).toHaveLength(30);
      expect(out).not.toContain("private-request"); expect(out).not.toContain(server.origin);
    }
    expect(calls).toBe(130);
  } finally { await server.close(); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
