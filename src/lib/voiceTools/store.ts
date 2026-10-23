import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { COMPANION_TOOL_REGISTRY } from "@/lib/voiceCompanion/tools";
import { commitSeals, seal, validSeal } from "./seal";
import { servingServer, snapshotServer, type VoiceToolSnapshot } from "./snapshot";
import { verifyEntry } from "./entry";
import { approvalDigest, digest, emptyRegistry, literalValues, packageLaunch, probeDigest, proposalSchema, secretsSchema, secretReferences, secretDestination,
  assertSecretDestinations, secretReferenceSchema, secretDestinationSchema, type SecretPolicies, selectionSchema, toolName, validateCatalog, voiceToolBounds, type ProbeResult, type Tool, type VoiceToolServer, type VoiceToolsRegistry, type VoiceToolsView } from "./contracts";

export class VoiceToolsError extends Error {
  constructor(public code: string) { super(code); }
}
const fail = (code: string): never => { throw new VoiceToolsError(code); };
const hasSecret = (secrets: Record<string, string>, ref: string) => Object.hasOwn(secrets, ref) && !!secrets[ref];
const legacySecretsSchema = z.record(secretReferenceSchema, z.string().min(1).max(8192)).refine(v => Object.keys(v).length <= 256);
const persistedSecretsSchema = z.record(secretReferenceSchema, z.object({ value: z.string().min(1).max(8192), destinations: z.array(secretDestinationSchema).max(32), mac: z.string().optional() }).strict())
  .refine(v => Object.keys(v).length <= 256);
function validProposal(input: unknown, defaultCwd: string) {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) return null;
  const config = parsed.data;
  if (COMPANION_TOOL_REGISTRY.some(tool => tool.name === config.name)) return null;
  if (config.entryFile && !path.isAbsolute(config.entryFile.path)) return null;
  if (config.transport.type === "stdio" && config.transport.cwd && !path.isAbsolute(config.transport.cwd)) return null;
  if (config.transport.type === "stdio" && config.entryFile) {
    const transport = config.transport;
    const cwd = transport.cwd ?? defaultCwd;
    if (transport.command === "bun") {
      const scriptIndex = transport.args[0] === "run" ? 1 : 0;
      const entry = transport.args[scriptIndex];
      if (!entry || entry.startsWith("-") || path.resolve(cwd, entry) !== config.entryFile.path) return null;
      // Canonicalize pinned launches to explicit file dispatch, avoiding Bun
      // command and package-script resolution for names such as `exec` or `server`.
      transport.args = ["run", config.entryFile.path, ...transport.args.slice(scriptIndex + 1)];
    } else {
      const entry = transport.args[0] === "run" && transport.args[1] && !transport.args[1].startsWith("-") ? transport.args[1] : undefined;
      if (!entry || path.resolve(cwd, entry) !== config.entryFile.path) return null;
    }
  } else if (config.transport.type === "stdio") {
    // Package launchers are explicit; local scripts always carry an entry pin. A launcher
    // prefers a binary under node_modules/.bin of its folder and every parent, so a package
    // launch runs from a fresh empty folder (hub.ts) and a proposed folder is refused.
    if (!packageLaunch(config.transport) || config.transport.cwd) return null;
  }
  return config;
}
async function readJson(file: string, limit: number): Promise<unknown | null> {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; return fail("REGISTRY_UNAVAILABLE"); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > limit) return fail("REGISTRY_UNAVAILABLE");
    const buffer = Buffer.alloc(limit + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > limit) return fail("REGISTRY_UNAVAILABLE");
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } catch { return fail("REGISTRY_UNAVAILABLE"); }
  finally { await handle.close(); }
}
async function atomicJson(file: string, value: unknown, authorize?: () => void): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    authorize?.(); await fs.rename(temp, file);
  }
  finally { await fs.rm(temp, { force: true }); }
}
function assertNoSecrets(value: unknown, secrets: Record<string, string>): void {
  const serialized = JSON.stringify(value);
  if (Object.values(secrets).some(secret => secret.length >= 8 && (serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1))))) fail("SECRET_ECHO");
}
async function validatePersistedCatalogs(catalogs: { name: string; tools: Tool[] }[]): Promise<void> {
  const pending = catalogs.map(catalog => ({ ...catalog, cacheKey: `${catalog.name}:${digest(catalog.tools)}` }))
    .filter(catalog => !validatedSchemaDigests.has(catalog.cacheKey));
  if (!pending.length) return;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    try {
      const loaded = require('ajv');
      const Ajv = loaded.default || loaded;
      const ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false });
      for (const group of workerData) for (const schema of group.schemas) { ajv.removeSchema(); ajv.compile(schema); }
      parentPort.postMessage(true);
    } catch { parentPort.postMessage(false); }
  `, { eval: true, workerData: pending.map(catalog => ({ schemas: catalog.tools.map(tool => tool.inputSchema) })) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const valid = await new Promise<boolean>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      timer = setTimeout(() => reject(new Error("CATALOG_BOUNDS")), 2_000);
    });
    if (!valid) return fail("REGISTRY_UNAVAILABLE");
    for (const catalog of pending) validatedSchemaDigests.set(catalog.cacheKey, true);
    while (validatedSchemaDigests.size > 128) validatedSchemaDigests.delete(validatedSchemaDigests.keys().next().value!);
  } catch { return fail("REGISTRY_UNAVAILABLE"); }
  finally { if (timer) clearTimeout(timer); await worker.terminate(); }
}
const validatedSchemaDigests = new Map<string, true>();
function approvalSealInput(name: string, server: VoiceToolServer, approval: NonNullable<VoiceToolServer["approval"]>, policies: SecretPolicies) {
  return { name, at: approval.at, digest: approval.digest, policies: Object.fromEntries(secretReferences(server).map(ref => [ref, policies[ref] ?? []])) };
}
async function parseRegistry(input: unknown, directory: string, policies: SecretPolicies): Promise<VoiceToolsRegistry> {
  if (input === null) return emptyRegistry();
  const registry = input as VoiceToolsRegistry;
  if (registry.version !== 1 || !Number.isSafeInteger(registry.revision) || registry.revision < 0 || !registry.servers || Array.isArray(registry.servers)
    || typeof registry.servers !== "object" || Object.keys(registry.servers).length > voiceToolBounds.servers
    || Object.keys(registry).some(key => !["version", "revision", "servers"].includes(key))) return fail("REGISTRY_UNAVAILABLE");
  const catalogsToCompile: { name: string; tools: Tool[] }[] = [];
  for (const [name, raw] of Object.entries(registry.servers)) {
    const { generation, owner, audience, state, proposedBy, approval, tools, catalog, lastDryRun, ...config } = raw;
    const proposal = validProposal({ name, ...config }, path.join(directory, "voice-tools-data", name));
    if (!proposal || Object.hasOwn(config, "name") || !Number.isSafeInteger(generation) || generation < 1 || owner !== "installation" || JSON.stringify(audience) !== '["voice"]' || !["pending", "enabled", "disabled", "rejected", "changed"].includes(state)
      || !proposedBy || !["operator", "conversation"].includes(proposedBy.kind) || typeof proposedBy.at !== "string"
      || !(proposedBy.conversationId === null || typeof proposedBy.conversationId === "string")
      || !selectionSchema.safeParse(tools).success
      || approval !== null && (!approval || approval.by !== "operator" || typeof approval.at !== "string" || typeof approval.digest !== "string")
      || lastDryRun !== null && (!lastDryRun || typeof lastDryRun.at !== "string" || typeof lastDryRun.digest !== "string" || !probeCodes.has(lastDryRun.code))) return fail("REGISTRY_UNAVAILABLE");
    const { name: parsedName, ...defaults } = proposal;
    if (parsedName !== name) return fail("REGISTRY_UNAVAILABLE");
    Object.assign(raw, defaults);
    if (catalog !== null) {
      if (!catalog || typeof catalog !== "object") return fail("REGISTRY_UNAVAILABLE");
      const validated = validateCatalog(name, catalog.tools);
      if (catalog.digest !== digest(validated) || typeof catalog.fetchedAt !== "string" || JSON.stringify(validated) !== JSON.stringify(catalog.tools)) return fail("REGISTRY_UNAVAILABLE");
      catalogsToCompile.push({ name, tools: validated });
    }
    if (Object.keys(tools).length > voiceToolBounds.tools || Object.keys(tools).some(tool => !catalog?.tools.some(t => t.name === tool))) return fail("REGISTRY_UNAVAILABLE");
    if (approval && (approval.digest !== approvalDigest(name, raw) || !validSeal(path.join(directory, "approval"), approvalSealInput(name, raw, approval, policies), approval.mac)) || state === "enabled" && !approval) {
      raw.state = "pending"; raw.approval = null;
    }
  }
  await validatePersistedCatalogs(catalogsToCompile);
  return registry;
}
const NO_CHANGE = Symbol("no registry change");
const probeCodes = new Set(["OK", "START_FAILED", "PROTOCOL_ERROR", "TIMEOUT", "CATALOG_BOUNDS", "SECRET_ECHO", "MISSING_SECRET", "SECRET_DESTINATION", "ENTRY_CHANGED", "BUSY", "CANCELLED"]);

/** One Viewer owner. Every mutation re-reads under the async cross-process lock. */
export class VoiceToolsStore {
  private registry = emptyRegistry();
  private secrets: Record<string, string> = {};
  private policies: SecretPolicies = {};
  private loaded?: Promise<void>;
  readonly file: string;
  private readonly secretsFile: string;
  constructor(readonly directory: string, private now: () => string = () => new Date().toISOString()) {
    this.file = path.join(directory, "voice-tools.json"); this.secretsFile = path.join(directory, "voice-tools-secrets.json");
  }
  async load(): Promise<void> {
    if (!this.loaded) this.loaded = this.reload().catch(error => { this.loaded = undefined; throw error; });
    await this.loaded;
  }
  private async reload(): Promise<void> {
    const [registry, secrets] = await Promise.all([readJson(this.file, voiceToolBounds.registryBytes), readJson(this.secretsFile, voiceToolBounds.secretBytes)]);
    // Legacy values remain private, but carry no trusted destination grant.
    const parsed = persistedSecretsSchema.safeParse(secrets ?? {});
    const old = legacySecretsSchema.safeParse(secrets ?? {});
    if (!parsed.success && !old.success) return fail("REGISTRY_UNAVAILABLE");
    const values: Record<string, string> = parsed.success ? Object.fromEntries(Object.entries(parsed.data).map(([ref, entry]) => [ref, entry.value])) : old.data!;
    const policies: SecretPolicies = parsed.success ? Object.fromEntries(Object.entries(parsed.data).map(([ref, entry]) => [ref,
      validSeal(this.secretsFile, { ref, value: entry.value, destinations: entry.destinations }, entry.mac) ? entry.destinations : []])) : {};
    const valid = await parseRegistry(registry, this.directory, policies); assertNoSecrets(valid, values);
    for (const [name, server] of Object.entries(valid.servers)) {
      try { assertSecretDestinations(name, server, policies); }
      catch { if (server.state === "enabled") server.state = "pending"; server.approval = null; server.lastDryRun = null; }
    }
    this.registry = valid; this.secrets = values; this.policies = policies;
  }
  async view(): Promise<VoiceToolsView> {
    await this.load();
    const servers = Object.fromEntries(Object.entries(this.registry.servers).map(([name, server]) => {
      const transport: VoiceToolsView["servers"][string]["transport"] = server.transport.type === "stdio"
        ? { type: "stdio", command: server.transport.command, args: server.transport.args, cwd: server.transport.cwd,
          envNames: Object.keys(server.transport.env).sort(), envValues: literalValues(server.transport.env) }
        : { type: "http", url: server.transport.url, headerNames: Object.keys(server.transport.headers).sort(), headerValues: literalValues(server.transport.headers) };
      return [name, { ...structuredClone(server), transport, digest: approvalDigest(name, server), secretRecipient: secretDestination(name, server),
        missingSecrets: secretReferences(server).filter(ref => !hasSecret(this.secrets, ref)), secretRefs: secretReferences(server), secretDestinations: Object.fromEntries(secretReferences(server).map(ref => [ref, this.policies[ref] ?? []])) }];
    }));
    const result: VoiceToolsView = { version: 1, revision: this.registry.revision, servers };
    assertNoSecrets(result, this.secrets); return result;
  }
  private async mutate<T>(change: (registry: VoiceToolsRegistry) => Promise<T> | T, authorize?: () => void): Promise<T> {
    await this.load();
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const result = await withFileTransactionAsync(this.file, "VOICE_TOOLS_BUSY", async () => {
      await this.reload();
      authorize?.();
      const candidate = structuredClone(this.registry);
      const result = await change(candidate);
      if (result === NO_CHANGE) return result;
      authorize?.();
      candidate.revision++;
      assertNoSecrets(candidate, this.secrets);
      if (Buffer.byteLength(JSON.stringify(candidate)) > voiceToolBounds.registryBytes) return fail("REGISTRY_BOUNDS");
      await atomicJson(this.file, candidate, authorize);
      commitSeals(path.join(this.directory, "approval"), Object.values(candidate.servers).flatMap(server => server.approval?.mac ? [server.approval.mac] : []));
      this.registry = candidate;
      return result;
    });
    // Running sessions learn of revocation from the commit, not from a later file read.
    for (const listener of this.listeners) { try { listener(); } catch { /* A listener never undoes a committed write. */ } }
    return result;
  }
  private readonly listeners = new Set<() => void>();
  /** Called after every committed registry write of this owner. */
  onCommit(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** The registry revision this owner holds in memory. */
  get revision(): number { return this.registry.revision; }
  /** A server whose approval stands, read from memory only (design §3.5 step 2). */
  serving(name: string): VoiceToolServer | null {
    const server = Object.hasOwn(this.registry.servers, name) ? this.registry.servers[name] : undefined;
    return server && servingServer(server) ? server : null;
  }
  /** What a call starts with: the approved servers and their selected tools, from memory; no file and no server (§4.3). */
  snapshot(): VoiceToolSnapshot {
    const servers = Object.entries(this.registry.servers).flatMap(([name, server]) => { const row = snapshotServer(name, server); return row ? [row] : []; })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { revision: this.registry.revision, servers };
  }
  /** Secret values the snapshot's servers reference. They join a call's masking list and nothing else. */
  secretValues(names: readonly string[]): string[] {
    return [...new Set(names.flatMap(name => { const server = this.serving(name); return server ? secretReferences(server) : []; })
      .flatMap(ref => hasSecret(this.secrets, ref) ? [this.secrets[ref]] : []))];
  }
  /** A session start, from memory: the approval must be the one the call took, and every credential bound to this server. */
  sessionInput(name: string, approval: string) {
    const server = this.serving(name);
    if (!server || server.approval!.digest !== approval) return fail("TOOL_REVOKED");
    this.checkDestinations(name, server);
    return { server: structuredClone(server), secrets: Object.fromEntries(secretReferences(server).map(ref => [ref, this.secrets[ref]])), policies: structuredClone(this.policies) };
  }
  /**
   * A live server no longer matches what was approved (§3.7). Catalog drift keeps the approval, so the approved
   * tools keep serving; a changed entry file removes it, so the server does not start until it is approved again.
   */
  async markChanged(name: string, approval: string, revoke: boolean): Promise<void> {
    await this.mutate(registry => {
      const server = Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
      if (!server || server.approval?.digest !== approval || !revoke && server.state === "changed") return NO_CHANGE;
      server.state = "changed";
      if (revoke) server.approval = null;
    });
  }
  async propose(input: unknown, actor: VoiceToolServer["proposedBy"], authorize?: () => void): Promise<void> {
    const shape = proposalSchema.safeParse(input);
    const parsed = shape.success ? validProposal(shape.data, path.join(this.directory, "voice-tools-data", shape.data.name)) : null;
    if (!parsed) return fail("INVALID_PROPOSAL");
    const { name, ...config } = parsed;
    await this.mutate(registry => {
      if (!Object.hasOwn(registry.servers, name) && Object.keys(registry.servers).length >= voiceToolBounds.servers) return fail("REGISTRY_BOUNDS");
      const previous = Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
      const candidate: VoiceToolServer = { ...config, generation: previous?.generation ?? registry.revision + 1, owner: "installation", audience: ["voice"], state: "pending", proposedBy: actor,
        approval: null, tools: previous?.tools ?? {}, catalog: previous?.catalog ?? null, lastDryRun: previous?.lastDryRun ?? null };
      this.checkDestinations(name, candidate, false);
      if (previous && approvalDigest(name, candidate) === approvalDigest(name, previous)) {
        candidate.state = previous.state; candidate.approval = previous.approval;
      } else if (previous) candidate.generation = registry.revision + 1;
      if (previous && probeDigest(name, previous) !== probeDigest(name, candidate)) candidate.lastDryRun = null;
      registry.servers[name] = candidate;
    }, authorize);
  }
  private server(registry: VoiceToolsRegistry, name: string, expected: string): VoiceToolServer {
    const server = Object.hasOwn(registry.servers, name) ? registry.servers[name] : undefined;
    if (!server) return fail("SERVER_NOT_FOUND");
    if (approvalDigest(name, server) !== expected) return fail("STALE_APPROVAL");
    return server;
  }
  private checkDestinations(name: string, server: VoiceToolServer, requireAll = true): void {
    const refs = secretReferences(server);
    if (requireAll && refs.some(ref => !hasSecret(this.secrets, ref))) return fail("MISSING_SECRET");
    const known = requireAll ? refs : refs.filter(ref => hasSecret(this.secrets, ref));
    try { assertSecretDestinations(name, server, this.policies, known); } catch { return fail("SECRET_DESTINATION"); }
  }
  async probeInput(name: string, expected: string) {
    await this.load();
    // Refresh under the same lock as removal and proposal replacement before dispatch.
    let input!: { server: VoiceToolServer; secrets: Record<string, string>; policies: SecretPolicies; digest: string };
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await withFileTransactionAsync(this.file, "VOICE_TOOLS_BUSY", async () => {
      await this.reload();
      const registry = this.registry;
      const server = this.server(registry, name, expected);
      this.checkDestinations(name, server);
      input = { server: structuredClone(server), secrets: Object.fromEntries(secretReferences(server).map(ref => [ref, this.secrets[ref]])), policies: structuredClone(this.policies), digest: probeDigest(name, server) };
    });
    return input;
  }
  async recordProbe(name: string, expected: string, result: ProbeResult): Promise<void> {
    await this.mutate(registry => {
      const server = this.server(registry, name, expected);
      server.lastDryRun = { code: result.code, at: this.now(), digest: probeDigest(name, server) };
      if (result.code === "ENTRY_CHANGED") { server.state = "pending"; server.approval = null; }
      if (result.code === "OK" && result.catalog) {
        assertNoSecrets(result.catalog, this.secrets);
        const tools = validateCatalog(name, result.catalog.tools);
        if (result.catalog.digest !== digest(tools)) return fail("CATALOG_BOUNDS");
        server.catalog = result.catalog;
        server.tools = Object.fromEntries(tools.map(tool => [tool.name, Object.hasOwn(server.tools, tool.name) ? server.tools[tool.name] : { enabled: false, acts: tool.annotations?.readOnlyHint !== true }]));
      }
      if (server.approval?.digest !== approvalDigest(name, server)) { server.state = "pending"; server.approval = null; }
    });
  }
  /**
   * `reapprove` is the operator changing their own choices on an approved server from the settings:
   * the change and the approval of its new digest commit together or not at all, so a refused
   * approval leaves the record as it was. Without it a pinned change returns the server to pending.
   */
  async operatorChange(name: string, expected: string, action: "approve" | "reject" | "remove" | "disable" | "configure", input: { tools?: unknown; askBeforeActing?: unknown; reapprove?: unknown } = {}, authorize?: () => void): Promise<void> {
    await this.mutate(async registry => {
      const server = this.server(registry, name, expected);
      if (action === "remove") { delete registry.servers[name]; return; }
      if (action === "configure") {
        if (input.reapprove !== undefined && input.reapprove !== true) return fail("INVALID_REQUEST");
        if (input.reapprove && server.state !== "enabled") return fail("STALE_APPROVAL");
        if (input.askBeforeActing !== undefined) {
          if (typeof input.askBeforeActing !== "boolean") return fail("INVALID_REQUEST");
          server.askBeforeActing = input.askBeforeActing;
        }
        if (input.tools !== undefined) {
          const parsed = selectionSchema.safeParse(input.tools);
          if (!parsed.success || Object.keys(parsed.data).some(name => !server.catalog?.tools.some(tool => tool.name === name))) return fail("INVALID_REQUEST");
          server.tools = parsed.data;
        }
        if (server.approval?.digest !== approvalDigest(name, server)) { server.state = "pending"; server.approval = null; }
        if (input.reapprove) await this.approve(registry, name, server);
        return;
      }
      if (action !== "approve") {
        server.state = action === "reject" ? "rejected" : "disabled"; server.approval = null;
        server.generation = registry.revision + 1;
        return;
      }
      await this.approve(registry, name, server);
    }, authorize);
  }
  private async approve(registry: VoiceToolsRegistry, name: string, server: VoiceToolServer): Promise<void> {
    this.checkDestinations(name, server);
    if (!server.catalog || server.lastDryRun?.code !== "OK" || server.lastDryRun.digest !== probeDigest(name, server)) return fail("DRY_RUN_REQUIRED");
    try { await verifyEntry(server); } catch { return fail("ENTRY_CHANGED"); }
    // A server changed since approval keeps serving its approved tools, so it counts toward the per-call bounds.
    const enabled = Object.entries(registry.servers).filter(([key, value]) => key === name || servingServer(value));
    if (enabled.length > voiceToolBounds.enabledServers) return fail("SELECTION_BOUNDS");
    const selected = enabled.flatMap(([key, value]) => value.catalog?.tools.filter(tool => value.tools[tool.name]?.enabled).map(tool => ({
      type: "function", name: toolName(key, tool.name), description: tool.description, parameters: tool.inputSchema, strict: false,
    })) ?? []);
    if (selected.length > voiceToolBounds.selectedTools || Buffer.byteLength(JSON.stringify(selected)) > voiceToolBounds.selectionBytes) return fail("SELECTION_BOUNDS");
    if (new Set(selected.map(tool => tool.name)).size !== selected.length) return fail("CATALOG_BOUNDS");
    const approval = { by: "operator" as const, at: this.now(), digest: approvalDigest(name, server) };
    server.state = "enabled"; server.approval = { ...approval, mac: seal(path.join(this.directory, "approval"), approvalSealInput(name, server, approval, this.policies)) };
  }
  async saveSecrets(input: unknown, authorize?: () => void): Promise<void> {
    const parsed = secretsSchema.safeParse(input);
    if (!parsed.success) return fail("INVALID_REQUEST");
    await this.mutate(async registry => {
      const values = { ...this.secrets };
      const policies = structuredClone(this.policies);
      for (const [ref, entry] of Object.entries(parsed.data)) {
        if (entry.value !== undefined) values[ref] = entry.value;
        if (!Object.hasOwn(values, ref) || values[ref].length < 8) return fail("MISSING_SECRET");
        policies[ref] = [...new Set(entry.destinations)].sort();
      }
      assertNoSecrets(registry, values);
      const stored = Object.fromEntries(Object.entries(values).map(([ref, value]) => {
        const entry = { ref, value, destinations: policies[ref] ?? [] };
        return [ref, { value, destinations: entry.destinations, mac: seal(this.secretsFile, entry) }];
      }));
      if (Object.keys(stored).length > 256 || Buffer.byteLength(JSON.stringify(stored)) > voiceToolBounds.secretBytes) return fail("INVALID_REQUEST");
      // Binding changes invalidate probes and approvals before a new dispatch.
      for (const server of Object.values(registry.servers)) {
        if (secretReferences(server).some(ref => JSON.stringify(this.policies[ref]) !== JSON.stringify(policies[ref]))) {
          server.approval = null; server.state = "pending"; server.lastDryRun = null;
        }
      }
      await atomicJson(this.secretsFile, stored, authorize);
      commitSeals(this.secretsFile, Object.values(stored).map(entry => entry.mac));
      this.secrets = values; this.policies = policies;
    }, authorize);
  }
}
