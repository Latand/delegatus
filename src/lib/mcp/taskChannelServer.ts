import crypto from "node:crypto";
import net from "node:net";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { peerCredentials } from "./nativePeer";
import { mcpHttpRefusal } from "./httpResponse";
import { TASK_CHANNEL_CALLS, TASK_CHANNEL_INPUT_BYTES, TASK_CHANNEL_METADATA_BYTES, TASK_CHANNEL_REPLY_BYTES,
  type TaskChannel, type TaskChannelRequest, type TaskChannelResponse } from "./taskChannel";

export type TaskChannelAdmission = { signal: AbortSignal; cancel(): void; close(): void };
type Ports = {
  identify(capability: string): string | null;
  admit(bytes: number, deadlineAt: number): TaskChannelAdmission | null;
  dispatch(body: unknown, capability: string, headers: [string, string][], signal: AbortSignal): Promise<TaskChannelResponse>;
  unavailable?(): void;
};

/** The worker owns its address and every accepted socket. The Viewer hands out
 * the descriptor through its authenticated HTTP boundary; adapters additionally
 * pin the connected kernel identity before sending either credential. */
export async function startTaskChannel(ports: Ports): Promise<{ channel: TaskChannel; close(): void } | null> {
  if (process.platform !== "linux") return null;
  const identity = captureProcessIdentity(process.pid);
  if (!identity.startIdentity || !identity.bootEpoch) return null;
  const channel: TaskChannel = { identity, socketPath: `\0delegatus-mcp-tasks-${crypto.randomBytes(16).toString("hex")}`,
    nonce: crypto.randomBytes(32).toString("base64url") };
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    let headerParts: Buffer[] = [], bodyParts: Buffer[] = [];
    let headerBytes = 0, bodyBytes = 0;
    let metadata: TaskChannelRequest | undefined;
    let admission: TaskChannelAdmission | null = null;
    let dispatched = false, finished = false;
    let deadline = setTimeout(() => socket.destroy(), 30_000);
    const closeInput = () => { headerParts = []; bodyParts = []; };
    const reply = async (response: Response | TaskChannelResponse) => {
      if (socket.destroyed) return;
      const body = response instanceof Response ? await response.text() : response.body;
      const header = JSON.stringify({ status: response.status, headers: [...response.headers] });
      if (Buffer.byteLength(header) > TASK_CHANNEL_METADATA_BYTES || Buffer.byteLength(body) + Buffer.byteLength(header) + 2 > TASK_CHANNEL_REPLY_BYTES
        || body.includes("\n") || body.includes("\t")) throw new Error("task channel response exceeds its wire bound");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { socket.removeListener("finish", sent); socket.removeListener("close", lost); };
        const sent = () => { cleanup(); resolve(); };
        const lost = () => { cleanup(); reject(new Error("task channel closed during its reply")); };
        socket.once("finish", sent); socket.once("close", lost);
        socket.end(header + "\t" + body + "\n");
      });
    };
    const refuse = (status: number, message: string) => {
      finished = true; socket.pause(); closeInput();
      admission?.cancel(); if (!dispatched) admission?.close();
      void reply(mcpHttpRefusal(status, -32002, message)).catch(() => socket.destroy());
    };
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(deadline); sockets.delete(socket); closeInput();
      admission?.cancel(); if (!dispatched) admission?.close();
    });
    socket.on("data", (input: Buffer) => {
      if (finished) return;
      try {
        let chunk = input;
        if (!metadata) {
          const tab = chunk.indexOf(9), part = tab < 0 ? chunk : chunk.subarray(0, tab);
          headerBytes += part.length;
          if (headerBytes > TASK_CHANNEL_METADATA_BYTES) { refuse(400, "Invalid task channel metadata."); return; }
          headerParts.push(part);
          if (tab < 0) return;
          const candidate = JSON.parse(Buffer.concat(headerParts, headerBytes).toString("utf8")) as TaskChannelRequest;
          headerParts = [];
          if (typeof candidate.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(candidate.nonce)
            || !crypto.timingSafeEqual(Buffer.from(candidate.nonce), Buffer.from(channel.nonce))
            || peerCredentials(socket).uid !== process.getuid?.()) { refuse(403, "Task channel admission was refused."); return; }
          if (typeof candidate.capability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(candidate.capability)
            || !ports.identify(candidate.capability)) { refuse(403, "This launch capability names no current agent."); return; }
          if (!Number.isSafeInteger(candidate.bytes) || candidate.bytes < 1 || candidate.bytes + headerBytes + 2 > TASK_CHANNEL_INPUT_BYTES
            || !Number.isFinite(candidate.deadlineAt) || candidate.deadlineAt <= Date.now()
            || !Array.isArray(candidate.headers) || candidate.headers.length > 8
            || candidate.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string"))) {
            refuse(400, "Invalid task channel request."); return;
          }
          admission = ports.admit(candidate.bytes + headerBytes + 2, Math.min(candidate.deadlineAt, Date.now() + 30_000));
          if (!admission) { refuse(503, "Task executor admission is full; retry the original request key."); return; }
          clearTimeout(deadline);
          deadline = setTimeout(() => socket.destroy(), Math.max(1, Math.min(30_000, candidate.deadlineAt - Date.now())));
          metadata = candidate;
          chunk = chunk.subarray(tab + 1);
        }
        bodyBytes += chunk.length;
        if (bodyBytes > metadata.bytes + 1) { refuse(400, "Invalid task channel body length."); return; }
        bodyParts.push(chunk);
        if (bodyBytes < metadata.bytes + 1) return;
        const body = Buffer.concat(bodyParts, bodyBytes);
        if (body.at(-1) !== 10) { refuse(400, "Invalid task channel body delimiter."); return; }
        const parsed: unknown = JSON.parse(body.subarray(0, -1).toString("utf8"));
        finished = true; dispatched = true; socket.pause(); closeInput();
        void ports.dispatch(parsed, metadata.capability, metadata.headers, admission!.signal)
          .then(reply)
          .catch(() => reply(mcpHttpRefusal(503, -32002, "Task executor call failed; look up the original request key.")))
          .catch(() => socket.destroy())
          .finally(() => admission!.close());
      } catch { refuse(400, "The task channel request could not be read."); }
    });
  });
  // Leave bounded room to refuse new connections while admitted replies drain.
  server.maxConnections = 2 * TASK_CHANNEL_CALLS;
  const close = () => { for (const socket of sockets) socket.destroy(); try { server.close(); } catch { /* Listener setup did not finish. */ } };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(channel.socketPath, () => { server.removeListener("error", reject); resolve(); });
    });
    server.on("error", () => { close(); ports.unavailable?.(); });
    return { channel, close };
  } catch { close(); return null; }
}
