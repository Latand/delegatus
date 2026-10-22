// An owned process boundary lets the parent independently bound startup and teardown.
import fs from "node:fs";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexSocketTransport } from "./codexSocketTransport";

const [root, mode] = process.argv.slice(2);
const directory = fs.openSync(root!, "r");
process.env.HOME = `/proc/${process.pid}/fd/${directory}`;
const marker = path.join(root!, "ready");
const clock = Date.now;
if (mode === "timeout" || mode === "ownership") Date.now = () => clock() + (fs.existsSync(marker) ? 11_000 : 0);
const peer = `
  const fs = require("node:fs");
  const file = process.argv.at(-1).slice("unix://".length);
  const mode = process.env.PEER_MODE;
  fs.writeSync(2, "EADDRINUSE: callback bind refused\\n");
  fs.writeSync(2, "Bearer " + "private".repeat(8) + "\\n");
  fs.writeSync(2, process.env.HOME + "/private/file\\n");
  if (mode === "exit" || mode === "large" || mode === "boundary" || mode === "secret") {
    if (mode === "large") fs.writeSync(2, "x".repeat(20000) + "\\n");
    if (mode === "boundary") fs.writeSync(2, "Bearer " + "private".repeat(3000));
    if (mode === "secret") {
      // The key header and the first payload lines are visible; the footer is past the retained bytes.
      for (let line = 0; line < 6; line++) fs.writeSync(2, "x".repeat(100) + "\\n");
      fs.writeSync(2, "-----BEGIN PRIVATE KEY-----\\n");
      for (let line = 0; line < 150; line++) fs.writeSync(2, "KEYPAYLOAD" + String(line).padStart(3, "0") + "A".repeat(50) + "\\n");
      fs.writeSync(2, "-----END PRIVATE KEY-----\\n");
    }
    process.exit(23);
  }
  if (mode === "signal" || mode === "wrappedsignal") process.kill(process.pid, "SIGTERM");
  if (mode === "success" || mode === "chatty") {
    const server = Bun.serve({ unix: file,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response("fixture"); },
      websocket: { message(socket, message) {
        if (String(message) === "flood") {
          // A chatty listener: far more than any storage bound.
          const chunk = "f".repeat(65536);
          for (let written = 0; written < 4 * 1024 * 1024; written += chunk.length) fs.writeSync(2, chunk);
          socket.send("flooded");
        } else socket.send(message);
      } },
    });
    fs.chmodSync(file, 0o600);
  }
  if (mode === "ownership") {
    const server = Bun.serve({ unix: file, fetch() { return new Response("fixture"); } });
    fs.chmodSync(file, 0o777);
  }
  fs.writeFileSync(process.env.PEER_MARKER, "ready");
  if (mode === "chatty") setInterval(() => {
    if (!fs.existsSync(process.env.PEER_MARKER + ".flood") || fs.existsSync(process.env.PEER_MARKER + ".flooded")) return;
    const chunk = "g".repeat(65536);
    for (let written = 0; written < 4 * 1024 * 1024; written += chunk.length) fs.writeSync(2, chunk);
    fs.writeFileSync(process.env.PEER_MARKER + ".flooded", "done");
  }, 10);
  if (mode === "wrapped") setInterval(() => {
    if (fs.existsSync(process.env.PEER_MARKER + ".release")) process.exit(23);
  }, 10);
  setInterval(() => {}, 1000);
`;
let sink: number | undefined;
let peerProcess: ChildProcessWithoutNullStreams | undefined;
try {
  const transport = await CodexSocketTransport.launch(mode === "missing" ? path.join(root!, "missing-binary") : process.execPath, ["-e", peer], {
    detached: true, env: { ...process.env, PEER_MODE: mode, PEER_MARKER: marker },
  }, undefined, async (command, args, options, base) => {
    const diagnostic = path.join(root!, "wrapper.stderr");
    fs.rmSync(diagnostic, { force: true });
    peerProcess = base(command, args, mode === "wrapped" || mode === "chatty"
      ? { ...options, env: { ...options.env, NODE_ENV: options.env?.NODE_ENV ?? "test", LLV_SIGNAL_DIAGNOSTIC: diagnostic } } : options);
    // The retained descriptor outlives the diagnostic name the transport unlinks.
    if (mode === "chatty") sink = fs.openSync(fs.readlinkSync(diagnostic), "r");
    if (mode === "wrapped") {
      while (!fs.existsSync(marker)) await Bun.sleep(10);
      fs.unlinkSync(diagnostic);
      return new Proxy(peerProcess, { get(target, key) {
        if (key === "exitCode") fs.writeFileSync(`${marker}.release`, "release");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    if (mode === "wrappedsignal") await new Promise<void>(resolve => peerProcess!.once("close", () => resolve()));
    return peerProcess;
  });
  try {
    if (fs.existsSync(path.join(path.dirname(transport.endpoint.slice("codex-unix:".length)), "startup.stderr"))) {
      throw new Error("startup diagnostic name survived successful connection");
    }
    const echoed = new Promise<string>(resolve => transport.stdout.once("data", chunk => resolve(String(chunk).trim())));
    transport.stdin.write("probe\n");
    let detail = `connected: ${await echoed}`;
    if (mode === "chatty") {
      const flooded = new Promise<string>(resolve => transport.stdout.once("data", chunk => resolve(String(chunk).trim())));
      transport.stdin.write("flood\n");
      detail += `; ${await flooded}`;
      const sinkSize = () => fs.fstatSync(sink!).size;
      const afterConnected = sinkSize();
      transport.disconnect();
      fs.writeFileSync(`${marker}.flood`, "flood");
      while (!fs.existsSync(`${marker}.flooded`)) await Bun.sleep(10);
      // Let the drain settle on what it kept.
      await Bun.sleep(300);
      detail += `; sink ${afterConnected}/${sinkSize()}`;
    }
    process.stdout.write(JSON.stringify({ error: detail }));
  } finally {
    transport.disconnect();
    const stopped = new Promise<void>(resolve => peerProcess!.once("close", () => resolve()));
    transport.kill("SIGKILL");
    await stopped;
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ error: (error as Error).message }));
} finally {
  Date.now = clock;
  fs.closeSync(directory);
}
