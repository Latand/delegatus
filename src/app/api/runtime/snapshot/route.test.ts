import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { expect, test } from "bun:test";
import { procBackend } from "@/lib/proc";

async function routeCase(phase: string, live: boolean, refusal?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-startup-"));
  const startup = path.join(directory, "runtime-host-startup"); fs.mkdirSync(startup);
  const socket = path.join(directory, "runtime.sock");
  const server = refusal ? net.createServer((peer) => { peer.on("error", () => {}); peer.once("data", (data) => { const request = JSON.parse(String(data)); peer.end(`${JSON.stringify({ id: request.id, ok: false, error: refusal })}\n`); }); }) : null;
  if (server) { server.listen(socket); await once(server, "listening"); }
  fs.writeFileSync(path.join(startup, "host.json"), JSON.stringify({ version: 1, generation: { image: "fixture", revision: "a".repeat(40), container: "fixture" }, pid: live ? process.pid : 2147483647, startIdentity: live ? procBackend.processIdentity(process.pid) : "gone", hostEpoch: null, phases: [{ phase, recordedAt: "2026-01-01T00:00:00.000Z" }], journal: { subphase: "hash-chain", done: 4096, total: 300000, committedBatches: 0 } }));
  try {
    const code = `import {GET} from ${JSON.stringify(path.join(import.meta.dir, "route.ts"))};const response=await GET(new Request('http://localhost/api/runtime/snapshot'));console.log(JSON.stringify({status:response.status,body:await response.json()}));`;
    const child = Bun.spawn([process.execPath, "-e", code], { env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, LLV_STATE_DIR: directory, LLV_RUNTIME_HOST_SOCKET: socket }, stdout: "pipe", stderr: "pipe" });
    const [output, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exit !== 0) throw new Error(error);
    return JSON.parse(output.trim());
  } finally { if (server) { server.close(); await once(server, "close"); } fs.rmSync(directory, { recursive: true, force: true }); }
}

test("snapshot reports booting progress after transport refusal", async () => {
  const response = await routeCase("fence-acquired", true);
  expect(response).toMatchObject({ status: 503, body: { code: "runtime-host-booting", journal: { subphase: "hash-chain", done: 4096 } } });
  // Stale and deterministic refusals preserve the existing contract.
  for (const [phase, live] of [["fence-acquired", false], ["ready", true]] as const) {
    const response = await routeCase(phase, live); expect(response.status).toBe(503); expect(response.body.code).toBeUndefined();
  }

  const refused = await routeCase("fence-acquired", true, "fixture business refusal");
  expect(refused).toEqual({ status: 503, body: { error: "fixture business refusal" } });
});
