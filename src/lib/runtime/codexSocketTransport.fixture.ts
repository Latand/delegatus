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
  if (mode === "exit" || mode === "large" || mode === "boundary") {
    if (mode === "large") fs.writeSync(2, "x".repeat(20000) + "\\n");
    if (mode === "boundary") fs.writeSync(2, "Bearer " + "private".repeat(3000));
    process.exit(23);
  }
  if (mode === "signal") process.kill(process.pid, "SIGTERM");
  if (mode === "success") {
    const server = Bun.serve({ unix: file,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response("fixture"); },
      websocket: { message(socket, message) { socket.send(message); } },
    });
    fs.chmodSync(file, 0o600);
  }
  if (mode === "ownership") {
    const server = Bun.serve({ unix: file, fetch() { return new Response("fixture"); } });
    fs.chmodSync(file, 0o777);
  }
  fs.writeFileSync(process.env.PEER_MARKER, "ready");
  if (mode === "wrapped") setInterval(() => {
    if (fs.existsSync(process.env.PEER_MARKER + ".release")) process.exit(23);
  }, 10);
  setInterval(() => {}, 1000);
`;
let peerProcess: ChildProcessWithoutNullStreams | undefined;
try {
  const transport = await CodexSocketTransport.launch(mode === "missing" ? path.join(root!, "missing-binary") : process.execPath, ["-e", peer], {
    detached: true, env: { ...process.env, PEER_MODE: mode, PEER_MARKER: marker },
  }, undefined, async (command, args, options, base) => {
    const diagnostic = path.join(root!, "wrapper.stderr");
    peerProcess = base(command, args, mode === "wrapped"
      ? { ...options, env: { ...options.env, NODE_ENV: options.env?.NODE_ENV ?? "test", LLV_SIGNAL_DIAGNOSTIC: diagnostic } } : options);
    if (mode === "wrapped") {
      while (!fs.existsSync(marker)) await Bun.sleep(10);
      fs.unlinkSync(diagnostic);
      return new Proxy(peerProcess, { get(target, key) {
        if (key === "exitCode") fs.writeFileSync(`${marker}.release`, "release");
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    return peerProcess;
  });
  try {
    if (fs.existsSync(path.join(path.dirname(transport.endpoint.slice("codex-unix:".length)), "startup.stderr"))) {
      throw new Error("startup diagnostic name survived successful connection");
    }
    const echoed = new Promise<string>(resolve => transport.stdout.once("data", chunk => resolve(String(chunk).trim())));
    transport.stdin.write("probe\n");
    process.stdout.write(JSON.stringify({ error: `connected: ${await echoed}` }));
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
