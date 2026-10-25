import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { assertStateChildSuccess } from "@/lib/state/stateChildResult.fixture";

const cases = ["direct", "relay"].flatMap(route => ["constructor", "writer"].flatMap(site => ["no", "yes"].map(revoked => ({ route, site, revoked }))))
  .concat(["validation", "refusal", "agent-refusal", "drain"].map(route => ({ route, site: "constructor", revoked: "no" })))
  .concat(["no", "yes"].map(revoked => ({ route: "drain-released", site: "constructor", revoked })))
  .concat([{ route: "drain-started", site: "constructor", revoked: "no" }])
  .concat(["no", "yes"].map(revoked => ({ route: "continuation", site: "constructor", revoked })));
for (const { route, site, revoked } of cases) {
  test(`${route} launch waits for the registry ${site} and rechecks authorization (revoked=${revoked})`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "launch-registry-lock-"));
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "spawnCommand.registryLock.fixture.ts"), route, site, revoked], {
      env: { ...process.env, LLV_STATE_DIR: root, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), TMPDIR: root,
        LLV_AGENT_REGISTRY_SQLITE: "sqlite", LLV_SPAWN_TRANSPORT: "structured", LLV_STRUCTURED_HOSTS: "1", LLV_RUNTIME_EVENTS: "1", NEXT_PUBLIC_RUNTIME_UI: "1",
        LLV_RUNTIME_HOST_SOCKET: path.join(root, "fixture.sock") },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const transactionTiming = z.strictObject({ collection: z.string().min(1).optional(),
        heldMs: z.number().int().min(50), pid: z.literal(child.pid), role: z.literal("unowned") });
      const diagnostics = stderr.split(/\r?\n/).filter(line => {
        const prefix = "[state transaction-hold] ";
        if (!line.startsWith(prefix)) return true;
        try { return !transactionTiming.safeParse(JSON.parse(line.slice(prefix.length))).success; }
        catch { return true; }
      }).join("\n");
      assertStateChildSuccess(code, diagnostics);
      const result = JSON.parse(stdout);
      expect(result.yielded).toBe(true);
      if (site === "constructor") { expect(result.constructorBusy).toBe(true); expect(result.errno).toBe(5); }
      expect(result.error).not.toBe("database is locked");
      expect(result.settledBeforeRelease).toBe(false);
      if (site === "constructor") expect(result.attempts).toBeGreaterThan(1);
      if (["validation", "refusal", "agent-refusal", "drain", "drain-started"].includes(route)) {
        expect(result.status).toBe(route === "validation" ? 200 : route.startsWith("drain") ? 503 : 400);
        expect(result.dispatches).toBe(0);
        expect(result.receipt).toBe(false);
        expect(result.fenced).toBe(!route.startsWith("drain"));
        if (route.startsWith("drain")) expect(result.code).toBe("AUTO_UPDATE_DRAIN");
      } else if (revoked === "yes") {
        expect(result.status).toBeGreaterThanOrEqual(400);
        expect(result.error).toBe("fixture launch revoked");
        expect(result.dispatches).toBe(0);
        expect(result.receipt).toBe(false);
      } else if (route === "continuation") {
        expect(result.status).toBe(409);
        expect(result.error).toBe("automatic continuation unavailable: the conversation cannot be resumed");
        expect(result.dispatches).toBe(0);
        expect(result.receipt).toBe(false);
      } else {
        expect(result.status).toBe(202);
        expect(result.error).toBeNull();
        expect(result.dispatches).toBe(1);
        expect(result.receipt).toBe(true);
        expect(result.membershipAdmitted).toBe(true);
      }
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null) { child.kill(); await child.exited; }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}
