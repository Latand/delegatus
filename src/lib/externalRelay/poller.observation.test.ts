import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { startTestRelay } from "./testRelay";

for (const count of [4, 65]) test(`real poller journals and status survive module copies; process restart resets counters and rate limit (${count} claims)`, async () => {
  let claims = 0;
  const server = await startTestRelay(req => {
    if (req.url?.endsWith("/requests/claim")) {
      claims++;
      const step = (claims - 1) % count;
      if (step < (count === 4 ? 2 : count - 1) && (count === 4 || step % 2 === 0)) return { status: 204 };
      // Invalid request proves claim observation precedes runner validation;
      // it cannot launch an agent or touch any real relay.
      if (step < count - 1) return { body: { request: {} } };
      return { status: 401, body: { error: { code: "private response detail", message: "private response detail" } } };
    }
    return { status: 404 };
  });
  const roots: string[] = [];
  try {
    for (let run = 0; run < 2; run++) {
      const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "poll-observation-"));
      roots.push(root);
      const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "poller.observation.fixture.ts"), server.origin], {
        env: isolatedEnvironment(root, process.env), stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(0);
      const lines = out.split("\n");
      const records = lines.filter(line => line.startsWith("External relay poll outcome "));
      const outcomes = records.map(line => JSON.parse(line.slice("External relay poll outcome ".length)).outcome);
      expect(outcomes).toEqual(count === 4 ? ["ok-empty", "claimed", "http:401"]
        : Array.from({ length: 30 }, (_, i) => i % 2 ? "claimed" : "ok-empty"));
      const status = JSON.parse(lines.find(line => line.startsWith("POLL_STATUS "))!.slice("POLL_STATUS ".length));
      expect(status).toMatchObject({ path: "/requests/claim", counters: { polls: count, empty: count === 4 ? 2 : 32, claimed: count === 4 ? 1 : 32, errors: { "http:401": 1 } },
        lastOutcome: { outcome: "http:401", status: 401 }, suppressedChanges: count === 4 ? 0 : 35 });
      expect(Number.isFinite(Date.parse(status.lastOutcome.at))).toBe(true);
      expect(Number.isFinite(Date.parse(status.since))).toBe(true);
      const diagnostics = JSON.stringify([records, status]);
      expect(diagnostics).not.toContain("private response detail");
      expect(diagnostics).not.toContain(server.origin);
      expect(diagnostics).not.toContain("127.0.0.1");
      expect(err).not.toContain("private response detail");
    }
    expect(claims).toBe(2 * count);
  } finally { await server.close(); for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); }
}, 30_000);
