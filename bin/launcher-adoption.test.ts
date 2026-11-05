import net from "node:net";
import { afterEach, expect, spyOn, test } from "bun:test";
import { portFree } from "./launcher-adoption.mjs";
import { attemptAddressBind } from "./server-runtime.mjs";

const sockets = new Set<net.Socket>();
const servers = new Set<net.Server>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  servers.clear();
});

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
      // Force the startup race over a real socket: a proxy connects in the
      // interval between binding the probe and closing its listener.
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
    const outcome = await Promise.race([portFree(0), Bun.sleep(1000).then(() => "unresolved")]);
    expect(accepted).toBe(true);
    expect(outcome).toBe(true);
  } finally {
    interception.mockRestore();
  }
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
  const createServer = net.createServer;
  const interception = spyOn(net, "createServer").mockImplementation((...args: unknown[]) => {
    const server = Reflect.apply(createServer, net, args) as net.Server;
    servers.add(server);
    const close = server.close.bind(server);
    // Release the real socket, but lose its close completion, as a runtime
    // or a peer holding that completion would. Cleanup retains the real close.
    server.close = (() => { close(() => {}); return server; }) as typeof server.close;
    return server;
  });
  try {
    const probe = kind === "loopback" ? portFree(0) : attemptAddressBind("127.0.0.1", 0);
    const outcome = await Promise.race([probe.then(() => "accepted", (error: Error) => error.message), Bun.sleep(3000).then(() => "unresolved")]);
    expect(outcome).toBe("Launcher port probe timed out");
    for (const server of servers) expect(server.listening).toBe(false);
  } finally {
    interception.mockRestore();
    servers.clear(); // Every real listener was already closed by the interception.
  }
});
