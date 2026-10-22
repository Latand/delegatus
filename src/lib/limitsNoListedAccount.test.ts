import * as headlessCli from "@/lib/agent/claudeHeadless";
import { setSubscriptionApiConsent } from "@/lib/accounts/subscriptionApiConsent";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* Task d7759de2: once Main is removed and no other account is listed, an
   engine has no account to read. The limits footer still answers for every
   other engine, and the emptied one answers no reading. */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-limits-no-account-test-"));
const OLD_ENV = {
  LLV_STATE_DIR: process.env.LLV_STATE_DIR,
  LLV_CODEX_HOME: process.env.LLV_CODEX_HOME,
  LLV_CLAUDE_HOME: process.env.LLV_CLAUDE_HOME,
};
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
setSubscriptionApiConsent(true);
const cliFallback = spyOn(headlessCli, "runHeadlessClaudeOnce").mockResolvedValue({ status: "failed", records: [] });

process.env.LLV_CODEX_HOME = path.join(SANDBOX, "legacy-codex");
process.env.LLV_CLAUDE_HOME = path.join(SANDBOX, "legacy-claude");
fs.mkdirSync(process.env.LLV_CLAUDE_HOME, { recursive: true });
fs.writeFileSync(path.join(process.env.LLV_CLAUDE_HOME, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token", subscriptionType: "max" } }), { mode: 0o600 });

const { hideLegacyCodexAccount, restoreLegacyCodexAccount } = await import("@/lib/accounts/codex");
const { hideLegacyClaudeAccount, restoreLegacyClaudeAccount } = await import("@/lib/accounts/claude");
const { readBurndown, readLimits } = await import("./limits");
const limitsRoute = await import("@/app/api/limits/route");
const historyRoute = await import("@/app/api/limits/history/route");

afterAll(() => {
  cliFallback.mockRestore();
  for (const [key, value] of Object.entries(OLD_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function resetLimitsCache(): void {
  delete (globalThis as { __llvLimitsCache?: unknown }).__llvLimitsCache;
  delete (globalThis as { __llvLimitsInflight?: unknown }).__llvLimitsInflight;
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "limits-cache.json"), { force: true });
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  resetLimitsCache();
});

const codexLiveReader = async () => ({
  primary: { usedPercent: 12, resetsAt: 4_102_444_800, windowDurationMins: 300 },
  secondary: null,
  planType: "pro",
});

function stubClaudeProvider() {
  const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
  return spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({
    five_hour: { utilization: 30, resets_at: resetsAt },
    seven_day: { utilization: 40, resets_at: resetsAt },
  })) as unknown as typeof fetch);
}

test("with Codex Main removed and no Codex account left, /api/limits and its history still answer Claude", async () => {
  resetLimitsCache();
  hideLegacyCodexAccount();
  restore = restoreLegacyCodexAccount;
  const request = stubClaudeProvider();
  try {
    const response = await limitsRoute.GET();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.codex).toBeNull();
    expect(payload.codexAccountId).toBeNull();
    expect(payload.provenance.codex.source).toBe("unavailable");
    expect(payload.claudeAccountId).toBe("default");
    expect(payload.claude?.session?.usedPercent).toBe(30);

    const history = await historyRoute.GET();
    expect(history.status).toBe(200);
    const burndown = await history.json();
    expect(burndown.codex).toBeNull();
    expect(burndown.codexAccountId).toBeNull();
    expect(burndown.claudeAccountId).toBe("default");
    expect(burndown.claude).not.toBeNull();
  } finally {
    request.mockRestore();
  }
});

test("with Claude Main removed and no Claude account left, limits and burndown still answer Codex", async () => {
  resetLimitsCache();
  hideLegacyClaudeAccount();
  restore = restoreLegacyClaudeAccount;
  const request = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("no Claude account is listed, so nothing may ask the provider");
  }) as unknown as typeof fetch);
  try {
    const payload = await readLimits({ codexLiveReader });
    expect(payload.claude).toBeNull();
    expect(payload.claudeAccountId).toBeNull();
    expect(payload.provenance.claude.source).toBe("unavailable");
    expect(payload.codexAccountId).toBe("default");
    expect(payload.codex?.session?.usedPercent).toBe(12);

    const burndown = await readBurndown({ codexLiveReader });
    expect(burndown.claude).toBeNull();
    expect(burndown.claudeAccountId).toBeNull();
    expect(burndown.codexAccountId).toBe("default");
    expect(burndown.codex).not.toBeNull();
    expect(request).not.toHaveBeenCalled();
  } finally {
    request.mockRestore();
  }
});
