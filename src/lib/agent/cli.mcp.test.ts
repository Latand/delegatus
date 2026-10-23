import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { freshSpecFor, prepareAgentPublicationSpec, resumeSpecForSession, withSpawnCapability } from "./cli";
import { setCodexShellPolicyReaderForTest } from "@/lib/git/codexShellPolicy";
import { parseCodexFeatures, setCodexFeatureReaderForTest } from "./codexSpawnPolicy";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-mcp-"));
const restorePolicy = setCodexShellPolicyReaderForTest(() => ({}));
const restoreFeatures = setCodexFeatureReaderForTest(() => parseCodexFeatures("multi_agent stable true"));
const binary = path.join(root, "codex-list");
fs.writeFileSync(binary, '#!/bin/sh\nprintf \'[{"name":"other"}]\'\n', { mode: 0o700 });
afterAll(() => {
  restorePolicy(); restoreFeatures();
  fs.rmSync(root, { recursive: true, force: true });
});

for (const mode of ["fresh", "resume"] as const) test(`${mode} terminal materializes an unregistered HTTP Viewer after publication preparation`, async () => {
  const previous = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    const home = path.join(root, mode); fs.mkdirSync(home);
    const initial = mode === "fresh" ? freshSpecFor("codex", root, { codexHome: home, cleanMemory: true })
      : resumeSpecForSession("codex", "12345678-1234-1234-1234-123456789abc", root, home, { cleanMemory: true })!;
    const prepared = await prepareAgentPublicationSpec(initial);
    for (const transport of [undefined, "", "stdio", "http"]) {
      const admitted = withSpawnCapability(prepared, "a".repeat(43), {
        ...process.env, LLV_TOKEN: undefined, DELEGATUS_MCP_TRANSPORT: undefined,
        LLV_MCP_TRANSPORT: transport, LLV_MCP_HTTP_URL: "http://127.0.0.1:41234/api/mcp",
      });
      expect(admitted.command).toContain("mcp_servers.other.enabled=false");
      expect(admitted.command).toContain("mcp_servers.viewer.enabled=true");
      if (transport === "http") {
        expect(admitted.command).toContain('mcp_servers.viewer.url="http://127.0.0.1:41234/api/mcp"');
        expect(admitted.command).toContain('env_http_headers.x-llv-spawn-capability="LLV_SPAWN_CAPABILITY"');
        expect(admitted.command).not.toContain("mcp_servers.viewer.command=");
        expect(admitted.command).not.toContain("mcp_servers.viewer.env.");
      } else {
        expect(admitted.command).toContain('mcp_servers.viewer.command="bun"');
        expect(admitted.command).toContain('mcp_servers.viewer.env_vars=["LLV_SPAWN_CAPABILITY"]');
        expect(admitted.command).not.toContain("mcp_servers.viewer.url=");
      }
      if (mode === "resume") expect(admitted.command.indexOf("mcp_servers.viewer.enabled=true")).toBeLessThan(admitted.command.indexOf(" resume "));
    }
    const alias = withSpawnCapability(prepared, "a".repeat(43), {
      ...process.env, LLV_TOKEN: undefined, DELEGATUS_MCP_TRANSPORT: "http", LLV_MCP_TRANSPORT: "stdio",
    });
    expect(alias.command).toContain("mcp_servers.viewer.url=");
    expect(fs.existsSync(path.join(home, "config.toml"))).toBe(false);
    expect(() => withSpawnCapability(prepared, "invalid")).toThrow("Viewer spawn capability is invalid");
  } finally {
    if (previous === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = previous;
  }
});

test("an unadmitted attach and a protected HTTP endpoint retain the stdio fallback", () => {
  const previous = process.env.LLV_CODEX_BINARY;
  process.env.LLV_CODEX_BINARY = binary;
  try {
    const initial = freshSpecFor("codex", root, { codexHome: root, cleanMemory: true });
    expect(initial.command).toContain('mcp_servers.viewer.command="bun"');
    const admitted = withSpawnCapability(initial, "b".repeat(43), {
      NODE_ENV: "test",
      LLV_MCP_TRANSPORT: "http", LLV_TOKEN: "fixture-access", LLV_VIEWER_PORT: "41235",
      LLV_MCP_HTTP_URL: "http://127.0.0.1:41234/api/mcp",
    });
    expect(admitted.command).toContain('mcp_servers.viewer.command="bun"');
    expect(admitted.command).not.toContain("fixture-access");
    expect(admitted.command).not.toContain("mcp_servers.viewer.url=");
  } finally {
    if (previous === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = previous;
  }
});

test("a registered stdio Viewer remains unchanged with an HTTP launch preference", () => {
  const registered = path.join(root, "codex-registered");
  fs.writeFileSync(registered, '#!/bin/sh\nprintf \'[{"name":"viewer"},{"name":"other"}]\'\n', { mode: 0o700 });
  const previous = process.env.LLV_CODEX_BINARY; process.env.LLV_CODEX_BINARY = registered;
  try {
    const initial = freshSpecFor("codex", root, { codexHome: root, cleanMemory: true });
    const admitted = withSpawnCapability(initial, "c".repeat(43), { NODE_ENV: "test", LLV_MCP_TRANSPORT: "http" });
    expect(admitted.command).toContain("mcp_servers.viewer.enabled=true");
    expect(admitted.command).not.toContain("mcp_servers.viewer.url=");
    expect(admitted.command).not.toContain("mcp_servers.viewer.command=");
  } finally {
    if (previous === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = previous;
  }
});
