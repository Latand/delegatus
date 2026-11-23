import net from "node:net";
import { portFree } from "../launcher-adoption.mjs";
import { attemptAddressBind } from "../server-runtime.mjs";

const kind = process.argv[2];
const stall = process.argv[3] === "stall";
const originalCreateServer = net.createServer;
const listeners = [];
net.createServer = (...args) => {
  const server = Reflect.apply(originalCreateServer, net, args);
  const close = server.close.bind(server);
  server.close = (() => { close(() => {}); return server; });
  listeners.push(server);
  return server;
};

if (stall) {
  setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8_000), 25);
  await new Promise(() => {});
}

let detail;
try {
  if (kind === "loopback") await portFree(0);
  else await attemptAddressBind("127.0.0.1", 0);
  detail = "resolved";
} catch (error) {
  detail = error instanceof Error ? error.message : String(error);
}
const released = listeners.length === 1 && listeners[0].listening === false;
process.stdout.write(JSON.stringify({ detail, released }) + "\n");
