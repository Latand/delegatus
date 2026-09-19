import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  RegistryBackendIdentityError,
  publishRegistryBackendIdentity,
  registryBackendDescriptorPath,
  resolveRegistryBackend,
  type RegistryBackendIo,
} from "./registryBackendIdentity";

const roots: string[] = [];

function stateRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-backend-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function registryFile(root: string): string {
  const filename = path.join(root, "agent-registry.json");
  fs.writeFileSync(filename, JSON.stringify({ entries: {} }));
  return filename;
}

function withStore(root: string): string {
  const store = path.join(root, "agent-registry.sqlite");
  fs.writeFileSync(store, "");
  return store;
}

/** A store whose first-boot import committed: the only kind that can be an
    authority. An empty or unmarked store is an import that never finished. */
function withImportedStore(root: string): string {
  const store = path.join(root, "agent-registry.sqlite");
  const db = new Database(store, { create: true });
  db.exec("CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.query("INSERT INTO registry_meta(key, value) VALUES ('migration_complete', '1')").run();
  db.close();
  return store;
}

/* The production defect, reduced: Claude launches the MCP server with an empty
   env, so the reader saw `off` and opened the JSON mirror while the writer
   owned SQLite. Every host pid it then read was dead, and caller authority
   reported every MCP caller as unidentified. */
test("an MCP reader with no env resolves the writer's SQLite backend, not the JSON mirror", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);

  const resolved = resolveRegistryBackend(filename, {});

  expect(resolved).toEqual({ mode: "sqlite", sqliteFilename: store, source: "descriptor", pendingJsonImport: false });
});

test("a stale JSON mirror is never chosen when the descriptor names SQLite", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);
  /* A mirror far behind the store is exactly the state that produced dead
     host pids in production; resolution must not even consider it. */
  fs.writeFileSync(filename, JSON.stringify({ entries: {}, _sqliteRevision: 1 }));

  expect(resolveRegistryBackend(filename, {}).mode).toBe("sqlite");
});

test("an explicit environment overrides the descriptor and stays authoritative", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);

  const resolved = resolveRegistryBackend(filename, { LLV_AGENT_REGISTRY_SQLITE: "sqlite" });

  expect(resolved).toEqual({ mode: "sqlite", sqliteFilename: null, source: "environment", pendingJsonImport: false });
});

test("a JSON-only deployment with no descriptor resolves to SQLite with the JSON pending import", () => {
  const root = stateRoot();
  const filename = registryFile(root);

  const resolved = resolveRegistryBackend(filename, {});

  expect(resolved).toEqual({ mode: "sqlite", sqliteFilename: null, source: "default", pendingJsonImport: true });
});

test("nothing on disk resolves to the SQLite default with nothing to import", () => {
  const filename = path.join(stateRoot(), "agent-registry.json");

  expect(resolveRegistryBackend(filename, {})).toEqual({ mode: "sqlite", sqliteFilename: null, source: "default", pendingJsonImport: false });
});

test("an imported store with no descriptor and no JSON is the authority", () => {
  const root = stateRoot();
  const filename = path.join(root, "agent-registry.json");
  withImportedStore(root);

  expect(resolveRegistryBackend(filename, {})).toEqual({ mode: "sqlite", sqliteFilename: null, source: "default", pendingJsonImport: false });
});

test("a descriptor that declares a JSON backend resolves to SQLite with the JSON pending import", () => {
  for (const mode of ["off", "dual-write"] as const) {
    const root = stateRoot();
    const filename = registryFile(root);
    publishRegistryBackendIdentity(filename, mode, path.join(root, "agent-registry.sqlite"));
    /* A store beside it is a stale experiment the import sets aside. */
    withImportedStore(root);

    expect(resolveRegistryBackend(filename, {})).toEqual({ mode: "sqlite", sqliteFilename: null, source: "descriptor", pendingJsonImport: true });
  }
});

test("a writer told sqlite over a JSON descriptor imports the JSON", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  publishRegistryBackendIdentity(filename, "off", path.join(root, "agent-registry.sqlite"));

  expect(resolveRegistryBackend(filename, { LLV_AGENT_REGISTRY_SQLITE: "sqlite" }))
    .toEqual({ mode: "sqlite", sqliteFilename: null, source: "environment", pendingJsonImport: true });
});

test("an explicitly configured JSON mode is honoured and imports nothing", () => {
  const root = stateRoot();
  const filename = registryFile(root);

  expect(resolveRegistryBackend(filename, { LLV_AGENT_REGISTRY_SQLITE: "off" }))
    .toEqual({ mode: "off", sqliteFilename: null, source: "environment", pendingJsonImport: false });
});

test("an unpublished identity with both the JSON and an imported store fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withImportedStore(root);

  expect(() => resolveRegistryBackend(filename, {})).toThrow(RegistryBackendIdentityError);
  expect(() => resolveRegistryBackend(filename, {})).toThrow(/unpublished while both agent-registry\.json and agent-registry\.sqlite exist/);
});

test("an unmarked store beside the JSON is no authority: the JSON imports", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);

  expect(resolveRegistryBackend(filename, {})).toMatchObject({ mode: "sqlite", pendingJsonImport: true });
});

test("a descriptor naming an unavailable store fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  publishRegistryBackendIdentity(filename, "sqlite", store);
  fs.rmSync(store);

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/which is unavailable/);
});

test("a corrupt descriptor fails closed instead of falling back", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(registryBackendDescriptorPath(filename), "{not json");

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/is not valid JSON/);
});

test("a descriptor from a future schema fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(
    registryBackendDescriptorPath(filename),
    JSON.stringify({ schemaVersion: 2, mode: "sqlite", sqliteFile: "agent-registry.sqlite", publishedAt: "" }),
  );

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/schema version 2/);
});

test("a descriptor declaring an unknown mode fails closed", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(
    registryBackendDescriptorPath(filename),
    JSON.stringify({ schemaVersion: 1, mode: "postgres", sqliteFile: "agent-registry.sqlite", publishedAt: "" }),
  );

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/unknown backend mode/);
});

test("a descriptor cannot point a reader outside its own state directory", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  fs.writeFileSync(
    registryBackendDescriptorPath(filename),
    JSON.stringify({ schemaVersion: 1, mode: "sqlite", sqliteFile: "../elsewhere.sqlite", publishedAt: "" }),
  );

  expect(() => resolveRegistryBackend(filename, {})).toThrow(/bare filename/);
});

test("an unreadable descriptor fails closed rather than reading as absent", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  withStore(root);
  const io: RegistryBackendIo = {
    readText: () => { throw new RegistryBackendIdentityError("agent-registry.backend.json is unreadable: EACCES"); },
    exists: () => true,
    writeText: () => { throw new Error("unexpected write"); },
  };

  expect(() => resolveRegistryBackend(filename, {}, io)).toThrow(/unreadable: EACCES/);
});

test("publishing is idempotent and replaces a corrupt identity", () => {
  const root = stateRoot();
  const filename = registryFile(root);
  const store = withStore(root);
  const descriptorPath = registryBackendDescriptorPath(filename);

  publishRegistryBackendIdentity(filename, "sqlite", store, undefined, () => "first");
  publishRegistryBackendIdentity(filename, "sqlite", store, undefined, () => "second");
  expect(JSON.parse(fs.readFileSync(descriptorPath, "utf8")).publishedAt).toBe("first");

  fs.writeFileSync(descriptorPath, "{corrupt");
  publishRegistryBackendIdentity(filename, "sqlite", store, undefined, () => "third");
  expect(JSON.parse(fs.readFileSync(descriptorPath, "utf8"))).toMatchObject({
    schemaVersion: 1,
    mode: "sqlite",
    sqliteFile: "agent-registry.sqlite",
    publishedAt: "third",
  });
});
