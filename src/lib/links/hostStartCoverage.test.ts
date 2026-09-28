/**
 * Every call that opens an agent process on one of the three structured hosts
 * sits behind the TASK_RUNS_ELSEWHERE guard (docs/design/linked-installs.md
 * M.4). The list below names each call and the seam that guards it; a new
 * `start` or `adopt` anywhere else fails this test until it is guarded and
 * listed.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOSTS = ["CodexAppServerHost", "ClaudeStreamBrokerHost", "CopilotAcpHost"] as const;
const CALL = new RegExp(`\\b(${HOSTS.join("|")})\\s*\\.\\s*(start|adopt)\\b`, "g");

/** file → "Host.method" → how many calls, each with the seam that guards it. */
const GUARDED: Record<string, Record<string, number>> = {
  // Seam 2: every structured launch passes admitReservedLaunch / admitRecoveredLaunch first.
  "src/lib/runtime/structuredSpawn.ts": {
    "CopilotAcpHost.adopt": 1, "CopilotAcpHost.start": 1,
    "CodexAppServerHost.adopt": 1, "CodexAppServerHost.start": 1,
    "ClaudeStreamBrokerHost.adopt": 1, "ClaudeStreamBrokerHost.start": 1,
  },
  // Seam 4: boot adoption checks adoptionRefusal between the claim and adopt.
  // The two start wrappers have no caller outside tests.
  "src/lib/runtime/registry.ts": {
    "CodexAppServerHost.start": 1, "ClaudeStreamBrokerHost.start": 1,
    "CodexAppServerHost.adopt": 1, "ClaudeStreamBrokerHost.adopt": 1,
  },
  // Seam 5: the migration successor checks successorRefusal before its claim.
  "src/lib/accounts/migration/provider.ts": { "CodexAppServerHost.adopt": 1, "ClaudeStreamBrokerHost.adopt": 1 },
};
/* The classes' own files define start/adopt; they call their private open. */
const DEFINITIONS = new Set(["src/lib/runtime/codexAppServerHost.ts", "src/lib/runtime/claudeStreamBrokerHost.ts", "src/lib/runtime/copilotAcpHost.ts"]);

function sources(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== "node_modules" && entry.name !== "fixtures") walk(file); continue; }
      if (!/\.(ts|tsx|mts)$/.test(entry.name) || /\.test\.|\.browser\.test\.|[Ff]ixture/.test(entry.name)) continue;
      found.push(file);
    }
  };
  walk(path.join(root, "src"));
  return found;
}

/** Calls outside the guarded list, as `file: Host.method (n over m)`. */
function unguardedHostCalls(root: string): string[] {
  const seen = new Map<string, Map<string, number>>();
  for (const file of sources(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (DEFINITIONS.has(relative)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(CALL)) {
      const calls = seen.get(relative) ?? new Map<string, number>();
      calls.set(`${match[1]}.${match[2]}`, (calls.get(`${match[1]}.${match[2]}`) ?? 0) + 1);
      seen.set(relative, calls);
    }
  }
  const problems: string[] = [];
  for (const [file, calls] of seen) for (const [call, count] of calls) {
    const allowed = GUARDED[file]?.[call] ?? 0;
    if (count > allowed) problems.push(`${file}: ${call} (${count} over ${allowed})`);
  }
  return problems.sort();
}

const repository = path.resolve(import.meta.dir, "../../..");

test("every start or adopt of the three structured hosts is one the guard covers", () => {
  expect(unguardedHostCalls(repository)).toEqual([]);
  // The list is not stale: each listed call still exists.
  for (const [file, calls] of Object.entries(GUARDED)) {
    const text = fs.readFileSync(path.join(repository, file), "utf8");
    for (const [call, count] of Object.entries(calls)) {
      const [host, method] = call.split(".");
      expect([file, call, text.match(new RegExp(`\\b${host}\\s*\\.\\s*${method}\\b`, "g"))?.length ?? 0]).toEqual([file, call, count]);
    }
  }
});

test("the coverage check reports one new call per host outside the list", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-coverage-"));
  try {
    for (const file of [...Object.keys(GUARDED), ...DEFINITIONS]) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(repository, file), path.join(root, file));
    }
    expect(unguardedHostCalls(root)).toEqual([]);
    fs.mkdirSync(path.join(root, "src/lib/elsewhere"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/lib/elsewhere/newLaunch.ts"), [
      "export const a = () => CodexAppServerHost.start({});",
      "export const b = () => ClaudeStreamBrokerHost.adopt('s', {});",
      "export const c = () => CopilotAcpHost.start({});",
    ].join("\n"));
    expect(unguardedHostCalls(root)).toEqual([
      "src/lib/elsewhere/newLaunch.ts: ClaudeStreamBrokerHost.adopt (1 over 0)",
      "src/lib/elsewhere/newLaunch.ts: CodexAppServerHost.start (1 over 0)",
      "src/lib/elsewhere/newLaunch.ts: CopilotAcpHost.start (1 over 0)",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
