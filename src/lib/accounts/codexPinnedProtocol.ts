import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromJSONSchema, type ZodType } from "zod";
import currentManifest from "./protocol/0.164.0/manifest.json";
import recentManifest from "./protocol/0.163.0/manifest.json";
import priorManifest from "./protocol/0.162.1/manifest.json";
import previousManifest from "./protocol/0.159.0/manifest.json";
import oldestManifest from "./protocol/0.154.0/manifest.json";
import { CodexAppServerProtocolError } from "./codexAppServerProtocol";
import { codexSchemaBreaks } from "./codexSchemaCompatibility";
import { signalDetachedProcessGroup } from "@/lib/processGroup";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

type Schema = { [key: string]: unknown; properties?: Record<string, Schema | boolean | undefined>; oneOf?: Schema[]; anyOf?: Schema[]; $ref?: string; type?: string | string[]; definitions?: Record<string, Schema> };
// Generated JSON includes namespace maps and boolean schemas. Navigation uses
// this small view; the response/request validator compiles the complete shape.
function generatedSchema(value: unknown): Schema { return value as Schema; }
// Literal requires retain the artifacts in Bun/webpack bundles while keeping
// TypeScript from inferring the entire generated graph for every retained pin.
/* eslint-disable @typescript-eslint/no-require-imports -- Generated schemas are runtime-validated data. */
const pins = [
  { schema: generatedSchema(require("./protocol/0.164.0/experimental.json")), stable: generatedSchema(require("./protocol/0.164.0/stable.json")), manifest: currentManifest },
  { schema: generatedSchema(require("./protocol/0.163.0/experimental.json")), stable: generatedSchema(require("./protocol/0.163.0/stable.json")), manifest: recentManifest },
  { schema: generatedSchema(require("./protocol/0.162.1/experimental.json")), stable: generatedSchema(require("./protocol/0.162.1/stable.json")), manifest: priorManifest },
  { schema: generatedSchema(require("./protocol/0.159.0/experimental.json")), stable: generatedSchema(require("./protocol/0.159.0/stable.json")), manifest: previousManifest },
  { schema: generatedSchema(require("./protocol/0.154.0/experimental.json")), stable: generatedSchema(require("./protocol/0.154.0/stable.json")), manifest: oldestManifest },
];
/* eslint-enable @typescript-eslint/no-require-imports */
// Pure compiled schemas are shared across hosts; this cache never retains RPC
// payloads, accounts or process ownership.
const validators = new Map<string, ZodType>();

export function installedCodexVersion(binary: string, env: NodeJS.ProcessEnv): string {
  // eslint-disable-next-line no-restricted-syntax -- Legacy executable-version probe during Codex host initialization while serving.
  const result = spawnSync(binary, ["--version"], { env, encoding: "utf8", timeout: 5_000 });
  const version = result.status === 0 && /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(result.stdout)?.[1];
  if (!version) throw new CodexAppServerProtocolError("cannot identify executable version with --version");
  return version;
}

function methodSchema(schema: Schema, kind: string, method: string): Schema | undefined {
  return schema.definitions?.[kind]?.oneOf?.find(row => (propertySchema(row, "method")?.enum as string[] | undefined)?.includes(method));
}

function propertySchema(schema: Schema | undefined, field: string): Schema | undefined {
  const value = schema?.properties?.[field];
  return value && typeof value === "object" ? value : undefined;
}

function dereference(schema: Schema, shape: Schema): Schema {
  if (!shape.$ref) return shape;
  let value: unknown = schema;
  for (const key of shape.$ref.slice(2).split("/")) value = (value as Record<string, unknown>)[key];
  return value as Schema;
}

// JSON Schema permits unknown object keys by default. Outgoing API objects must
// name fields in the pin; explicit maps (config, extensions, answers) stay open.
function strictObjects(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictObjects);
  if (!value || typeof value !== "object") return value;
  const row = value as Schema;
  const result = Object.fromEntries(Object.entries(row).map(([key, child]) => [key, strictObjects(child)]));
  if (row.type === "object" && row.properties && row.additionalProperties === undefined) result.additionalProperties = false;
  return result;
}

const REMEDY = "Pin the CLI to a supported version, or regenerate with scripts/generate-codex-protocol.ts and review compatibility";
const supported = () => pins.map(row => row.manifest.version).join(", ");

/** An executable whose own generated schema extends `pin` additively. */
export interface CodexUnpinnedCli {
  cliVersion: string;
  /** SHA-256 of the executable's generated experimental bundle. */
  cliSchemaDigest: string;
}

export class CodexPinnedProtocol {
  /** The reviewed pin whose contract every payload is validated against. */
  readonly version: string;
  /** What the executable reports; differs from `version` only under an additive fallback. */
  readonly cliVersion: string;
  readonly schemaDigest: string;
  readonly unpinned: CodexUnpinnedCli | null;
  private readonly pin: typeof pins[number];

  constructor(version = currentManifest.version, unpinned: CodexUnpinnedCli | null = null) {
    const pin = pins.find(row => row.manifest.version === version);
    if (!pin) throw new CodexAppServerProtocolError(`CLI ${version} has no pinned schema. ${REMEDY}. Supported: ${supported()}`);
    this.pin = pin;
    this.version = version;
    this.cliVersion = unpinned?.cliVersion ?? version;
    this.unpinned = unpinned;
    this.schemaDigest = pin.manifest.sha256.experimental;
  }

  private get label(): string {
    return this.unpinned ? `CLI ${this.cliVersion} (under pin ${this.version})` : `CLI ${this.version}`;
  }

  hasMethod(kind: "ClientRequest" | "ClientNotification" | "ServerRequest" | "ServerNotification", method: string, stable = false): boolean {
    return !!methodSchema(stable ? this.pin.stable : this.pin.schema, kind, method);
  }

  hasRequestField(method: string, field: string, stable = false): boolean {
    const schema = stable ? this.pin.stable : this.pin.schema;
    const params = propertySchema(methodSchema(schema, "ClientRequest", method), "params");
    const hasField = (shape: Schema): boolean => {
      const resolved = dereference(schema, shape);
      return Object.prototype.hasOwnProperty.call(resolved.properties ?? {}, field)
        || (resolved.oneOf ?? resolved.anyOf ?? []).some(hasField);
    };
    return !!params && hasField(params);
  }

  /** The protocol has a single experimental switch. Use it only for a declared
   * feature that needs an experimental method or field, and filter each call. */
  initializeCapabilities(methods: readonly string[], fields: ReadonlyArray<{ method: string; field: string }> = []): { experimentalApi: boolean } {
    for (const method of methods) if (!this.hasMethod("ClientRequest", method)) this.unsupported(method, "method");
    for (const { method, field } of fields) if (!this.hasRequestField(method, field)) this.unsupported(method, `params.${field}`);
    return { experimentalApi: fields.some(({ method, field }) => !this.hasRequestField(method, field, true)) || methods.some(method => !this.hasMethod("ClientRequest", method, true)) };
  }

  assertRequest(method: string, params: unknown, experimentalApi = true): void {
    const schema = experimentalApi ? this.pin.schema : this.pin.stable;
    const shape = propertySchema(methodSchema(schema, "ClientRequest", method), "params");
    if (!shape) this.unsupported(method, "method", !experimentalApi);
    this.validate(method, experimentalApi ? "params" : "stable-params", shape, params, schema);
  }

  assertNotification(method: string, params: unknown): void {
    const shape = methodSchema(this.pin.schema, "ClientNotification", method);
    if (!shape) this.unsupported(method, "method");
    const paramShape = propertySchema(shape, "params");
    if (paramShape) this.validate(method, "params", paramShape, params);
  }

  assertServerResponse(method: string, result: unknown): void {
    const params = propertySchema(methodSchema(this.pin.schema, "ServerRequest", method), "params")?.$ref;
    if (!params) this.unsupported(method, "server request");
    this.validate(method, "result", { $ref: params.replace(/Params$/, "Response") }, result);
  }

  assertServerRequest(method: string, params: unknown): void {
    const shape = propertySchema(methodSchema(this.pin.schema, "ServerRequest", method), "params");
    if (!shape) this.unsupported(method, "server request");
    this.validate(method, "server-params", shape, params);
  }

  private validate(method: string, path: string, shape: Schema, value: unknown, source = this.pin.schema): void {
    const key = `${this.version}:${method}:${path}`;
    let validator = validators.get(key);
    if (!validator) {
      // Zod accepts one definition-key segment in a reference. Flatten the
      // generator's #/definitions/v2/<name> names and references together;
      // otherwise v2 resolves to its namespace object and silently becomes any.
      const definitions = Object.fromEntries(Object.entries(source.definitions ?? {}).flatMap(([name, value]) =>
        name === "v2" ? Object.entries(value).map(([child, definition]) => [`v2.${child}`, definition]) : [[name, value]]));
      const flattenRefs = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(flattenRefs);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
          key === "$ref" && typeof child === "string" && child.startsWith("#/definitions/")
            ? `#/definitions/${child.slice("#/definitions/".length).replaceAll("/", ".")}` : flattenRefs(child)]));
      };
      const schema = strictObjects(flattenRefs({ ...shape, $schema: "http://json-schema.org/draft-07/schema#", definitions }));
      validator = fromJSONSchema(schema as Parameters<typeof fromJSONSchema>[0]);
      validators.set(key, validator);
    }
    const parsed = validator.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const fields = issue.code === "unrecognized_keys" ? [...issue.path, ...issue.keys] : issue.path;
      // Only method/path/code: payloads and schema error values may hold secrets.
      const digest = source === this.pin.stable ? this.pin.manifest.sha256.stable : this.schemaDigest;
      throw new CodexAppServerProtocolError(`${this.label} ${method} ${path}.${fields.join(".") || "<root>"}: ${issue.code}; pinned schema ${digest.slice(0, 12)}`);
    }
  }

  private unsupported(method: string, path: string, stable = false): never {
    const digest = stable ? this.pin.manifest.sha256.stable : this.schemaDigest;
    throw new CodexAppServerProtocolError(`${this.label} ${method} ${path} is absent from ${stable ? "stable " : ""}pinned schema ${digest.slice(0, 12)}`);
  }
}

/* An unreviewed CLI (a self-update) is admitted only under the newest older
 * pin, and only when the executable's own generated schemas extend that pin
 * additively. Payloads stay validated against the reviewed pin, so the wire
 * contract cannot change silently; any break refuses with the remedy. */
export type CodexSchemaGenerator = (binary: string, env: NodeJS.ProcessEnv) => Promise<{ stable: string; experimental: string }>;
const GENERATION_TIMEOUT_MS = 30_000;
const MAX_ADMISSIONS = 8;
// Keyed by CLI version: the generator is deterministic for an executable
// version. Bounded, oldest evicted; failed generation is never retained.
const admissions = new Map<string, Promise<CodexUnpinnedCli>>();

function semver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function nearestOlderPin(version: string): typeof pins[number] | undefined {
  const target = semver(version);
  if (!target) return undefined;
  return pins.filter(row => compareSemver(semver(row.manifest.version)!, target) < 0)
    .sort((left, right) => compareSemver(semver(right.manifest.version)!, semver(left.manifest.version)!))[0];
}

/* One generator run, bounded without the child's cooperation: at the deadline
 * its whole process group (an npm shim keeps the native binary as a child) is
 * SIGKILLed and the run rejects at once, so a CLI that ignores signals cannot
 * hold the shared admission past the bound. */
function runGenerator(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const fail = (reason: string) => new CodexAppServerProtocolError(`${label} failed (${reason})`);
    let settled = false, failure: Error | undefined;
    const settle = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); };
    const child = spawn(binary, args, { env, detached: true, stdio: "ignore" });
    const abort = (error: Error) => { failure ??= error; signalDetachedProcessGroup(child, "SIGKILL"); };
    const timer = setTimeout(() => abort(fail("timed out")), timeoutMs);
    child.once("error", error => { failure ??= fail(`exit ${String((error as NodeJS.ErrnoException).code ?? "unknown")}`); });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      if (!failure && code === 0) { settle(); return; }
      failure ??= fail(`exit ${String(code ?? signal ?? "unknown")}`);
      if (child.pid) {
        signalDetachedProcessGroup(child, "SIGKILL");
        const deadline = Date.now() + 5_000;
        for (;;) {
          const running = generatorGroupAlive(child.pid);
          if (running === false) break;
          if (Date.now() >= deadline) { settle(fail(`${failure.message}; process group cleanup could not be verified`)); return; }
          await new Promise<void>(resolve => setTimeout(resolve, 25));
        }
      }
      settle(failure);
    });
  });
}

function generatorGroupAlive(groupId: number): boolean | null {
  if (process.platform === "linux") {
    let entries: string[];
    try { entries = fs.readdirSync("/proc"); } catch { return null; }
    let uncertain = false;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        if (Number(fields[2]) === groupId && !["Z", "X", "x"].includes(fields[0]!)) return true;
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) uncertain = true;
      }
    }
    return uncertain ? null : false;
  }
  if (process.platform === "win32") return null;
  try { process.kill(-groupId, 0); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false
      : (error as NodeJS.ErrnoException).code === "EPERM" ? true : null;
  }
}

export const generateCodexSchemas = async (binary: string, env: NodeJS.ProcessEnv, options: { timeoutMs?: number } = {}): Promise<{ stable: string; experimental: string }> => {
  const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), "delegatus-codex-schema-"));
  try {
    const result = { stable: "", experimental: "" };
    for (const name of ["stable", "experimental"] as const) {
      const out = path.join(scratch, name);
      const experimental = name === "experimental" ? ["--experimental"] : [];
      await runGenerator(binary, ["app-server", "generate-json-schema", "--out", out, ...experimental], env,
        options.timeoutMs ?? GENERATION_TIMEOUT_MS, `generate-json-schema${experimental.length ? " --experimental" : ""}`);
      result[name] = await fs.promises.readFile(path.join(out, "codex_app_server_protocol.schemas.json"), "utf8");
    }
    return result;
  } finally { await fs.promises.rm(scratch, { recursive: true, force: true }); }
};

async function admitUnpinned(version: string, pin: typeof pins[number], binary: string, env: NodeJS.ProcessEnv, generate: CodexSchemaGenerator, forget: () => void): Promise<CodexUnpinnedCli> {
  const pinned = pin.manifest.version;
  let generated: Awaited<ReturnType<CodexSchemaGenerator>>;
  try { generated = await generate(binary, env); }
  catch (error) {
    // A comparison verdict is retained; a failed generation is retried by the next launch.
    forget();
    const detail = error instanceof Error ? error.message.replace(/^Codex app-server protocol error: /, "") : "generation failed";
    throw new CodexAppServerProtocolError(`CLI ${version} has no pinned schema and its schema could not be compared with pin ${pinned}. ${REMEDY}. Supported: ${supported()}; cause: ${detail}`);
  }
  let breaks: string[];
  try {
    breaks = [...codexSchemaBreaks(pin.stable, JSON.parse(generated.stable)).map(row => `stable ${row}`),
      ...codexSchemaBreaks(pin.schema, JSON.parse(generated.experimental)).map(row => `experimental ${row}`)].slice(0, 3);
  } catch { breaks = ["generated schema is not JSON"]; }
  // The remedy precedes the details: protocol errors are clipped to 500 characters.
  if (breaks.length) throw new CodexAppServerProtocolError(`CLI ${version} has no pinned schema and is not an additive extension of pin ${pinned}. ${REMEDY}. Supported: ${supported()}; breaks: ${breaks.map(row => row.slice(0, 100)).join("; ")}`);
  const cliSchemaDigest = createHash("sha256").update(generated.experimental).digest("hex");
  console.warn(`[codex protocol] CLI ${version} has no pinned schema; admitted under pin ${pinned} because its generated schema (${cliSchemaDigest.slice(0, 12)}) extends that pin additively. Regenerate with scripts/generate-codex-protocol.ts and review compatibility to pin it`);
  return { cliVersion: version, cliSchemaDigest };
}

/** Select the protocol for an executable's `--version`: its own pin, or the
 * additive fallback above. Asynchronous: generation runs a child process. */
export async function resolveCodexProtocol(version: string, binary: string, env: NodeJS.ProcessEnv, generate: CodexSchemaGenerator = generateCodexSchemas): Promise<CodexPinnedProtocol> {
  if (pins.some(row => row.manifest.version === version)) return new CodexPinnedProtocol(version);
  const pin = nearestOlderPin(version);
  if (!pin) throw new CodexAppServerProtocolError(`CLI ${version} has no pinned schema and no older pin to compare it with. ${REMEDY}. Supported: ${supported()}`);
  let admission = admissions.get(version);
  if (!admission) {
    const started: Promise<CodexUnpinnedCli> = withViewerOperation("codex.protocol-admission", () =>
      admitUnpinned(version, pin, binary, env, generate, () => { if (admissions.get(version) === started) admissions.delete(version); }));
    admission = started;
    admissions.set(version, started);
    while (admissions.size > MAX_ADMISSIONS) admissions.delete(admissions.keys().next().value!);
  }
  return new CodexPinnedProtocol(pin.manifest.version, await admission);
}

export function resetCodexProtocolAdmissionsForTest(): void { admissions.clear(); }
