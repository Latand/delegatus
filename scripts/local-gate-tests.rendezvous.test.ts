import { createServer, expect, fixture, path, readFileSync, root, source, spawn, test, writeFileSync } from "./local-gate-tests.fixture";


test.each(["recovers", "stable", "missing-peer"] as const)("real confirmation processes rendezvous on both sides: %s", async mode => {
  const f = fixture(source(true));
  const marker = path.join(f.dir, "paired-samples");
  const scheduled = `import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createConnection } from "node:net";
const side = basename(process.cwd()) === "baseline" ? "base" : "head";
const prefix = ${JSON.stringify(marker)} + "-" + process.env.GATE_CONFIRMATION_FIXTURE_RUN;
const counter = prefix + "-" + side;
const run = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
writeFileSync(counter, String(run));
if (run === 2 && side === "head" && process.env.GATE_CONFIRMATION_FIXTURE_RUN === "0" && ${JSON.stringify(mode)} !== "missing-peer") await Bun.sleep(31000);
if (run > 1) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.GATE_RENDEZVOUS_PORT) });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ side, run }) + "\\n"));
    socket.once("data", chunk => { socket.end(); if (chunk.toString() === "release") resolve(); else reject(new Error("invalid rendezvous release")); });
  });
}
test("paired target", () => expect(side === "base" || (${JSON.stringify(mode)} === "recovers" && run > 1)).toBe(true));`;
  writeFileSync(path.join(f.dir, "example.test.ts"), scheduled);
  f.git("add", "example.test.ts"); f.git("commit", "-m", "paired process schedule");
  const base = f.git("rev-parse", "HEAD");
  for (let attempt = 0; attempt < 2; attempt++) {
    f.env.GATE_CONFIRMATION_FIXTURE_RUN = String(attempt);
    const server = createServer();
    const ready = new Map<number, Map<string, import("node:net").Socket>>();
    const sockets = new Set<import("node:net").Socket>();
    let missingPeerReady: (() => void) | undefined;
    server.on("connection", socket => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      let buffered = "";
      socket.on("data", chunk => {
        buffered += chunk.toString();
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const message = JSON.parse(buffered.slice(0, newline)) as { side: string; run: number };
        const peers = ready.get(message.run) ?? new Map<string, import("node:net").Socket>();
        ready.set(message.run, peers);
        peers.set(message.side, socket);
        if (mode === "missing-peer") missingPeerReady?.();
        if (peers.has("base") && peers.has("head") && mode !== "missing-peer") {
          for (const peer of peers.values()) peer.end("release");
          ready.delete(message.run);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    f.env.GATE_RENDEZVOUS_PORT = String((server.address() as import("node:net").AddressInfo).port);
    const child = spawn(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], {
      cwd: f.dir, env: f.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let outcome: { status: number | null; stdout: string; stderr: string } | undefined;
    let watchdogError: unknown;
    try { outcome = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      const finish = (error?: Error, status: number | null = null) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearTimeout(watchdog);
        if (error) reject(error); else resolve({ status, stdout, stderr });
      };
      child.once("error", error => finish(error));
      child.once("close", (status, signal) => finish(timedOut ? new Error("rendezvous control exceeded its outer watchdog") : undefined, status ?? (signal ? 1 : null)));
      const halt = () => {
        timedOut = true;
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      };
      watchdog = setTimeout(halt, 45000);
      // Start the missing-peer window after a real retry reaches the barrier.
      // Toolchain fingerprinting and baseline setup precede that observation.
      missingPeerReady = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(halt, 1000);
      };
    }); } catch (error) { watchdogError = error; }
    finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (mode === "missing-peer") {
      expect(watchdogError).toBeInstanceOf(Error);
      expect((watchdogError as Error).message).toContain("outer watchdog");
      expect(outcome).toBeUndefined();
      expect(stdout).not.toContain("NEW example.test.ts");
      expect(stdout).not.toContain("PRE-EXISTING example.test.ts");
      expect(ready.size).toBeGreaterThan(0);
      break;
    }
    expect(watchdogError).toBeUndefined();
    expect(outcome?.status, (outcome?.stdout ?? "") + (outcome?.stderr ?? "")).toBe(mode === "recovers" ? 0 : 1);
    expect(outcome?.stderr).not.toContain("gate error");
    expect(outcome?.stdout).toContain(mode === "recovers" ? "FLAKY example.test.ts: paired target (base 2 pass/0 fail; head 1 pass/1 fail)" : "NEW example.test.ts: paired target");
    expect(ready.size).toBe(0);
    for (const side of ["base", "head"]) expect(readFileSync(`${marker}-${attempt}-${side}`, "utf8")).toBe(mode === "recovers" ? "2" : "4");
  }
});
