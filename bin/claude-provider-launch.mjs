#!/usr/bin/env bun
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { startClaudeProviderRelay } from "./claude-provider-relay.mjs";

function privateText(filename, maxBytes) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes)
    throw new Error("Provider account requires repair");
  return fs.readFileSync(filename, "utf8");
}

async function main() {
  const separator = process.argv.indexOf("--");
  const options = process.argv.slice(2, separator);
  const cli = process.argv.slice(separator + 1);
  const option = (name) => { const index = options.indexOf(name); return index >= 0 ? options[index + 1] : undefined; };
  const home = option("--home");
  const baseUrl = option("--base-url");
  const defaultModel = option("--default-model");
  const smallModel = option("--small-model");
  const expectedNames = JSON.parse(option("--header-names") ?? "[]");
  if (separator < 0 || !home || !baseUrl || !defaultModel || !cli[0]) throw new Error("Provider launch is incomplete");
  if (!Array.isArray(expectedNames) || expectedNames.some((name) => typeof name !== "string")) throw new Error("Provider launch is incomplete");
  const sessionFlag = cli.findIndex((value) => value === "--session-id" || value === "--resume");
  const sessionId = sessionFlag >= 0 ? cli[sessionFlag + 1] : null;
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Provider session is invalid");
  const token = privateText(path.join(home, ".provider-token"), 4096);
  if (token.length < 8 || /[\r\n\u0000]/.test(token)) throw new Error("Provider account requires repair");
  let headers = {};
  try { headers = JSON.parse(privateText(path.join(home, ".provider-headers"), 70_000)); }
  catch (error) { if (error?.code !== "ENOENT" || expectedNames.length) throw new Error("Provider account requires repair"); }
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.entries(headers).some(([name, value]) =>
    !/^[a-z][a-z0-9-]{0,63}$/i.test(name) || typeof value !== "string" || value.length < 8 || /[\r\n\u0000-\u001f\u007f]/.test(value)
    || ["authorization", "x-api-key", "host", "x-opencode-session", "user-agent", "connection", "transfer-encoding", "content-length"].includes(name.toLowerCase()))
    || Object.keys(headers).length !== expectedNames.length || expectedNames.some((name) => headers[name.toLowerCase()] === undefined)) {
    throw new Error("Provider account requires repair");
  }
  const runtime = JSON.parse(privateText(path.join(home, ".provider-runtime"), 100_000));
  if (!runtime || typeof runtime !== "object" || !runtime.config || runtime.config.baseUrl !== baseUrl
    || runtime.config.model !== defaultModel || (runtime.config.smallFastModel ?? "") !== (smallModel ?? "")
    || runtime.token !== token || JSON.stringify(runtime.config.customHeaderNames ?? []) !== JSON.stringify(expectedNames)
    || !runtime.headers || typeof runtime.headers !== "object" || Array.isArray(runtime.headers)
    || Object.keys(runtime.headers).length !== Object.keys(headers).length
    || Object.entries(headers).some(([name, value]) => runtime.headers[name] !== value)) {
    throw new Error("Provider account requires repair");
  }
  const relay = await startClaudeProviderRelay({ baseUrl: runtime.config.baseUrl, token: runtime.token, headers: runtime.headers, sessionId });
  try {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: relay.baseUrl, ANTHROPIC_AUTH_TOKEN: relay.alias };
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"]) delete env[name];
    if (smallModel) env.ANTHROPIC_SMALL_FAST_MODEL = smallModel;
    else delete env.ANTHROPIC_SMALL_FAST_MODEL;
    const modelFlag = cli.indexOf("--model");
    if (modelFlag >= 0 && cli[modelFlag + 1]) {
      if (![runtime.config.model, runtime.config.smallFastModel].includes(cli[modelFlag + 1])) throw new Error("Provider model changed");
      env.ANTHROPIC_MODEL = cli[modelFlag + 1];
    }
    const child = spawn(cli[0], [...cli.slice(1), "--setting-sources", ""], { env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => { if (!child.killed) child.kill(signal); });
    await new Promise((resolve) => {
      let failed = false;
      child.on("error", () => { failed = true; });
      child.on("close", (code, signal) => { process.exitCode = failed ? 1 : code ?? (signal ? 1 : 0); resolve(); });
    });
  } finally { relay.close(); }
}

try { await main(); }
catch { process.stderr.write("Claude provider launch failed; check this account's configuration.\n"); process.exitCode = 1; }
