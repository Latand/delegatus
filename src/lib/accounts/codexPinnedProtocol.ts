import { spawnSync } from "node:child_process";
import { fromJSONSchema, type ZodType } from "zod";
import current from "./protocol/0.162.1/experimental.json";
import currentStable from "./protocol/0.162.1/stable.json";
import currentManifest from "./protocol/0.162.1/manifest.json";
import previous from "./protocol/0.159.0/experimental.json";
import previousStable from "./protocol/0.159.0/stable.json";
import previousManifest from "./protocol/0.159.0/manifest.json";
import oldest from "./protocol/0.154.0/experimental.json";
import oldestStable from "./protocol/0.154.0/stable.json";
import oldestManifest from "./protocol/0.154.0/manifest.json";
import { CodexAppServerProtocolError } from "./codexAppServerProtocol";

type Schema = { [key: string]: unknown; properties?: Record<string, Schema | boolean | undefined>; oneOf?: Schema[]; anyOf?: Schema[]; $ref?: string; type?: string | string[]; definitions?: Record<string, Schema> };
// Generated JSON includes namespace maps and boolean schemas. Navigation uses
// this small view; the response/request validator compiles the complete shape.
function generatedSchema(value: unknown): Schema { return value as Schema; }
const pins = [
  { schema: generatedSchema(current), stable: generatedSchema(currentStable), manifest: currentManifest },
  { schema: generatedSchema(previous), stable: generatedSchema(previousStable), manifest: previousManifest },
  { schema: generatedSchema(oldest), stable: generatedSchema(oldestStable), manifest: oldestManifest },
];
// Pure compiled schemas are shared across hosts; this cache never retains RPC
// payloads, accounts or process ownership.
const validators = new Map<string, ZodType>();

export function installedCodexVersion(binary: string, env: NodeJS.ProcessEnv): string {
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

export class CodexPinnedProtocol {
  readonly version: string;
  readonly schemaDigest: string;
  private readonly pin: typeof pins[number];

  constructor(version = currentManifest.version) {
    const pin = pins.find(row => row.manifest.version === version);
    if (!pin) throw new CodexAppServerProtocolError(`CLI ${version} has no pinned schema; supported: ${pins.map(row => row.manifest.version).join(", ")}. Regenerate with scripts/generate-codex-protocol.ts and review compatibility`);
    this.pin = pin;
    this.version = version;
    this.schemaDigest = pin.manifest.sha256.experimental;
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
      throw new CodexAppServerProtocolError(`CLI ${this.version} ${method} ${path}.${fields.join(".") || "<root>"}: ${issue.code}; pinned schema ${digest.slice(0, 12)}`);
    }
  }

  private unsupported(method: string, path: string, stable = false): never {
    const digest = stable ? this.pin.manifest.sha256.stable : this.schemaDigest;
    throw new CodexAppServerProtocolError(`CLI ${this.version} ${method} ${path} is absent from ${stable ? "stable " : ""}pinned schema ${digest.slice(0, 12)}`);
  }
}
