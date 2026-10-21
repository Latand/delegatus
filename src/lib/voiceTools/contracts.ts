import { createHash } from "node:crypto";
import { z } from "zod";

export const voiceToolBounds = { servers: 64, enabledServers: 16, tools: 128, selectedTools: 32,
  schemaBytes: 8192, schemaDepth: 10, descriptionBytes: 1024, selectionBytes: 48 * 1024,
  wireBytes: 2 * 1024 * 1024, secretBytes: 2 * 1024 * 1024, registryBytes: 8 * 1024 * 1024, deadlineMs: 20_000, children: 8 } as const;
const text = (max: number) => z.string().min(1).max(max).refine(value => !value.includes("\0"));
export const serverName = z.string().regex(/^[a-z][a-z0-9_]{1,23}$/);
const reference = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const value = z.union([z.object({ value: z.string().max(4096).refine(v => !v.includes("\0")) }).strict(), z.object({ secretRef: reference }).strict()]);
const variables = (pattern: RegExp) => z.record(z.string().regex(pattern), value).refine(v => Object.keys(v).length <= 64)
  .refine(v => Object.entries(v).every(([name, entry]) => !/key|token|secret|password|authorization|cookie/i.test(name) || "secretRef" in entry));
export function allowedHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return !url.username && !url.password && !url.hash && ![...url.searchParams.keys()].some(name => /key|token|secret|password|auth|cookie/i.test(name)) &&
      (url.protocol === "https:" || url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)));
  } catch { return false; }
}
/**
 * Variables that choose which binary, loader, interpreter, package, registry or config file a stdio
 * launch uses. The settings card shows variable names only, so a value under one of these could
 * swap what runs while the card still reads the same command; a proposal naming one is refused.
 * NODE_ENV only tells the server how to behave, so a proposal may still set it.
 */
export const launchShapingEnv = /^(?:PATH|PATHEXT|HOME|SHELL|COMSPEC|SYSTEMROOT|WINDIR|TMPDIR|TEMP|TMP|LD_\w*|DYLD_\w*|NODE_(?!ENV$)\w*|BUN_\w*|BUNFIG\w*|UV_\w*|NPM_CONFIG_\w*|YARN_\w*|PIP_\w*|PYTHON\w*|VIRTUAL_ENV|CONDA_\w*|XDG_\w*|GIT_\w*|GLIBC_TUNABLES|MALLOC_\w*|SSL_CERT_\w*|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|(?:HTTPS?|ALL|NO)_PROXY)$/i;
export const transportSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stdio"), command: z.enum(["bun", "uv"]), args: z.array(z.string().max(4096).refine(v => !v.includes("\0"))).max(64),
    cwd: text(4096).nullable().default(null),
    env: variables(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).refine(v => Object.keys(v).every(name => !launchShapingEnv.test(name))).default({}) }).strict(),
  z.object({ type: z.literal("http"), url: text(4096).refine(allowedHttpUrl), headers: variables(/^[A-Za-z][A-Za-z0-9-]{0,127}$/).default({}) }).strict(),
]);
export const proposalSchema = z.object({
  name: serverName, title: text(120), capability: text(160), transport: transportSchema,
  entryFile: z.object({ path: text(4096), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().nullable().default(null),
  private: z.boolean().default(false), askBeforeActing: z.boolean().default(false),
  callTimeoutMs: z.number().int().min(5000).max(60_000).default(15_000),
}).strict();
export type VoiceToolProposal = z.infer<typeof proposalSchema>;
export type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> };
export type Catalog = { digest: string; fetchedAt: string; tools: Tool[] };
export type ProbeCode = "OK" | "START_FAILED" | "PROTOCOL_ERROR" | "TIMEOUT" | "CATALOG_BOUNDS" | "SECRET_ECHO" | "MISSING_SECRET" | "ENTRY_CHANGED" | "BUSY" | "CANCELLED";
export type ProbeResult = { code: ProbeCode; catalog?: Catalog };
export type VoiceToolServer = Omit<VoiceToolProposal, "name"> & {
  generation: number;
  owner: "installation"; audience: ["voice"]; state: "pending" | "enabled" | "disabled" | "rejected" | "changed";
  proposedBy: { kind: "conversation" | "operator"; conversationId: string | null; at: string };
  approval: { by: "operator"; at: string; digest: string } | null;
  tools: Record<string, { enabled: boolean; acts: boolean }>;
  catalog: Catalog | null; lastDryRun: { code: ProbeCode; at: string; digest: string } | null;
};
export type VoiceToolsRegistry = { version: 1; revision: number; servers: Record<string, VoiceToolServer> };
export type VoiceToolsView = { version: 1; revision: number; servers: Record<string, Omit<VoiceToolServer, "transport"> & {
  transport: { type: "stdio"; command: "bun" | "uv"; args: string[]; cwd: string | null; envNames: string[] }
    | { type: "http"; url: string; headerNames: string[] };
  digest: string; missingSecrets: string[]; secretRefs: string[];
}> };
export const emptyRegistry = (): VoiceToolsRegistry => ({ version: 1, revision: 0, servers: {} });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
export function approvalDigest(name: string, server: VoiceToolServer): string {
  return digest({ name, generation: server.generation, title: server.title, capability: server.capability, transport: server.transport, entryFile: server.entryFile,
    owner: server.owner, audience: server.audience, private: server.private, askBeforeActing: server.askBeforeActing,
    callTimeoutMs: server.callTimeoutMs, tools: server.tools, catalog: server.catalog?.digest ?? null });
}
export function probeDigest(name: string, server: VoiceToolServer): string {
  return digest({ name, transport: server.transport, entryFile: server.entryFile });
}
export function secretReferences(server: VoiceToolServer): string[] {
  const entries = server.transport.type === "stdio" ? server.transport.env : server.transport.headers;
  return [...new Set(Object.values(entries).flatMap(v => "secretRef" in v ? [v.secretRef] : []))].sort();
}
export function toolName(server: string, tool: string): string {
  const full = `${server}__${tool}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return full.length <= 64 ? full : `${full.slice(0, 57)}_${digest(full).slice(-6)}`;
}
export function boundedDescription(input: string): string {
  let result = "";
  for (const char of input) { if (Buffer.byteLength(result + char) > voiceToolBounds.descriptionBytes) break; result += char; }
  return result;
}
/** Validate in the probe process; compiling an untrusted schema stays off the Viewer loop. */
export function validateCatalog(name: string, input: unknown, compile?: (schema: Record<string, unknown>) => void): Tool[] {
  if (!Array.isArray(input) || input.length > voiceToolBounds.tools) throw new Error("CATALOG_BOUNDS");
  const names = new Set<string>();
  return input.map(raw => {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(raw.name)) throw new Error("CATALOG_BOUNDS");
    const normalized = toolName(name, raw.name);
    if (names.has(normalized)) throw new Error("CATALOG_BOUNDS");
    names.add(normalized);
    const schema = raw.inputSchema;
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || schema.type !== "object" || Buffer.byteLength(JSON.stringify(schema)) > voiceToolBounds.schemaBytes) throw new Error("CATALOG_BOUNDS");
    const check = (v: unknown, level: number): void => {
      if (!v || typeof v !== "object") return;
      if (level > voiceToolBounds.schemaDepth) throw new Error("CATALOG_BOUNDS");
      for (const child of Object.values(v)) check(child, level + 1);
    };
    check(schema, 1);
    try { compile?.(schema); } catch { throw new Error("CATALOG_BOUNDS"); }
    return { name: raw.name, description: boundedDescription(typeof raw.description === "string" ? raw.description : ""), inputSchema: schema,
      ...(raw.annotations && typeof raw.annotations === "object" && !Array.isArray(raw.annotations) ? { annotations: {
        ...(typeof raw.annotations.readOnlyHint === "boolean" ? { readOnlyHint: raw.annotations.readOnlyHint } : {}),
        ...(typeof raw.annotations.destructiveHint === "boolean" ? { destructiveHint: raw.annotations.destructiveHint } : {}),
        ...(typeof raw.annotations.idempotentHint === "boolean" ? { idempotentHint: raw.annotations.idempotentHint } : {}),
        ...(typeof raw.annotations.openWorldHint === "boolean" ? { openWorldHint: raw.annotations.openWorldHint } : {}),
        ...(typeof raw.annotations.title === "string" ? { title: boundedDescription(raw.annotations.title) } : {}),
      } } : {}) };
  });
}
export const selectionSchema = z.record(z.string().max(128), z.object({ enabled: z.boolean(), acts: z.boolean() }).strict());
export const secretsSchema = z.record(reference, z.string().min(1).max(8192)).refine(v => Object.keys(v).length <= 256)
  .refine(v => Buffer.byteLength(JSON.stringify(v)) <= voiceToolBounds.secretBytes);
