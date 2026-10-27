import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "bun:test";

import { procBackend } from "../src/lib/proc";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "../src/lib/processIdentity";
import { stopFixtureIdentity, stopFixtureProcess } from "../src/lib/testing/fixtureProcess";
import { createTailscaleStub, hermeticTailscaleEnvironment, STUB_DNS_NAME } from "../src/test-helpers/tailscaleStub";
import { telemetryNotice } from "./telemetry-notice.mjs";

const fixtures = new Set<string>();
const children = new Set<ReturnType<typeof spawn>>();
const listeners = new Set<net.Server>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      Bun.sleep(3_000),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }));
  children.clear();
  await Promise.all([...listeners].map((listener) => new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  })));
  listeners.clear();
  await Promise.all([...fixtures].map((fixture) => rm(fixture, { recursive: true, force: true })));
  fixtures.clear();
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not reserve a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function nonLoopbackIpv4Address(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("the CLI exposure regression needs a non-loopback IPv4 interface");
}

async function probe(hostname: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    const request = http.get({ hostname, port, path: "/api/files", timeout: 1_000 }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(0);
    });
    request.once("error", () => resolve(0));
  });
}

async function waitForStatus(hostname: string, port: number, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probe(hostname, port) === expected) return;
    await Bun.sleep(50);
  }
  throw new Error(`listener at ${hostname}:${port} did not reach status ${expected}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(null);
    }, timeoutMs);
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      resolve(code);
    };
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timeout);
      resolve(child.exitCode);
    }
  });
}

function captureOutput(child: ReturnType<typeof spawn>) {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  return {
    async waitFor(text: string, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (output.includes(text)) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`CLI exited before ${JSON.stringify(text)} appeared:\n${output}`);
        }
        await Bun.sleep(25);
      }
      throw new Error(`CLI output did not include ${JSON.stringify(text)}:\n${output}`);
    },
    text: () => output,
  };
}

/**
 * A `bin/server-runtime.mjs` that behaves exactly like the real one except that
 * the bind probe fails for one address the way a Windows resolver fails for a
 * link-local zone it will not accept. The failure is delivered through the real
 * per-address seam, so the reading, its classification and the CLI's handling
 * of the result are all the shipped code.
 */
function unevaluableProbeModule(address: string): string {
  const real = JSON.stringify(pathToFileURL(path.resolve("bin/server-runtime.mjs")).href);
  return [
    `export * from ${real};`,
    `import { attemptAddressBind, readNonLoopbackBindState as read } from ${real};`,
    `const UNEVALUABLE = ${JSON.stringify(address)};`,
    "export function readNonLoopbackBindState(port, options = {}) {",
    "  return read(port, { ...options, listen: (address, addressPort) => address === UNEVALUABLE",
    '    ? Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND " + address), { code: "ENOTFOUND" }))',
    "    : attemptAddressBind(address, addressPort) });",
    "}",
  ].join("\n");
}

/* What a real start writes before it answers: Next's own banner on stdout, a
   startup diagnostic and a real error on stderr, and which quiet choice the
   launcher handed down. */
const STARTUP_CHATTER = `
import { existsSync, writeFileSync as noticeWritten } from "node:fs";
import { telemetryNotice } from "../../bin/telemetry-notice.mjs";
const notice = process.env.LLV_STATE_DIR + "/notice-output";
if (!existsSync(notice)) {
  console.log(telemetryNotice[process.env.LLV_LANG || "en"]);
  noticeWritten(notice, "1");
}
console.log("\\u001b[1m▲ Next.js 16.3.3\\u001b[22m");
console.log("- Local:         http://127.0.0.1:" + process.env.PORT);
console.log("- Network:       http://127.0.0.1:" + process.env.PORT);
console.log("✓ Ready in 0ms");
console.error("child quiet diagnostics: " + (process.env.LLV_QUIET_DIAGNOSTICS ?? "unset"));
console.error("Error: fixture failure that must reach the terminal");
`;

function runtimeDiagnostics(role: "viewer" | "runtime-host"): string {
  return `
import { startupDiagnostic } from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/startupDiagnostics.ts")).href)};
import { createViewerLoopMonitor } from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/viewerLoopMonitor.ts")).href)};
import { createPerformanceSpans } from ${JSON.stringify(pathToFileURL(path.resolve("src/lib/performanceSpans.ts")).href)};
process.env.LLV_STATE_OWNER = ${JSON.stringify(role)};
writeFileSync(process.env.LLV_STATE_DIR + "/" + process.env.LLV_STATE_OWNER + "-quiet.json",
  JSON.stringify({ quiet: process.env.LLV_QUIET_DIAGNOSTICS ?? null, loop: process.env.LLV_LOOP_DIAGNOSTICS ?? null }));
startupDiagnostic("info", "[fixture startup diagnostic] " + process.env.LLV_STATE_OWNER);
let at = 0;
const monitor = createViewerLoopMonitor(undefined, () => at, createPerformanceSpans(() => at));
at = 61000;
monitor.tick();
`;
}

/* Without `git: true` the fixture has no .git and the launcher reads it as a
   packaged install; with it, as a checkout. */
async function checkoutFixture(options: { ignoreHostname?: boolean; unevaluableAddress?: string; startupChatter?: boolean; failQr?: boolean; diagnostics?: boolean; git?: boolean; stopAll?: boolean; readinessDelayMs?: number } = {}): Promise<{ cli: string; env: NodeJS.ProcessEnv }> {
  const fixture = await mkdtemp(path.join(tmpdir(), "llv-cli-exposure-"));
  fixtures.add(fixture);
  if (options.git && spawnSync("git", ["init", "-q", fixture]).status !== 0) throw new Error("git init failed for the checkout fixture");
  const bin = path.join(fixture, "bin");
  const nextBin = path.join(fixture, "node_modules", ".bin");
  const runtimeHost = path.join(fixture, "dist", "runtime-host.mjs");
  const home = path.join(fixture, "home");
  const state = path.join(fixture, "state");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(nextBin, { recursive: true }),
    mkdir(path.dirname(runtimeHost), { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(state, { recursive: true }),
  ]);
  await Promise.all([
    /* The tailnet banner prints its QR code with it; without it the launcher
       died on the banner and left its Viewer and runtime host running. */
    options.failQr
      ? mkdir(path.join(fixture, "node_modules", "qrcode-terminal"))
      : symlink(path.resolve("node_modules/qrcode-terminal"), path.join(fixture, "node_modules", "qrcode-terminal"), "dir"),
    copyFile(path.resolve("bin/cli.mjs"), path.join(bin, "cli.mjs")),
    copyFile(path.resolve("bin/telemetry-notice.mjs"), path.join(bin, "telemetry-notice.mjs")),
    copyFile(path.resolve("bin/agent-binaries.mjs"), path.join(bin, "agent-binaries.mjs")),
    options.unevaluableAddress === undefined
      ? copyFile(path.resolve("bin/server-runtime.mjs"), path.join(bin, "server-runtime.mjs"))
      : writeFile(path.join(bin, "server-runtime.mjs"), unevaluableProbeModule(options.unevaluableAddress)),
    copyFile(path.resolve("bin/tailscale.mjs"), path.join(bin, "tailscale.mjs")),
    copyFile(path.resolve("bin/appDir.mjs"), path.join(bin, "appDir.mjs")),
    copyFile(path.resolve("bin/envAlias.mjs"), path.join(bin, "envAlias.mjs")),
    copyFile(path.resolve("bin/self-update-supervisor.mjs"), path.join(bin, "self-update-supervisor.mjs")),
    copyFile(path.resolve("bin/launcher-relaunch.mjs"), path.join(bin, "launcher-relaunch.mjs")),
    copyFile(path.resolve("bin/launcher-credentials.mjs"), path.join(bin, "launcher-credentials.mjs")),
    copyFile(path.resolve("bin/launcher-adoption.mjs"), path.join(bin, "launcher-adoption.mjs")),
    copyFile(path.resolve("bin/launcher-lock.mjs"), path.join(bin, "launcher-lock.mjs")),
    copyFile(path.resolve("bin/telegram-connector-retire.mjs"), path.join(bin, "telegram-connector-retire.mjs")),
    copyFile(path.resolve("bin/viewer-helpers-retire.mjs"), path.join(bin, "viewer-helpers-retire.mjs")),
    copyFile(path.resolve("bin/launcher-service-proof.mjs"), path.join(bin, "launcher-service-proof.mjs")),
    copyFile(path.resolve("bin/legacySystemd.mjs"), path.join(bin, "legacySystemd.mjs")),
    copyFile(path.resolve("bin/oomPolicy.mjs"), path.join(bin, "oomPolicy.mjs")),
    copyFile(path.resolve("bin/internalService.mjs"), path.join(bin, "internalService.mjs")),
    copyFile(path.resolve("bin/skillLinks.mjs"), path.join(bin, "skillLinks.mjs")),
    copyFile(path.resolve("bin/oomPolicy.mjs"), path.join(bin, "oomPolicy.mjs")),
    copyFile(path.resolve("bin/viewerGateKey.mjs"), path.join(bin, "viewerGateKey.mjs")),
    copyFile(path.resolve("bin/windows-process-identity.mjs"), path.join(bin, "windows-process-identity.mjs")),
    copyFile(path.resolve("bin/darwin-process-identity.mjs"), path.join(bin, "darwin-process-identity.mjs")),
    copyFile(path.resolve("bin/stop-all.mjs"), path.join(bin, "stop-all.mjs")),
    writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" })),
    writeFile(path.join(nextBin, "next"), `${options.startupChatter ? STARTUP_CHATTER : ""}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.LLV_STATE_DIR, "web.pid"), String(process.pid));
const hostnameIndex = process.argv.indexOf("--hostname");
const hostname = ${options.ignoreHostname ? JSON.stringify("0.0.0.0") : "hostnameIndex === -1 ? \"0.0.0.0\" : process.argv[hostnameIndex + 1]"};
await Bun.sleep(${options.readinessDelayMs ?? 0});
const server = Bun.serve({
  hostname,
  port: Number(process.env.PORT),
  async fetch(request) {
    /* The menu's «Stop Delegatus», as the route starts it. */
    if (${options.stopAll ? "true" : "false"} && new URL(request.url).pathname === "/api/stop-all-fixture") {
      const { productionStopAllPorts, startStopAll } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/lib/stopAll.ts")).href)});
      return Response.json(await startStopAll("en", productionStopAllPorts()));
    }
    /* What the launcher handed the Viewer, for the phone-access case. */
    /* Whether the gate is on, never the key itself. */
    if (new URL(request.url).pathname === "/api/access") return Response.json({ tailnetUrl: process.env.LLV_TS_URL ?? null, host: process.env.LLV_TS_HOST ?? null, gated: Boolean(process.env.LLV_TOKEN) });
    if (new URL(request.url).pathname === "/api/control-port") return Response.json({ port: process.env.LLV_VIEWER_PORT ?? null });
    return new Response("ok");
  },
});
${options.diagnostics ? runtimeDiagnostics("viewer") : ""}
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`),
    writeFile(runtimeHost, `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET;
const fencePath = process.env.LLV_RUNTIME_HOST_FENCE;
writeFileSync(path.join(process.env.LLV_STATE_DIR, "runtime.pid"), String(process.pid));
mkdirSync(path.dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });
const server = net.createServer((socket) => socket.end());
server.listen(socketPath, () => writeFileSync(fencePath, JSON.stringify({
  pid: process.pid,
  startIdentity: process.pid + ":fixture",
  acquisitionId: "fixture-acquisition-id",
})));
${options.diagnostics ? runtimeDiagnostics("runtime-host") : ""}
const stop = () => server.close(() => {
  rmSync(socketPath, { force: true });
  rmSync(fencePath, { force: true });
  process.exit(0);
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`),
  ]);
  if (options.failQr) {
    const qr = path.join(fixture, "node_modules", "qrcode-terminal");
    await writeFile(path.join(qr, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    await writeFile(path.join(qr, "index.js"), `
import ${JSON.stringify(pathToFileURL(path.resolve("src/lib/testing/fixtureLifetime.ts")).href)};
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.LLV_STATE_DIR;
writeFileSync(join(state, "qr-ready"), "ready");
while (!existsSync(join(state, "qr-fail"))) await new Promise(resolve => setTimeout(resolve, 25));
throw new Error("fixture QR failure");
`);
  }
  /* Hermetic for the tailnet gate: a shell the Viewer spawned carries these,
     and never the host's Tailscale through the Docker shim. */
  const inherited = hermeticTailscaleEnvironment(process.env, path.join(fixture, "no-tailscale-shim", "tailscale"));
  delete inherited.LLV_TOKEN;
  delete inherited.LLV_TS_HOST;
  delete inherited.LLV_TS_URL;
  delete inherited.LLV_DEBUG;
  delete inherited.DELEGATUS_DEBUG;
  delete inherited.LLV_QUIET_DIAGNOSTICS;
  delete inherited.DELEGATUS_QUIET_DIAGNOSTICS;
  delete inherited.JOURNAL_STREAM;
  return {
    cli: path.join(bin, "cli.mjs"),
    env: {
      ...inherited,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      LLV_STATE_DIR: state,
      TMPDIR: path.join(fixture, "tmp"),
      LLV_BUN_EXECUTABLE: process.execPath,
    },
  };
}

test("the checkout next start path keeps the default listener on loopback", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await waitForStatus("127.0.0.1", port, 200);
  await output.waitFor("Delegatus v", 10_000);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(await probe(nonLoopbackIpv4Address(), port)).toBe(0);
});

test("the first start keeps a cold Viewer alive beyond fifteen seconds", async () => {
  const fixture = await checkoutFixture({ readinessDelayMs: 17_000 });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await output.waitFor("Delegatus v", 25_000);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(await probe("127.0.0.1", port)).toBe(200);
}, 30_000);

test("a machine that still has the retired systemd unit is told how to move to Docker, and the Viewer still starts", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const unitDir = path.join(fixture.env.XDG_CONFIG_HOME!, "systemd", "user");
  await mkdir(unitDir, { recursive: true });
  await writeFile(path.join(unitDir, "agent-log-viewer.service"), "[Service]\n");
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: { ...fixture.env, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await output.waitFor("The systemd install of Delegatus is retired: Docker is the only install.", 10_000);
  await output.waitFor("Delegatus v", 10_000);
  await waitForStatus("127.0.0.1", port, 200);
  expect(output.text()).toContain("systemctl --user disable --now agent-log-viewer.service\n");
  expect(output.text()).toContain(`rm ${path.join(unitDir, "agent-log-viewer.service")}\n`);
  expect(output.text()).toContain("https://github.com/Latand/delegatus/blob/main/docs/docker.md");
  expect(output.text().split("systemd install of Delegatus is retired").length).toBe(2);
  expect(child.exitCode).toBeNull();
});

test("a pre-existing non-loopback listener does not impersonate a widened Viewer bind", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const nonLoopbackAddress = nonLoopbackIpv4Address();
  const unrelated = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.listen({ host: nonLoopbackAddress, port, exclusive: true }, resolve);
  });
  listeners.add(unrelated);

  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await waitForStatus("127.0.0.1", port, 200);
  await output.waitFor("Delegatus v", 10_000);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(await probe(nonLoopbackAddress, port)).toBe(204);
});

test("the CLI rejects a checkout server that binds beyond the requested loopback address", async () => {
  const fixture = await checkoutFixture({ ignoreHostname: true });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: { ...fixture.env, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);
  // The exposure guard may stop the server before a polling client sees it.
  await output.waitFor("loopback was requested", 10_000);
  const exitCode = await waitForExit(child, 2_000);
  expect(exitCode).toBe(1);
  expect(await probe(nonLoopbackIpv4Address(), port)).toBe(0);
});

test("an address the platform will not evaluate neither stops startup nor claims exposure", async () => {
  const nonLoopbackAddress = nonLoopbackIpv4Address();
  const fixture = await checkoutFixture({ unevaluableAddress: nonLoopbackAddress });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    // LLV_LANG pins the message table the assertion below reads, so the
    // operator's own locale cannot decide whether this test passes.
    env: { ...fixture.env, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  // The banner comes first: it is the assertion that names the CLI's own stderr
  // when a probe the guard could not answer killed startup instead.
  await output.waitFor("Delegatus v", 10_000);
  // What the guard could not cover is said out loud rather than only recorded.
  await output.waitFor(
    `the exposure check skipped addresses this machine would not answer for: ${nonLoopbackAddress}`,
    10_000,
  );
  await waitForStatus("127.0.0.1", port, 200);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  // The probe could not answer for that address and the guard read nothing into
  // the silence: startup survived, and the listener is still loopback-only.
  expect(await probe(nonLoopbackAddress, port)).toBe(0);
});

test("phone access remembered by the setup guide starts the real CLI in tailnet mode with a background serve", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const stub = createTailscaleStub({ root: path.dirname(fixture.env.TMPDIR!) });
  const configDir = path.join(fixture.env.XDG_CONFIG_HOME!, "agent-log-viewer");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "phone-access"), "tailscale\n");
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: { ...fixture.env, PATH: `${stub.dir}:${path.dirname(process.execPath)}`, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await output.waitFor("Tailnet:", 15_000);
  const token = (await readFile(path.join(configDir, "token"), "utf8")).trim();
  expect(token).toMatch(/^[0-9a-f]{32}$/);
  const answer = await fetch(`http://127.0.0.1:${port}/api/access`).then((response) => response.json()) as { tailnetUrl: string | null; host: string | null; gated: boolean };
  expect(answer).toEqual({ tailnetUrl: `https://${STUB_DNS_NAME}/?k=${token}`, host: STUB_DNS_NAME, gated: true });
  /* Published once, in the background, and never as a foreground child. */
  expect(stub.calls()).toContain(`serve --bg ${port}`);
  expect(stub.calls()).not.toContain(`serve ${port}`);
  expect(await probe(nonLoopbackIpv4Address(), port)).toBe(0);
});

async function blockingForegroundServe(fixture: { env: NodeJS.ProcessEnv }, stub: ReturnType<typeof createTailscaleStub>) {
  const script = await readFile(path.join(stub.dir, "tailscale"), "utf8");
  const serve = `await import(${JSON.stringify(pathToFileURL(path.resolve("src/lib/testing/fixtureLifetime.ts")).href)}); require("node:fs").writeFileSync(${JSON.stringify(path.join(fixture.env.LLV_STATE_DIR!, "serve.pid"))}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
  await writeFile(path.join(stub.dir, "tailscale"), `#!/bin/sh
if [ "$1" = "serve" ] && [ "$2" != "status" ]; then
  exec '${process.execPath.replaceAll("'", "'\\''")}' --eval '${serve.replaceAll("'", "'\\''")}'
fi
${script.slice(script.indexOf("\n") + 1)}`, { mode: 0o755 });
}

test.each(["remembered", "foreground"] as const)("a tailnet banner failure ends the CLI's own processes: %s", async (mode) => {
  const fixture = await checkoutFixture({ failQr: true });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const state = fixture.env.LLV_STATE_DIR!;
  const stub = createTailscaleStub({ root: path.dirname(fixture.env.TMPDIR!) });
  if (mode === "remembered") {
    const config = path.join(fixture.env.XDG_CONFIG_HOME!, "agent-log-viewer");
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "phone-access"), "tailscale\n");
  } else {
    await blockingForegroundServe(fixture, stub);
  }
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port), ...(mode === "foreground" ? ["--tailscale"] : [])], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: { ...fixture.env, PATH: `${stub.dir}:${path.dirname(process.execPath)}`, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);
  const owned: ProcessIdentity[] = [];
  try {
    const deadline = Date.now() + 15_000;
    const names = ["web", "runtime", ...(mode === "foreground" ? ["serve"] : [])];
    for (;;) {
      try {
        await readFile(path.join(state, "qr-ready"));
        const pids = await Promise.all(names.map(async name => Number(await readFile(path.join(state, `${name}.pid`), "utf8"))));
        for (const pid of pids) {
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          owned.push(captureProcessIdentity(pid));
        }
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw new Error(`fixture did not reach its failure barrier: ${String(error)}\n${output.text()}`);
        await Bun.sleep(25);
      }
    }
    expect(owned.every(identity => processIdentityStatus(identity) === "alive")).toBe(true);
    await writeFile(path.join(state, "qr-fail"), "fail");
    expect(await waitForExit(child, 10_000)).toBe(1);
    expect(output.text()).toContain("fixture QR failure");
    expect(owned.map(identity => processIdentityStatus(identity))).toEqual(names.map(() => "dead"));
    expect(await probe("127.0.0.1", port)).toBe(0);
  } finally {
    // The red run must reap only the PIDs this fixture recorded before failing.
    await stopFixtureProcess(child);
    await Promise.all(owned.map(identity => stopFixtureIdentity(identity)));
  }
}, 30_000);

test("a Viewer exit during the startup bind check awaits all owned processes and preserves its status", async () => {
  const fixture = await checkoutFixture();
  const root = path.dirname(path.dirname(fixture.cli));
  const state = fixture.env.LLV_STATE_DIR!;
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const stub = createTailscaleStub({ root: path.dirname(fixture.env.TMPDIR!) });
  await blockingForegroundServe(fixture, stub);
  const realRuntime = JSON.stringify(pathToFileURL(path.resolve("bin/server-runtime.mjs")).href);
  const identityModule = JSON.stringify(pathToFileURL(path.resolve("src/lib/processIdentity.ts")).href);
  await writeFile(path.join(root, "bin", "server-runtime.mjs"), `
export * from ${realRuntime};
import { readNonLoopbackBindState as read } from ${realRuntime};
import { captureProcessIdentity, processIdentityStatus } from ${identityModule};
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const state = process.env.LLV_STATE_DIR;
let calls = 0;
export async function readNonLoopbackBindState(port) {
  if (++calls === 2) {
    const web = captureProcessIdentity(Number(readFileSync(join(state, "web.pid"), "utf8")));
    writeFileSync(join(state, "bind-ready"), "ready");
    while (processIdentityStatus(web) === "alive") await new Promise(resolve => setTimeout(resolve, 10));
    // Give the launcher's exit event time to start its slow serve cleanup.
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return read(port);
}
`);
  await writeFile(path.join(root, "node_modules", ".bin", "next"), `${await readFile(path.join(root, "node_modules", ".bin", "next"), "utf8")}
import { existsSync } from "node:fs";
setInterval(() => { if (existsSync(join(process.env.LLV_STATE_DIR, "bind-exit"))) process.exit(7); }, 10);
`);
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port), "--tailscale"], {
    cwd: root,
    env: { ...fixture.env, PATH: `${stub.dir}:${path.dirname(process.execPath)}`, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);
  const owned: ProcessIdentity[] = [];
  try {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await readFile(path.join(state, "bind-ready"));
        const pids = await Promise.all(["web", "runtime", "serve"].map(async name => Number(await readFile(path.join(state, `${name}.pid`), "utf8"))));
        for (const pid of pids) {
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          owned.push(captureProcessIdentity(pid));
        }
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw new Error(`fixture did not reach its bind barrier: ${String(error)}\n${output.text()}`);
        await Bun.sleep(25);
      }
    }
    expect(owned.every(identity => processIdentityStatus(identity) === "alive")).toBe(true);
    await writeFile(path.join(state, "bind-exit"), "exit");
    expect(await waitForExit(child, 10_000)).toBe(7);
    expect(owned.map(identity => processIdentityStatus(identity))).toEqual(["dead", "dead", "dead"]);
    expect(await probe("127.0.0.1", port)).toBe(0);
  } finally {
    await stopFixtureProcess(child);
    await Promise.all(owned.map(identity => stopFixtureIdentity(identity)));
  }
}, 30_000);

test("a remembered choice whose publish fails says so and advertises no tailnet link", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const stub = createTailscaleStub({ root: path.dirname(fixture.env.TMPDIR!) });
  stub.setServeMode("fail");
  const configDir = path.join(fixture.env.XDG_CONFIG_HOME!, "agent-log-viewer");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "phone-access"), "tailscale\n");
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: { ...fixture.env, PATH: `${stub.dir}:${path.dirname(process.execPath)}`, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await output.waitFor("Delegatus v", 15_000);
  await waitForStatus("127.0.0.1", port, 200);
  /* The publish failed, so the tailnet address answers nothing: the banner
     that would carry it, and its QR, are not printed. */
  expect(output.text()).toContain("listener already in use");
  expect(output.text()).not.toContain("Tailnet:");
  /* The key was minted for this start, and the local link carries it. */
  expect(output.text()).toContain(`http://127.0.0.1:${port}/?k=`);
}, 30_000);

test("a remembered choice whose Tailscale went away starts locally and says why", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const stub = createTailscaleStub({ root: path.dirname(fixture.env.TMPDIR!) });
  stub.setStatus({ BackendState: "NeedsLogin" });
  const configDir = path.join(fixture.env.XDG_CONFIG_HOME!, "agent-log-viewer");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "phone-access"), "tailscale\n");
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    /* A stale link from the launching shell is not advertised by a local start. */
    env: { ...fixture.env, PATH: `${stub.dir}:${path.dirname(process.execPath)}`, LLV_LANG: "en", LLV_TS_URL: "https://stale.tailnet.example/?k=stale", LLV_TS_HOST: "stale.tailnet.example" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await output.waitFor("this start is local only", 10_000);
  await waitForStatus("127.0.0.1", port, 200);
  const answer = await fetch(`http://127.0.0.1:${port}/api/access`).then((response) => response.json()) as { tailnetUrl: string | null; gated: boolean };
  expect(answer.tailnetUrl).toBeNull();
  /* The gate stays on. A background mapping an earlier tailnet start left
     behind resumes when tailscaled comes back, and it would otherwise proxy
     the tailnet into a Viewer that asks nothing. */
  expect(answer.gated).toBe(true);
  expect((await readFile(path.join(configDir, "token"), "utf8")).trim()).toMatch(/^[0-9a-f]{32}$/);
  expect(stub.calls().some((call) => call.startsWith("serve"))).toBe(false);
}, 30_000);

test("a start prints the banner first, hides Next's startup lines and still prints a real error", async () => {
  const fixture = await checkoutFixture({ startupChatter: true });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: { ...fixture.env, LLV_LANG: "en" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await output.waitFor("fixture failure that must reach the terminal", 10_000);
  const text = output.text();
  expect(text).toContain("DELEGATUS_TELEMETRY=0");
  expect(text).toContain("DO_NOT_TRACK=1");
  expect(text.split(telemetryNotice.en)).toHaveLength(2);
  expect(text).not.toContain("Reads logs from");
  expect(text.indexOf("Delegatus v")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("Delegatus v")).toBeLessThan(text.indexOf("Error: fixture failure"));
  expect(text).toContain(`  Open http://127.0.0.1:${port}/ in your browser.`);
  expect(text).not.toContain("Opened:");
  expect(text).toContain("DELEGATUS_DEBUG=1");
  expect(text).toContain("child quiet diagnostics: unset");
  expect(text).not.toContain("Next.js");
  expect(text).not.toContain("- Local:");
  expect(text).not.toContain("Ready in");
});

test.each(["en", "uk"] as const)("the %s notice is printed once on first start and stays settled after restart", async lang => {
  const fixture = await checkoutFixture({ startupChatter: true });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  for (const first of [true, false]) {
    const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
      cwd: path.dirname(path.dirname(fixture.cli)), env: { ...fixture.env, LLV_LANG: lang },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const output = captureOutput(child);
    await output.waitFor("fixture failure that must reach the terminal", 10_000);
    expect(output.text().split(telemetryNotice[lang])).toHaveLength(first ? 2 : 1);
    child.kill("SIGINT");
    await waitForExit(child, 10_000);
    expect(child.exitCode).toBe(0);
  }
});

/* Use a real PTY for the interactive case; CLI children still use pipes, as
   they do in production. Journal metadata must override even a terminal. */
/* `loop` is the loop-gap volume the children are handed: bounded for a
   packaged install, unset for a checkout (the service's journal keeps every
   line, even when a shell exported the bounded choice) and under debug. */
for (const scenario of [
  { name: "piped output", terminal: false, journal: undefined, debug: undefined, quiet: null, git: false, loop: "bounded" },
  { name: "journal output", terminal: false, journal: "1:1", debug: undefined, quiet: null, git: false, loop: "bounded" },
  { name: "checkout journal output", terminal: false, journal: "1:1", debug: undefined, quiet: null, git: true, loop: null },
  { name: "interactive terminal", terminal: true, journal: undefined, debug: undefined, quiet: "1", git: false, loop: "bounded" },
  { name: "journal with a terminal", terminal: true, journal: "1:1", debug: undefined, quiet: null, git: false, loop: "bounded" },
  { name: "checkout journal with a terminal", terminal: true, journal: "1:1", debug: undefined, quiet: null, git: true, loop: null },
  { name: "debug terminal", terminal: true, journal: undefined, debug: "1", quiet: null, git: false, loop: null },
]) {
  // Bun's PTY is a POSIX facility; piped cases also run on Windows.
  test.skipIf(scenario.terminal && process.platform === "win32")(
    `${scenario.name} selects diagnostics for both children and retains stall evidence`, async () => {
      const fixture = await checkoutFixture({ diagnostics: true, git: scenario.git });
      await mkdir(fixture.env.TMPDIR!, { recursive: true });
      const port = await availablePort();
      let output = "";
      const env = { ...fixture.env, JOURNAL_STREAM: scenario.journal, DELEGATUS_DEBUG: scenario.debug,
        LLV_QUIET_DIAGNOSTICS: scenario.quiet === "1" ? undefined : "1",
        LLV_LOOP_DIAGNOSTICS: scenario.loop === null ? "bounded" : undefined };
      const child = Bun.spawn([process.execPath, "--bun", fixture.cli, "--no-open", "--port", String(port)], {
        cwd: path.dirname(path.dirname(fixture.cli)), env,
        ...(scenario.terminal ? { terminal: { data(_terminal: Bun.Terminal, chunk: Uint8Array) { output += Buffer.from(chunk).toString(); } } }
          : { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
      });
      const identity = captureProcessIdentity(child.pid);
      const readers = scenario.terminal ? [] : [child.stdout, child.stderr].map(async stream => {
        const reader = (stream as ReadableStream<Uint8Array>).getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            output += Buffer.from(value).toString();
          }
        } finally { reader.releaseLock(); }
      });
      try {
        await waitForStatus("127.0.0.1", port, 200);
        for (const role of ["viewer", "runtime-host"]) {
          expect(JSON.parse(await readFile(path.join(fixture.env.LLV_STATE_DIR!, `${role}-quiet.json`), "utf8")))
            .toEqual({ quiet: scenario.quiet, loop: scenario.loop });
        }
        const deadline = Date.now() + 10_000;
        const diagnosticLines = () => output.split(/\r?\n/).filter(line => /^\[(viewer loop-gap|performance summary)\]/.test(line));
        while (diagnosticLines().length < 4 && child.exitCode === null && Date.now() < deadline) await Bun.sleep(25);
        expect(diagnosticLines()).toHaveLength(4);
        for (const role of ["viewer", "runtime-host"]) {
          for (const prefix of ["[viewer loop-gap] ", "[performance summary] "]) {
            const reports = diagnosticLines().filter(line => line.startsWith(prefix)).map(line => JSON.parse(line.slice(prefix.length)));
            expect(reports.filter(report => report.role === role)).toHaveLength(1);
          }
          expect(output.includes(`[fixture startup diagnostic] ${role}`)).toBe(scenario.quiet === null);
        }
      } catch (error) {
        throw new Error(`CLI diagnostics failed:\n${output}`, { cause: error });
      } finally {
        await stopFixtureIdentity(identity);
        await child.exited;
        await Promise.all(readers);
        child.terminal?.close();
      }
    }, 30_000);
}

test("DELEGATUS_DEBUG=1 keeps Next's startup lines and lets the children print their diagnostics", async () => {
  const fixture = await checkoutFixture({ startupChatter: true });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: { ...fixture.env, LLV_LANG: "en", DELEGATUS_DEBUG: "1", LLV_QUIET_DIAGNOSTICS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await output.waitFor("Delegatus v", 10_000);
  await output.waitFor("fixture failure that must reach the terminal", 10_000);
  const text = output.text();
  expect(text).toContain("▲ Next.js 16.3.3");
  expect(text).toContain(`- Local:         http://127.0.0.1:${port}`);
  expect(text).toContain("child quiet diagnostics: unset");
  expect(text).toContain("Reads logs from");
  expect(text).not.toContain("DELEGATUS_DEBUG=1 —");
});


test("a custom CLI port reaches the Viewer and runtime children with an env-only gate", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const key = crypto.randomUUID();
  fixture.env.LLV_TOKEN = key;
  const port = await availablePort();
  const runtime = path.join(path.dirname(path.dirname(fixture.cli)), "dist", "runtime-host.mjs");
  await writeFile(runtime, (await readFile(runtime, "utf8")) + `
writeFileSync(path.join(process.env.LLV_STATE_DIR, "runtime-control.json"), JSON.stringify({
  port: process.env.LLV_VIEWER_PORT ?? null, credentialInherited: process.env.LLV_TOKEN === ${JSON.stringify(key)},
}));
`);
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "-p", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)), env: fixture.env, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);
  await waitForStatus("127.0.0.1", port, 200);
  await output.waitFor("Delegatus v", 10_000);
  expect(await (await fetch(`http://127.0.0.1:${port}/api/access`)).json()).toMatchObject({ gated: true });
  expect(await (await fetch(`http://127.0.0.1:${port}/api/control-port`)).json()).toEqual({ port: String(port) });
  expect(JSON.parse(await readFile(path.join(fixture.env.LLV_STATE_DIR!, "runtime-control.json"), "utf8"))).toEqual({ port: String(port), credentialInherited: true });
});

/* The menu's «Stop Delegatus» end to end: the Viewer starts the stop, the stop
   asks the real launcher to end, the launcher retires the Viewer and its
   process group, and the stop, in a group of its own, goes on to the agent
   host the registry records. A same-named process nobody recorded stays. */
test("the menu's stop outlives the Viewer it stops and ends the launcher, the runtime host and the recorded agent host", async () => {
  const fixture = await checkoutFixture({ stopAll: true });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const state = fixture.env.LLV_STATE_DIR!;
  const hostScript = path.join(path.dirname(path.dirname(fixture.cli)), "codex");
  await writeFile(hostScript, "setInterval(() => {}, 1000);\n");
  const host = spawn(process.execPath, [hostScript, "app-server"], { detached: true, stdio: "ignore" });
  const foreign = spawn(process.execPath, [hostScript, "app-server"], { detached: true, stdio: "ignore" });
  children.add(host);
  children.add(foreign);
  const hostIdentity = captureProcessIdentity(host.pid!);
  const foreignIdentity = captureProcessIdentity(foreign.pid!);
  const { AgentRegistry, normalizeRegistry } = await import("../src/lib/agent/registry");
  const { SqliteAgentRegistryStore } = await import("../src/lib/agent/sqliteRegistryStore");
  const seed = new AgentRegistry(path.join(state, "seed.json"), undefined, undefined, { sqliteMode: "off" });
  const initial = seed.snapshot();
  seed.close();
  (initial.entries as Record<string, unknown>)["codex:orchestrator"] = {
    key: { engine: "codex", sessionId: "orchestrator" }, artifactPath: "/sessions/orchestrator.jsonl", cwd: "/work", accountId: null,
    status: "idle", host: null,
    structuredHost: { kind: "codex-app-server", endpoint: "stdio:orchestrator", process: hostIdentity, eventCursor: 0, protocolVersion: "fixture-v1",
      writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
    claimEpoch: 1, claimOwner: null, pendingAction: null, updatedAt: "2026-10-21T15:00:00.000Z",
  };
  new SqliteAgentRegistryStore(path.join(state, "agent-registry.sqlite"), { initialSnapshot: initial, normalize: normalizeRegistry }).close();

  const port = await availablePort();
  const cli = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)), env: { ...fixture.env, LLV_LANG: "en" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(cli);
  const output = captureOutput(cli);
  await waitForStatus("127.0.0.1", port, 200);
  await output.waitFor("Delegatus v", 10_000);
  const runtimePid = Number(await readFile(path.join(state, "runtime.pid"), "utf8"));
  const webPid = Number(await readFile(path.join(state, "web.pid"), "utf8"));
  const runtime = captureProcessIdentity(runtimePid);
  const web = captureProcessIdentity(webPid);

  const started = await (await fetch(`http://127.0.0.1:${port}/api/stop-all-fixture`)).json() as { ok: boolean; pid: number };
  expect(started).toMatchObject({ ok: true });
  const stop = captureProcessIdentity(started.pid);
  try {
    expect(await waitForExit(cli, 20_000)).toBe(0);
    const deadline = Date.now() + 20_000;
    while (processIdentityStatus(stop) === "alive" && Date.now() < deadline) await Bun.sleep(25);
    expect(processIdentityStatus(stop)).not.toBe("alive");
    const report = await readFile(path.join(state, "stop-all.log"), "utf8");
    expect(report).toContain(`Stopped the launcher (pid ${cli.pid}), and with it the Viewer and the runtime host it started.`);
    expect(report).toContain(`codex-app-server pid ${host.pid} (codex orchestrator)`);
    /* Exited, whether or not its parent has reaped it yet. */
    const ended = (identity: ProcessIdentity) => processIdentityStatus(identity) === "dead" || procBackend.processExited(identity.pid);
    for (let i = 0; i < 200 && !(host.exitCode !== null || host.signalCode !== null); i++) await Bun.sleep(25);
    expect(host.signalCode).toBe("SIGTERM");
    expect([runtime, web].map(ended)).toEqual([true, true]);
    expect(ended(foreignIdentity)).toBe(false);
  } catch (error) {
    throw new Error(`stop-all chain failed:\n${output.text()}`, { cause: error });
  } finally {
    await stopFixtureIdentity(stop);
  }
}, 60_000);
