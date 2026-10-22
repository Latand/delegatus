import { expect, test } from "bun:test";
import Ajv from "ajv";
import { approvalDigest, boundedDescription, digest, proposalSchema, secretsSchema, toolName, validateCatalog, type VoiceToolServer } from "./contracts";

const tool = (name = "search") => ({ name, description: "Search", inputSchema: { type: "object", properties: {} } });
const base = (): VoiceToolServer => ({ ...proposalSchema.parse({ name: "music", title: "Music", capability: "Play music", transport: { type: "stdio", command: "bun", args: ["run", "/scripts/server.ts"], env: { LABEL: { value: "music" }, TOKEN: { secretRef: "music-token" } } }, entryFile: { path: "/scripts/server.ts", sha256: "a".repeat(64) } }),
  generation: 1, owner: "installation", audience: ["voice"], state: "pending", proposedBy: { kind: "conversation", conversationId: null, at: "2026-01-01T00:00:00Z" }, approval: null,
  tools: { search: { enabled: true, acts: false } }, catalog: { digest: digest([tool()]), fetchedAt: "2026-01-01T00:00:00Z", tools: [tool()] }, lastDryRun: null });

test("every pinned approval field changes the digest, with stable key ordering", () => {
  const source = base();
  const changes: ((server: VoiceToolServer) => void)[] = [
    s => { s.title += "!"; }, s => { s.capability += "!"; }, s => { s.private = true; }, s => { s.askBeforeActing = true; }, s => { s.callTimeoutMs = 6000; },
    s => { s.entryFile = { path: "/scripts/music.ts", sha256: "a".repeat(64) }; },
    s => { s.catalog!.digest = digest("new"); }, s => { s.tools.search.enabled = false; }, s => { s.tools.search.acts = true; },
    s => { if (s.transport.type === "stdio") s.transport.command = "uv"; },
    s => { if (s.transport.type === "stdio") s.transport.args.push("extra"); },
    s => { if (s.transport.type === "stdio") s.transport.cwd = "/scripts"; },
    s => { if (s.transport.type === "stdio") s.transport.env.NEW = { value: "new" }; },
    s => { if (s.transport.type === "stdio") s.transport.env.LABEL = { value: "changed" }; },
    s => { if (s.transport.type === "stdio") s.transport.env.TOKEN = { secretRef: "other-token" }; },
    s => { s.generation++; },
  ];
  for (const change of changes) {
    const changed = structuredClone(source); change(changed);
    expect(approvalDigest("music", changed)).not.toBe(approvalDigest("music", source));
  }
  expect(approvalDigest("other", source)).not.toBe(approvalDigest("music", source));
  source.transport = { type: "http", url: "https://example.invalid/mcp", headers: { Label: { value: "music" }, Authorization: { secretRef: "music-token" } } };
  for (const transport of [
    { ...source.transport, url: "https://example.invalid/new" },
    { ...source.transport, headers: { Label: { value: "other" }, Authorization: { secretRef: "music-token" } } },
    { ...source.transport, headers: { Other: { value: "music" }, Authorization: { secretRef: "music-token" } } },
    { ...source.transport, headers: { Label: { value: "music" }, Authorization: { secretRef: "other-token" } } },
  ]) expect(approvalDigest("music", { ...source, transport })).not.toBe(approvalDigest("music", source));
  expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
  const script = base(); script.entryFile = { path: "/scripts/music.ts", sha256: "a".repeat(64) };
  expect(approvalDigest("music", script)).not.toBe(approvalDigest("music", { ...script, entryFile: { ...script.entryFile, sha256: "b".repeat(64) } }));
});

test("proposals validate launchers, names, transports, secrets and timeouts", () => {
  const valid = { name: "music", title: "Music", capability: "Play", transport: { type: "http", url: "http://127.0.0.1:1234/mcp" } };
  expect(proposalSchema.safeParse(valid).success).toBe(true);
  expect(proposalSchema.parse(valid).askBeforeActing).toBe(false);
  for (const authorityHeader of ["Host", "host", "HOST", "hOsT"]) {
    expect(proposalSchema.safeParse({ ...valid, transport: { ...valid.transport, headers: { [authorityHeader]: { value: "attacker.example.test" } } } }).success).toBe(false);
  }
  expect(proposalSchema.safeParse({ ...valid, transport: { type: "http", url: "https://example.invalid/mcp?version=1" } }).success).toBe(true);
  const credentialUrl = new URL("https://example.invalid/mcp");
  credentialUrl.username = "user"; credentialUrl.password = "example";
  for (const url of ["http://example.invalid/mcp", credentialUrl.href, "file:///script", "http://127.0.0.1/mcp?token=hidden", "https://example.invalid/#token"]) {
    expect(proposalSchema.safeParse({ ...valid, transport: { type: "http", url } }).success).toBe(false);
  }
  for (const name of ["a", "../music", "Music", "a".repeat(25), "__proto__"]) expect(proposalSchema.safeParse({ ...valid, name }).success).toBe(false);
  for (const command of ["node", "npx", "sh", "python"]) expect(proposalSchema.safeParse({ ...valid, transport: { type: "stdio", command, args: [] } }).success).toBe(false);
  expect(proposalSchema.safeParse({ ...valid, transport: { type: "stdio", command: "bun", args: [], env: { API_TOKEN: { value: "literal" } } } }).success).toBe(false);
  expect(proposalSchema.safeParse({ ...valid, secrets: { token: "literal" } }).success).toBe(false);
  for (const callTimeoutMs of [4999, 60001, 5000.5]) expect(proposalSchema.safeParse({ ...valid, callTimeoutMs }).success).toBe(false);
});

test("a stdio proposal cannot name a variable that chooses the binary, loader, package or config of its launch", () => {
  const stdio = (env: Record<string, unknown>) => ({ name: "music", title: "Music", capability: "Play", transport: { type: "stdio", command: "bun", args: ["x", "harmless-mcp"], env } });
  for (const name of ["PATH", "Path", "PATHEXT", "HOME", "TMPDIR", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "node_options", "NODE_PATH", "NODE_ENVIRONMENT", "BUN_CONFIG_REGISTRY",
    "BUN_INSTALL", "BUNFIG", "UV_INDEX_URL", "UV_PYTHON", "NPM_CONFIG_REGISTRY", "npm_config_registry", "PYTHONPATH", "PYTHONSTARTUP", "PIP_INDEX_URL", "VIRTUAL_ENV",
    "XDG_CONFIG_HOME", "GIT_SSH_COMMAND", "GLIBC_TUNABLES", "HTTPS_PROXY", "https_proxy", "SSL_CERT_FILE"]) {
    expect(proposalSchema.safeParse(stdio({ [name]: { value: "/srv/agent/bin" } })).success).toBe(false);
    expect(proposalSchema.safeParse(stdio({ [name]: { secretRef: "chosen-later" } })).success).toBe(false);
  }
  expect(proposalSchema.safeParse(stdio({ PATH: { value: "/srv/agent/bin" }, LD_PRELOAD: { value: "/srv/agent/x.so" }, BUN_CONFIG_REGISTRY: { value: "https://registry.example.test" } })).success).toBe(false);
  /* Ordinary configuration, including names that only contain a refused word, still passes. */
  for (const name of ["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI", "LABEL", "MY_PATH", "NOTES_HOME", "LANG", "LOG_LEVEL", "NODE_ENV"]) {
    expect(proposalSchema.safeParse(stdio({ [name]: { value: "music" } })).success).toBe(true);
  }
  /* HTTP headers launch nothing; their names are not launch variables. */
  expect(proposalSchema.safeParse({ ...stdio({}), transport: { type: "http", url: "https://example.invalid/mcp", headers: { Path: { value: "x" } } } }).success).toBe(true);
});

test("catalogs bound count, UTF-8 descriptions, schema bytes, depth, validity and normalized names", () => {
  const ajv = new Ajv({ strict: false });
  const validate = (tools: unknown) => validateCatalog("music", tools, s => { ajv.compile(s); });
  expect(validate(Array.from({ length: 128 }, (_, i) => tool(`search${i}`)))).toHaveLength(128);
  expect(() => validate(Array.from({ length: 129 }, (_, i) => tool(`search${i}`)))).toThrow("CATALOG_BOUNDS");
  expect(() => validate([tool("search-a"), tool("search_a")])).toThrow("CATALOG_BOUNDS");
  expect(() => validate([tool("search"), tool("SEARCH")])).toThrow("CATALOG_BOUNDS");
  const description = boundedDescription("🎵".repeat(1000));
  expect(Buffer.byteLength(description)).toBe(1024); expect(description).not.toContain("�");
  expect(validate([{ ...tool(), description: "x".repeat(1025) }])[0].description.length).toBe(1024);
  expect(() => validate([{ ...tool(), inputSchema: { type: "object", description: "x".repeat(8192) } }])).toThrow("CATALOG_BOUNDS");
  let nested: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 5; i++) nested = { type: "object", properties: { child: nested } };
  expect(() => validate([{ ...tool(), inputSchema: nested }])).toThrow("CATALOG_BOUNDS");
  expect(() => validate([{ ...tool(), inputSchema: { type: "object", properties: { broken: { type: "made-up" } } } }])).toThrow("CATALOG_BOUNDS");
  expect(() => validate([{ ...tool(), inputSchema: { type: "object", $ref: "https://example.invalid/schema" } }])).toThrow("CATALOG_BOUNDS");
  expect(toolName("music", "Long".repeat(32))).toHaveLength(64);
  expect(toolName("music", "Long".repeat(32))).not.toBe(toolName("music", "long".repeat(31) + "else"));
  expect(validate([{ ...tool(), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Search" } }])[0].annotations)
    .toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Search" });
});

test("vault accounting bounds serialized UTF-8 after JSON escaping", () => {
  expect(secretsSchema.safeParse({ music: { value: "synthetic-voice-credential", destinations: ["https://example.invalid"] } }).success).toBe(true);
  expect(secretsSchema.safeParse(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`secret${i}`, { value: "\0".repeat(8192), destinations: ["https://example.invalid"] }]))).success).toBe(false);
  expect(secretsSchema.safeParse(Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`secret${i}`, { value: "🎵".repeat(4096), destinations: ["https://example.invalid"] }]))).success).toBe(false);
});

test("package launches accept only registry names and optional versions", () => {
  const proposal = (command: "bun" | "uv", target: string) => ({ name: "music", title: "Music", capability: "Search",
    transport: { type: "stdio", command, args: command === "bun" ? ["x", target] : ["tool", "run", target] } });
  for (const [command, target] of [
    ["bun", "name@file:/abs"], ["bun", "/abs"], ["uv", "/abs"], ["uv", "n @ file:///abs"],
    ["bun", "git+file:/abs"], ["uv", "git+file:/abs"],
  ] as const) expect(proposalSchema.safeParse(proposal(command, target)).success).toBe(false);
  for (const target of ["file:/abs", "link:/abs", "workspace:*", "git+https://example.invalid/repo", "git://example.invalid/repo",
    "https://example.invalid/pkg.tgz", "http://example.invalid/pkg.tgz", "./pkg", "../pkg", "~/pkg", "C:\\pkg", "pkg\\bin",
    "File:/abs", "%66ile:/abs", "name@File:/abs", "name@%66ile:/abs", "name%40file%3A%2Fabs",
    "name @ https://example.invalid/pkg.tgz", "name@https://example.invalid/pkg.tgz", "name@npm:other", "repo/pkg", "--from", "pkg\n"]) {
    for (const command of ["bun", "uv"] as const) expect(proposalSchema.safeParse(proposal(command, target)).success).toBe(false);
  }
  const prerelease = ["@tools/music-mcp", "2.0.0-beta.1+build.2"].join("@");
  for (const target of ["music-mcp", "@tools/music-mcp", "music-mcp@1.2.3", prerelease, "music-mcp@latest", "music-mcp@next"])
    expect(proposalSchema.safeParse(proposal("bun", target)).success).toBe(true);
  for (const target of ["music-mcp", "Music_MCP", "m", "music.mcp==1.2.3", "music-mcp==1!2.0rc1.post2.dev3+linux.1"])
    expect(proposalSchema.safeParse(proposal("uv", target)).success).toBe(true);
});


test("package targets refuse bare archives, incomplete versions and launcher options", () => {
  const proposal = (command: "bun" | "uv", args: string[]) => ({ name: "music", title: "Music", capability: "Search", transport: { type: "stdio", command, args } });
  for (const target of ["pkg.tgz", "pkg.tar.gz", "pkg.tar", "pkg.zip", "pkg.whl"])
    for (const command of ["bun", "uv"] as const)
      expect(proposalSchema.safeParse(proposal(command, command === "bun" ? ["x", target] : ["tool", "run", target])).success).toBe(false);
  for (const target of ["music@", "music@1.2", "music@^1.2.3", "music@1.2.3-01", "music@1.2.3-1.01", "a".repeat(215)])
    expect(proposalSchema.safeParse(proposal("bun", ["x", target])).success).toBe(false);
  for (const target of ["music==", "music>=1.0", "music==1.*", "music[extra]", "music;os_name=='posix'", "music==file:/abs"])
    expect(proposalSchema.safeParse(proposal("uv", ["tool", "run", target])).success).toBe(false);
  expect(proposalSchema.safeParse(proposal("bun", ["x", "--package", "/abs"])).success).toBe(false);
  expect(proposalSchema.safeParse(proposal("uv", ["tool", "run", "--from", "/abs"])).success).toBe(false);
  expect(proposalSchema.safeParse(proposal("bun", ["run", "/abs"])).success).toBe(false);
  expect(proposalSchema.safeParse({ ...proposal("bun", ["run", "/abs"]), entryFile: { path: "/abs", sha256: "a".repeat(64) } }).success).toBe(true);
});


test("package launches refuse trailing execution arguments and uv interpreter requests", () => {
  const accepts = (command: "bun" | "uv", args: string[]) => proposalSchema.safeParse({ name: "music", title: "Music", capability: "Search",
    transport: { type: "stdio", command, args } }).success;
  for (const [command, args] of [
    ["bun", ["x", "sh", "-c", "exec bun /abs/server.mjs"]], ["bun", ["x", "bun", "/abs/server.mjs"]],
    ["bun", ["x", "python3", "/abs/server.py"]], ["uv", ["tool", "run", "python", "/abs/server.py"]],
    ["bun", ["x", "env", "bun", "/abs/server.mjs"]], ["bun", ["x", "name@1.2.3", "--eval=code"]],
    ["uv", ["tool", "run", "name==1.2.3", "--from", "/abs"]],
  ] as ["bun" | "uv", string[]][]) expect(accepts(command, args)).toBe(false);
  for (const name of ["python", "python3", "python3.12", "pythonw", "cpython", "cpython-3.12", "pypy", "pypy3.10", "graalpy", "graalpy-3.11", "cp312", "3.12"]) {
    for (const target of [name, name.toUpperCase(), `${name}==3.12`]) expect(accepts("uv", ["tool", "run", target])).toBe(false);
  }
  expect(accepts("bun", ["x", "@scope/name@1.2.3"])).toBe(true);
  expect(accepts("uv", ["tool", "run", "name==1.2.3"])).toBe(true);
});


test("secret destinations require explicit exact origins or a local recipient", () => {
  for (const destination of ["https://example.test", "https://example.test:8443", "http://127.0.0.1:3456", "stdio:music"]) {
    expect(secretsSchema.safeParse({ token: { value: "synthetic-voice-credential", destinations: [destination] } }).success).toBe(true);
  }
  for (const destination of ["https://*.example.test", "example.test", "https://example.test/mcp", "https://example.test/", "http://example.test", "https://user@example.test", "stdio:*"]) {
    expect(secretsSchema.safeParse({ token: { value: "synthetic-voice-credential", destinations: [destination] } }).success).toBe(false);
  }
  expect(secretsSchema.safeParse({ token: "synthetic-voice-credential" }).success).toBe(false);
  expect(secretsSchema.safeParse({ token: { destinations: [] } }).success).toBe(false);
});
