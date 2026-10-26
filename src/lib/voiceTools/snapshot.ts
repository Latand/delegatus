import { boundedDescription, toolName, type VoiceToolServer } from "./contracts";

/**
 * What one voice call may use from the added servers, fixed at its start (design §3.4).
 * It is built from the hub's in-memory registry: no file is read and no server is contacted.
 * It carries no secret value; the call records only server names and catalog digests.
 */
export interface VoiceToolSnapshot {
  revision: number;
  servers: VoiceToolSnapshotServer[];
}
export interface VoiceToolSnapshotServer {
  name: string; title: string; capability: string; transport: "stdio" | "http";
  private: boolean; askBeforeActing: boolean; callTimeoutMs: number;
  approvalDigest: string; catalogDigest: string;
  tools: VoiceToolSnapshotTool[];
}
export interface VoiceToolSnapshotTool {
  /** `<server>__<tool>`, the name the backend calls. */
  wire: string;
  /** The tool's own name on its server. */
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  acts: boolean;
}
export const EMPTY_VOICE_TOOLS: VoiceToolSnapshot = Object.freeze({ revision: 0, servers: [] }) as VoiceToolSnapshot;

/** A server serves a call while its approval stands: enabled, or changed since approval (§3.7). */
export function servingServer(server: VoiceToolServer): boolean {
  return (server.state === "enabled" || server.state === "changed") && !!server.approval && !!server.catalog;
}
export function snapshotServer(name: string, server: VoiceToolServer): VoiceToolSnapshotServer | null {
  if (!servingServer(server)) return null;
  const tools = server.catalog!.tools.filter(tool => server.tools[tool.name]?.enabled).map(tool => ({
    wire: toolName(name, tool.name), tool: tool.name, description: tool.description, inputSchema: tool.inputSchema, acts: server.tools[tool.name].acts,
  }));
  if (!tools.length) return null;
  return { name, title: server.title, capability: server.capability, transport: server.transport.type, private: server.private,
    askBeforeActing: server.askBeforeActing, callTimeoutMs: server.callTimeoutMs, approvalDigest: server.approval!.digest, catalogDigest: server.catalog!.digest, tools };
}
export function findSnapshotTool(snapshot: VoiceToolSnapshot, wire: string): { server: VoiceToolSnapshotServer; tool: VoiceToolSnapshotTool } | null {
  for (const server of snapshot.servers) {
    const tool = server.tools.find(candidate => candidate.wire === wire);
    if (tool) return { server, tool };
  }
  return null;
}
/** A Codex request names a server's namespace and the function inside it. */
export function codexSnapshotTool(snapshot: VoiceToolSnapshot, namespace: unknown, tool: string): string | null {
  if (typeof namespace === "string") {
    const server = snapshot.servers.find(row => row.name === namespace);
    return server?.tools.find(row => localName(server.name, row.wire) === tool)?.wire ?? null;
  }
  return findSnapshotTool(snapshot, tool)?.tool.wire ?? null;
}
const localName = (server: string, wire: string) => wire.slice(server.length + 2);
const describe = (server: VoiceToolSnapshotServer, tool: VoiceToolSnapshotTool) => boundedDescription(`${server.title}: ${tool.description || tool.tool}`);

/** Extra Responses function tools. Third-party schemas are sent non-strict and validated by the hub (§2.1). */
export function snapshotBackendTools(snapshot: VoiceToolSnapshot) {
  return snapshot.servers.flatMap(server => server.tools.map(tool =>
    ({ type: "function" as const, name: tool.wire, description: describe(server, tool), strict: false, parameters: tool.inputSchema })));
}
/** One Codex `namespace` per server holding its selected functions (`DynamicToolSpec`). */
export function snapshotCodexTools(snapshot: VoiceToolSnapshot) {
  return snapshot.servers.map(server => ({ type: "namespace" as const, name: server.name, description: boundedDescription(`${server.title}: ${server.capability}`),
    tools: server.tools.map(tool => ({ type: "function" as const, name: localName(server.name, tool.wire), description: describe(server, tool), inputSchema: tool.inputSchema })) }));
}
/** One "Backend tools:" line per server; both prompts are generated, so a new server needs no prompt edit. */
export function snapshotCapabilityLines(snapshot: VoiceToolSnapshot): string[] {
  return snapshot.servers.map(server => `- ${server.title}: ${server.capability}`);
}
/** What a call records about its snapshot: names and digests, never a secret. */
export function snapshotRecord(snapshot: VoiceToolSnapshot) {
  return { revision: snapshot.revision, servers: snapshot.servers.map(server => ({ name: server.name, catalog: server.catalogDigest, tools: server.tools.map(tool => tool.wire) })) };
}

/** The voice's view of the hub: what a call takes at start and how it reaches a tool. */
export interface VoiceToolCalls {
  snapshot(starter: { memberId: string } | { operator: true } | undefined): VoiceToolSnapshot;
  /** The referenced secret values of the snapshot's servers; they join the call's masking list only. */
  secrets(snapshot: VoiceToolSnapshot): string[];
  /** The call has started: stdio servers warm in the background. */
  open(callId: string, snapshot: VoiceToolSnapshot): void;
  /** The call has ended: its servers stop 60 s after the last open call. */
  close(callId: string): void;
  call(callId: string, snapshot: VoiceToolSnapshot, wire: string, args: unknown, signal?: AbortSignal): Promise<VoiceToolOutcome>;
}
export type VoiceToolOutcomeCode = "TOOL_NOT_ALLOWED" | "TOOL_REVOKED" | "TOOL_REMOVED" | "INVALID_TOOL_ARGUMENTS" | "TOOL_SERVER_UNAVAILABLE" | "TOOL_TIMEOUT" | "TOOL_ERROR";
export interface VoiceToolOutcome {
  status: "done" | "failed";
  code?: VoiceToolOutcomeCode;
  /** The server's answer as text, cut to 16 KB with a marker. Untrusted data. */
  content?: string;
  omitted?: string[];
  images?: Array<{ mime: string; data: string }>;
  speech: string;
}
