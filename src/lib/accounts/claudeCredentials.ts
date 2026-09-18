import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ClaudeCredentialDocument = Record<string, unknown> & {
  claudeAiOauth?: Record<string, unknown>;
};
export type ClaudeCredentialRead =
  | { state: "present"; source: "file" | "keychain"; document: ClaudeCredentialDocument }
  | { state: "absent" | "unknown" | "unsafe" };

type CommandResult = { status: number | null; stdout: string };
export interface ClaudeCredentialPorts {
  platform: string;
  security(args: string[], input?: string): CommandResult;
}

const productionPorts: ClaudeCredentialPorts = {
  platform: process.platform,
  security: (args, input) => {
    const result = spawnSync("/usr/bin/security", args, {
      input, encoding: "utf8", timeout: 2_000, maxBuffer: 1024 * 1024,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    // Never propagate stderr or a subprocess error: they can contain secrets.
    return { status: result.error ? null : result.status, stdout: result.stdout ?? "" };
  },
};

/** Viewer always launches Claude with an explicit CLAUDE_CONFIG_DIR. The
 * provider hashes its NFC-normalized spelling, including the default home.
 * Verified in the published @anthropic-ai/claude-code 2.1.69 and 2.1.263;
 * macOS CI also asks the real provider to recognize the synthetic store. */
export function claudeKeychainService(home: string): string {
  const suffix = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
  const hash = crypto.createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code${suffix}-credentials-${hash}`;
}

function keychainAccount(): string {
  let user: string;
  try { user = process.env.USER || os.userInfo().username; } catch { user = "claude-code-user"; }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : "claude-code-user";
}

export function claudeCredentialFileState(home: string): "safe" | "absent" | "unsafe" | "unknown" {
  try {
    const stat = fs.lstatSync(path.join(home, ".credentials.json"));
    return stat.isFile() && !stat.isSymbolicLink()
      && stat.uid === (process.getuid?.() ?? stat.uid) && (stat.mode & 0o077) === 0 ? "safe" : "unsafe";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown";
  }
}

function parseDocument(text: string, source: "file" | "keychain"): ClaudeCredentialRead {
  try {
    const document: unknown = JSON.parse(text);
    if (!document || typeof document !== "object" || Array.isArray(document)) return { state: "unknown" };
    const parsed = document as ClaudeCredentialDocument;
    if (source === "keychain" && (typeof parsed.claudeAiOauth?.accessToken !== "string" || !parsed.claudeAiOauth.accessToken)) return { state: "unknown" };
    return { state: "present", source, document: parsed };
  } catch { return { state: "unknown" }; }
}

export function readClaudeCredentials(home: string, ports = productionPorts): ClaudeCredentialRead {
  const fileState = claudeCredentialFileState(home);
  // An unsafe file remains a failed ownership fence even if Keychain works.
  if (fileState === "unsafe" || fileState === "unknown") return { state: fileState };
  if (ports.platform === "darwin") {
    const result = ports.security(["find-generic-password", "-a", keychainAccount(), "-w", "-s", claudeKeychainService(home)]);
    if (result.status === 0) return parseDocument(result.stdout.trim(), "keychain");
    // Only errSecItemNotFound proves absence. Locked, denied, and timeout are
    // unknown; do not substitute a different account or a stale file for them.
    if (result.status !== 44) return { state: "unknown" };
  }
  if (fileState === "absent") return { state: "absent" };
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(home, ".credentials.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== (process.getuid?.() ?? stat.uid) || (stat.mode & 0o077) !== 0) return { state: "unsafe" };
    return parseDocument(fs.readFileSync(fd, "utf8"), "file");
  } catch { return { state: "unknown" }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Store rotation in the same backend that supplied it. Never export Keychain
 * content to a file or put a token in process arguments. The caller owns the
 * account mutation and provider refresh locks across the network request. */
export function replaceClaudeCredentials(
  home: string,
  expected: Extract<ClaudeCredentialRead, { state: "present" }>,
  document: ClaudeCredentialDocument,
  ports = productionPorts,
): boolean {
  const current = readClaudeCredentials(home, ports);
  if (current.state !== "present" || current.source !== expected.source
    || JSON.stringify(current.document) !== JSON.stringify(expected.document)) return false;
  const text = JSON.stringify(document);
  if (expected.source === "keychain") {
    const command = `add-generic-password -U -a "${keychainAccount()}" -s "${claudeKeychainService(home)}" -X "${Buffer.from(text).toString("hex")}"\n`;
    // security -i has a bounded input line. Fail closed instead of the CLI's
    // large-payload argv fallback, which would expose the token to ps.
    if (Buffer.byteLength(command) > 4032) return false;
    if (ports.security(["-i"], command).status !== 0) return false;
    const verified = readClaudeCredentials(home, ports);
    return verified.state === "present" && verified.source === "keychain"
      && JSON.stringify(verified.document) === text;
  }
  const file = path.join(home, ".credentials.json");
  const temporary = path.join(home, `.credentials.${crypto.randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (claudeCredentialFileState(home) !== "safe") return false;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(home, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    return true;
  } catch { return false; }
  finally { fs.rmSync(temporary, { force: true }); }
}
