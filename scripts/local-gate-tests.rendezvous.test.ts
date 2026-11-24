import { createServer, expect, fixture, path, readFileSync, root, source, spawn, test, writeFileSync } from "./local-gate-tests.fixture";
import { ownFixtureTree, stopFixtureTree } from "../src/lib/testing/fixtureProcess";

test.each(["recovers", "stable", "withheld-release"] as const)("real confirmation processes rendezvous on both sides: %s", async mode => {
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
if (run === 2 && side === "head" && process.env.GATE_CONFIRMATION_FIXTURE_RUN === "0" && ${JSON.stringify(mode)} === "recovers") await Bun.sleep(31000);
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
  for (let attempt = 0; attempt < (mode === "withheld-release" ? 1 : 2); attempt++) {
    f.env.GATE_CONFIRMATION_FIXTURE_RUN = String(attempt);
    const server = createServer();
    const ready = new Map<number, Map<string, import("node:net").Socket>>();
    const sockets = new Set<import("node:net").Socket>();
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let outputWhileHeld: string | undefined;
    let stdout = "", stderr = "";
    const releasePair = (run: number, peers: Map<string, import("node:net").Socket>) => {
      if (!peers.has("base") || !peers.has("head")) return;
      for (const peer of peers.values()) peer.end("release");
      ready.delete(run);
    };
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
        if (mode === "withheld-release" && outputWhileHeld === undefined) {
          // Observe the withheld response only after both real workers arrive.
          // Then let the comparator join its workers and close their services.
          if (!releaseTimer && peers.has("base") && peers.has("head")) {
            releaseTimer = setTimeout(() => {
              outputWhileHeld = stdout;
              for (const [run, waiting] of ready) releasePair(run, waiting);
            }, 1_000);
          }
        } else {
          releasePair(message.run, peers);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    f.env.GATE_RENDEZVOUS_PORT = String((server.address() as import("node:net").AddressInfo).port);
    const child = ownFixtureTree(spawn(process.execPath, [path.join(root, "scripts/local-gate-tests.ts"), "--base", base, "./example.test.ts"], {
      cwd: f.dir, env: f.env, stdio: ["ignore", "pipe", "pipe"],
    }));
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let status: number | null;
    try {
      status = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          if (signal) reject(new Error(`rendezvous comparator exited on ${signal}`));
          else resolve(code);
        });
        // Allow the two services to start before the deliberate 31-second wait.
        watchdog = setTimeout(() => reject(new Error("rendezvous control exceeded its outer watchdog")),
          mode === "recovers" && attempt === 0 ? 80_000 : 45_000);
      });
    } finally {
      clearTimeout(watchdog);
      clearTimeout(releaseTimer);
      for (const socket of sockets) socket.destroy();
      try { await stopFixtureTree(child); }
      finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    }
    if (mode === "withheld-release") {
      expect(outputWhileHeld).toBeDefined();
      expect(outputWhileHeld).not.toMatch(/(?:NEW|PRE-EXISTING|FLAKY) example\.test\.ts/);
    }
    expect(status, stdout + stderr).toBe(mode === "recovers" ? 0 : 1);
    expect(stderr).not.toContain("gate error");
    expect(stdout).toContain(mode === "recovers" ? "FLAKY example.test.ts: paired target (base 2 pass/0 fail; head 1 pass/1 fail)" : "NEW example.test.ts: paired target");
    expect(ready.size).toBe(0);
    for (const side of ["base", "head"]) expect(readFileSync(`${marker}-${attempt}-${side}`, "utf8")).toBe(mode === "recovers" ? "2" : "4");
  }
}, 135_000);
