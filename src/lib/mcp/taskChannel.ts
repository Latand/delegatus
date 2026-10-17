import net from "node:net";
import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import { peerCredentials } from "./nativePeer";

export const TASK_CHANNEL_HEADER = "x-delegatus-mcp-task-channel";
export const TASK_CHANNEL_REQUEST_HEADER = "x-delegatus-mcp-task-channel-request";
export const TASK_CHANNEL_TOOLS = new Set(["list_tasks", "get_task", "create_task", "update_task"]);
export const TASK_CHANNEL_CALLS = 64;
export const TASK_CHANNEL_INPUT_BYTES = 4 * 1024 * 1024;
export const TASK_CHANNEL_REPLY_BYTES = 128 * 1024 * 1024;
export const TASK_CHANNEL_METADATA_BYTES = 4096;
export type TaskChannel = { socketPath: string; identity: ProcessIdentity; nonce: string };
export type TaskChannelRequest = { nonce: string; capability: string; deadlineAt: number; bytes: number; headers: [string, string][] };
export type TaskChannelResponse = { status: number; headers: [string, string][]; body: string };

/** A delegation issued only after the Viewer's access and caller gates. The
 * connected kernel peer must match this exact worker before credentials leave
 * the adapter, including after an abstract address or PID has been reused. */
export function decodeTaskChannel(value: string | null): TaskChannel | null {
  if (process.platform !== "linux" || !value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const channel = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as TaskChannel;
    const identity = channel.identity;
    return typeof channel.socketPath === "string" && /^\0delegatus-mcp-tasks-[a-f0-9]{32}$/.test(channel.socketPath)
      && typeof channel.nonce === "string" && /^[A-Za-z0-9_-]{43}$/.test(channel.nonce)
      && identity && Number.isSafeInteger(identity.pid) && identity.pid > 0
      && typeof identity.startIdentity === "string" && identity.startIdentity.length > 0 && identity.startIdentity.length <= 256
      && typeof identity.bootEpoch === "string" && identity.bootEpoch.length > 0 && identity.bootEpoch.length <= 256
      ? channel : null;
  } catch { return null; }
}

export function encodeTaskChannel(channel: TaskChannel): string {
  return Buffer.from(JSON.stringify(channel)).toString("base64url");
}

/** One connection per call. The write that carries credentials follows the
 * kernel credential and start-identity checks on that same connected socket. */
export async function callTaskChannel(channel: TaskChannel, body: string, capability: string,
  headers: Headers, deadlineAt: number, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) throw new Error("task channel request was cancelled");
  const identity = { ...channel.identity };
  const bytes = Buffer.byteLength(body);
  const metadata: TaskChannelRequest = { nonce: channel.nonce, capability, deadlineAt, bytes,
    headers: [...headers].filter(([name]) => ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "user-agent"].includes(name)) };
  const header = JSON.stringify(metadata);
  if (Buffer.byteLength(header) > TASK_CHANNEL_METADATA_BYTES || bytes + Buffer.byteLength(header) + 2 > TASK_CHANNEL_INPUT_BYTES) throw new Error("task channel input exceeds its bound");
  return new Promise<Response>((resolve, reject) => {
    const socket = net.createConnection(channel.socketPath);
    const parts: Buffer[] = [];
    let received = 0, settled = false;
    const finish = (error?: Error, response?: Response) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", abort); socket.destroy();
      if (error) reject(error); else resolve(response!);
    };
    const abort = () => finish(new Error("task channel request was cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    socket.on("error", error => finish(error));
    socket.setTimeout(Math.max(1, Math.min(30_000, deadlineAt - Date.now())), abort);
    socket.once("connect", () => {
      if (settled) return;
      try {
        const peer = peerCredentials(socket);
        if (peer.uid !== process.getuid?.() || peer.pid !== identity.pid
          || processIdentityStatus(identity) !== "alive") throw new Error("task channel worker identity changed");
        socket.write(header + "\t" + body + "\n");
      } catch (error) { finish(error as Error); }
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > TASK_CHANNEL_REPLY_BYTES) { finish(new Error("task channel reply exceeds its bound")); return; }
      parts.push(chunk);
    });
    socket.once("end", () => {
      if (settled) return;
      try {
        const value = Buffer.concat(parts, received);
        const tab = value.indexOf(9);
        if (tab < 0 || tab > TASK_CHANNEL_METADATA_BYTES || value.at(-1) !== 10) throw new Error("task channel reply is incomplete");
        const reply = JSON.parse(value.subarray(0, tab).toString("utf8")) as { status: number; headers: [string, string][] };
        const payload = value.subarray(tab + 1, -1);
        if (payload.length > TASK_CHANNEL_REPLY_BYTES || !Number.isInteger(reply.status) || reply.status < 200 || reply.status > 599
          || !Array.isArray(reply.headers)) throw new Error("invalid task channel reply");
        finish(undefined, new Response(payload, { status: reply.status, headers: reply.headers }));
      } catch (error) { finish(error as Error); }
    });
    socket.once("close", () => { if (!settled) finish(new Error("task channel closed before its reply")); });
  });
}
