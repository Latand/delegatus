import crypto from "node:crypto";
import net from "node:net";
import { createRequire } from "node:module";
import { captureProcessIdentity, processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";

export const NATIVE_PEER_HEADER = "x-delegatus-mcp-peer";
const PREFIX = "delegatus-mcp-peer-";
const digest = (body: string) => crypto.createHash("sha256").update(body).digest("hex");

/** A per-call reverse challenge. The Viewer reads SO_PEERCRED from its own
 * connected socket; no request field can assert a PID or conversation. The
 * nonce and body digest prevent another HTTP caller borrowing this listener.
 * Native hook proof and operator approval are still checked by the service. */
export async function nativePeerProof(body: string): Promise<{ header: string; close(): void }> {
  // The host and Viewer share the network/PID namespaces, while their /tmp
  // mounts differ. An abstract socket also disappears on hard process death.
  const socketPath = `\0${PREFIX}${crypto.randomBytes(16).toString("hex")}`;
  const nonce = crypto.randomBytes(32).toString("base64url");
  const expected = JSON.stringify({ nonce, digest: digest(body) });
  const peers = new Set<net.Socket>();
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.on("close", () => peers.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(1_000, () => socket.destroy());
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      if (input.length > 512) { socket.destroy(); return; }
      if (!input.endsWith("\n")) return;
      socket.end(input.slice(0, -1) === expected ? `${nonce}\n` : "refused\n");
    });
  });
  server.maxConnections = 8;
  const close = () => {
    for (const peer of peers) peer.destroy();
    server.close();
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    return { header: Buffer.from(JSON.stringify({ socketPath, nonce })).toString("base64url"), close };
  } catch (error) { close(); throw error; }
}

let credentials: ((fd: number) => { pid: number; uid: number }) | undefined;
export function peerCredentials(socket: net.Socket): { pid: number; uid: number } {
  if (!credentials) {
    const ffi = createRequire(import.meta.url)(`bun:${"ffi"}`);
    const libc = ffi.dlopen("libc.so.6", {
      getsockopt: { args: [ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.i32, ffi.FFIType.ptr, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    });
    credentials = fd => {
      const value = Buffer.alloc(12), length = Buffer.alloc(4);
      length.writeUInt32LE(12);
      if (libc.symbols.getsockopt(fd, 1, 17, ffi.ptr(value), ffi.ptr(length)) !== 0 || length.readUInt32LE() !== 12) throw new Error("native peer credentials unavailable");
      return { pid: value.readInt32LE(0), uid: value.readUInt32LE(4) };
    };
  }
  const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== "number") throw new Error("native peer descriptor unavailable");
  return credentials(fd);
}

export async function verifyNativePeer(header: string, body: string): Promise<ProcessIdentity> {
  if (process.platform !== "linux" || header.length > 2048) throw new Error("native peer unavailable");
  const proof = JSON.parse(Buffer.from(header, "base64url").toString()) as { socketPath: string; nonce: string };
  if (typeof proof.socketPath !== "string" || !/^\0delegatus-mcp-peer-[a-f0-9]{32}$/.test(proof.socketPath)
    || !/^[A-Za-z0-9_-]{43}$/.test(proof.nonce)) throw new Error("invalid native peer proof");
  return new Promise<ProcessIdentity>((resolve, reject) => {
    const socket = net.createConnection(proof.socketPath);
    let pinned: ProcessIdentity | undefined;
    let response = "";
    const refuse = (error: Error) => { socket.destroy(); reject(error); };
    socket.on("error", refuse);
    socket.setTimeout(1_000, () => refuse(new Error("native peer timed out")));
    socket.once("connect", () => {
      try {
        const peer = peerCredentials(socket);
        if (peer.uid !== process.getuid?.()) throw new Error("native peer belongs to another user");
        pinned = captureProcessIdentity(peer.pid);
        if (processIdentityStatus(pinned) !== "alive") throw new Error("native peer identity unavailable");
        socket.write(`${JSON.stringify({ nonce: proof.nonce, digest: digest(body) })}\n`);
      } catch (error) { refuse(error as Error); }
    });
    socket.on("data", chunk => {
      response += chunk.toString();
      if (response.length > 128) refuse(new Error("invalid native peer response"));
    });
    socket.once("end", () => {
      if (!pinned || response !== `${proof.nonce}\n` || processIdentityStatus(pinned) !== "alive") refuse(new Error("native peer proof refused"));
      else { socket.destroy(); resolve(pinned); }
    });
  });
}
