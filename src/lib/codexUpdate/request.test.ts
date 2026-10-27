import { afterEach, expect, test } from "bun:test";
import { createServer } from "node:http";
import path from "node:path";
import { codexUpdateUrl } from "./request";
import { internalServiceClaim } from "@/lib/agent/callerClaims";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve())); });

test("destination validation pins loopback and refuses mixed DNS, credentials and other paths", async () => {
  const credentialUrl = ["http://", "fixture", ":", "fixture", "@", "localhost/api/codex-update/check"].join("");
  expect((await codexUpdateUrl("http://localhost:1234/api/codex-update/check", async () => [{ address: "127.0.0.2", family: 4 }])).hostname).toBe("127.0.0.2");
  expect((await codexUpdateUrl("http://[::1]:1234/api/codex-update/check")).hostname).toBe("[::1]");
  await expect(codexUpdateUrl("http://localhost/api/codex-update/check", async () => [
    { address: "127.0.0.1", family: 4 }, { address: "192.0.2.1", family: 4 },
  ])).rejects.toThrow("only to loopback");
  for (const input of ["https://localhost/api/codex-update/check", "http://localhost/api/self-update/check", credentialUrl, "http://localhost/api/codex-update/check?force=1"]) {
    await expect(codexUpdateUrl(input)).rejects.toThrow("invalid");
  }
});

for (const status of [202, 302, 403, 409]) test(`the real check command authenticates without forwarding response secrets (HTTP ${status})`, async () => {
  ensureOperatorSpawnCapability();
  const claims: string[] = [];
  const server = createServer((req, res) => {
    const request = new Request("http://127.0.0.1/api/codex-update/check", { headers: req.headers as Record<string, string> });
    const claim = internalServiceClaim(request, { readOnly: true });
    claims.push(`${req.method}:${req.url}:${claim.claim === "valid" ? claim.service : claim.claim}`);
    res.writeHead(status, { "content-type": "application/json", location: "http://192.0.2.1/private" });
    res.end(JSON.stringify({ accepted: true, diagnostic: "private-response-sentinel" }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const entry = process.env.CODEX_UPDATE_COMMAND_FIXTURE
    ? path.resolve(process.env.CODEX_UPDATE_COMMAND_FIXTURE) : path.resolve(import.meta.dir, "../../../scripts/codex-update.ts");
  const child = Bun.spawn([process.execPath, entry, "check", `http://127.0.0.1:${address.port}/api/codex-update/check`], {
    env: process.env, stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(claims).toEqual(["POST:/api/codex-update/check:controller"]);
  expect(exit).toBe(status === 202 ? 0 : 1);
  expect(stdout + stderr).not.toContain("private-response-sentinel");
  expect(stdout + stderr).not.toContain(ensureOperatorSpawnCapability());
});
