import net from "node:net";
import { afterEach, expect, spyOn, test } from "bun:test";
import { portFree } from "./launcher-adoption.mjs";

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
  const interception = spyOn(net, "createServer").mockImplementation((...args: Parameters<typeof net.createServer>) => {
    const server = createServer(...args);
    servers.add(server);
    const listen = server.listen.bind(server);
    server.listen = ((port: number, host: string, ready: () => void) => listen(port, host, () => {
      const address = server.address() as net.AddressInfo;
      // Force the startup race over a real socket: a proxy connects in the
      // interval between binding the probe and closing its listener.
      server.once("connection", socket => {
        accepted = true;
        sockets.add(socket);
        ready();
      });
      const client = net.createConnection({ host, port: address.port });
      client.on("error", () => {});
      sockets.add(client);
    })) as typeof server.listen;
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
