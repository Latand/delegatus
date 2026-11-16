import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "../../../scripts/local-gate";
import { startTestRelay } from "./testRelay";

for (const transport of ["inline", "worker"]) for (const reason of ["lease_lost", "private_response_detail"])
test(`${transport} heartbeat and completion journal 409 with sanitized reason ${reason}`, async () => {
  const server = await startTestRelay(() => ({ status: 409, body: { error: { code: reason, message: "private response detail" } } }));
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "lease-observation-"));
  try {
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "relayLeaseTransport.observation.fixture.ts"), server.origin, transport], {
      env: isolatedEnvironment(root, process.env), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0);
    const completionCode = reason === "lease_lost" ? reason : "unrecognized_service_code";
    expect(err).toBe(`External relay completion refused {
  request: "private-",
  status: 409,
  code: "${completionCode}",
  reason: "${completionCode}",
}
`);
    const records = out.split("\n").filter(line => line.startsWith("External relay HTTP refusal "))
      .map(line => JSON.parse(line.slice("External relay HTTP refusal ".length)));
    expect(records).toHaveLength(2);
    for (const [index, operation] of ["heartbeat", "complete"].entries()) {
      expect(records[index]).toMatchObject({ path: `/requests/:request/${operation}`, status: 409,
        reason: reason === "lease_lost" ? reason : "other" });
    }
    for (const excluded of [server.origin, "private-request", "private-target", "private-lease", "private response detail", "private_response_detail"])
      expect(out).not.toContain(excluded);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20_000);
