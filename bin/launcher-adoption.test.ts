import { spawn } from "node:child_process";
import net from "node:net";
import { afterEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { portFree } from "./launcher-adoption.mjs";

const sockets = new Set<net.Socket>();
const servers = new Set<net.Server>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  servers.clear();
});

const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL"); await exited;
  }
});

async function runProbe(kind: string, mode = "normal") {
  const child = spawn(process.execPath, ["--bun", path.resolve("bin/__fixtures__/launcher-probe-deadline-child.mjs"), kind, mode],
    { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout!.on("data", bytes => { stdout += String(bytes); });
  child.stderr!.on("data", bytes => { stderr += String(bytes); });
  let timedOut = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  let watchdog: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    exited.then(exit => ({ kind: "exit" as const, exit })),
    new Promise<{ kind: "watchdog" }>(resolve => { watchdog = setTimeout(() => {
      timedOut = true; child.kill("SIGKILL"); resolve({ kind: "watchdog" });
    }, 3500); }),
  ]);
  let exit;
  if (result.kind === "watchdog") exit = await exited;
  else { clearTimeout(watchdog!); exit = result.exit; }
  return { exit, stdout, stderr, timedOut };
}

test("the port probe closes a connection accepted before its listener closes", async () => {
  const createServer = net.createServer;
  let accepted = false;
  const interception = spyOn(net, "createServer").mockImplementation((options?: net.ServerOpts | ((socket: net.Socket) => void), listener?: (socket: net.Socket) => void) => {
    const server = typeof options === "function" ? createServer(options) : createServer(options, listener);
    servers.add(server);
    const emit = server.emit.bind(server);
    server.emit = ((event: string, ...args: unknown[]) => {
      if (event !== "listening") return emit(event, ...args);
      const address = server.address() as net.AddressInfo;
      // Connect during the real bind/close race before the probe drops its listener.
      server.once("connection", socket => {
        accepted = true;
        sockets.add(socket);
        emit("listening");
      });
      const client = net.createConnection({ host: "127.0.0.1", port: address.port });
      client.on("error", () => {});
      sockets.add(client);
      return true;
    }) as typeof server.emit;
    return server;
  });
  try {
    expect(await portFree(0)).toBe(true);
    expect(accepted).toBe(true);
  } finally { interception.mockRestore(); }
});

test("a free port is released for the real server", async () => {
  expect(await portFree(0)).toBe(true);
});

test("an occupied port is refused without disturbing its listener", async () => {
  const server = net.createServer();
  servers.add(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  expect(await portFree(port)).toBe(false);
  expect(server.listening).toBe(true);
});

test.each(["loopback", "address"])("a stuck %s probe close has a deadline and releases its listener", async kind => {
  const result = await runProbe(kind);
  if (result.exit.code !== 0) throw new Error(`Probe child failed: ${result.stderr}`);
  expect(result.exit).toEqual({ code: 0, signal: null });
  expect(JSON.parse(result.stdout)).toEqual({ detail: "Launcher port probe timed out", released: true });
});

test("a stalled probe process is killed and reaped by the parent watchdog", async () => {
  const result = await runProbe("loopback", "stall");
  expect(result.exit).toEqual({ code: null, signal: "SIGKILL" });
  expect(result.timedOut).toBe(true);
});
