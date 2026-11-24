import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  activeAntigravityAccountId,
  ANTIGRAVITY_DEFAULT_ACCOUNT_ID,
  antigravityAccountForSpawn,
  antigravityHomeOwningSessionPath,
  listAntigravityAccounts,
  readAntigravityAuthState,
  recordAntigravityAuthState,
  UnknownAntigravityAccountError,
} from "./antigravity";

describe("accounts/antigravity", () => {
  let root: string;
  let stateDir: string;
  let prevStateDir: string | undefined;
  let prevOwner: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-acct-"));
    stateDir = path.join(root, "state");
    prevStateDir = process.env.LLV_STATE_DIR;
    prevOwner = process.env.LLV_STATE_OWNER;
    process.env.LLV_STATE_DIR = stateDir;
    process.env.LLV_STATE_OWNER = "test";
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = prevStateDir;
    if (prevOwner === undefined) delete process.env.LLV_STATE_OWNER;
    else process.env.LLV_STATE_OWNER = prevOwner;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves the default Antigravity account and rejects unknown ids", () => {
    expect(activeAntigravityAccountId()).toBe(ANTIGRAVITY_DEFAULT_ACCOUNT_ID);
    const context = antigravityAccountForSpawn(null);
    expect(context.engine).toBe("antigravity");
    expect(context.accountId).toBe("default");
    expect(context.transcriptRoot).toBe(path.join(context.home, "sessions"));
    expect(() => antigravityAccountForSpawn("other-account")).toThrow(UnknownAntigravityAccountError);
  });

  it("persists auth/tier metadata atomically, isolates caller mutations, and handles concurrent writes", async () => {
    expect(readAntigravityAuthState()).toBeNull();
    expect(listAntigravityAccounts()[0]?.auth).toBe("unknown");

    recordAntigravityAuthState({
      authenticated: true,
      tierName: "Google AI Pro",
      tierId: "g1-pro-tier",
      checkedAt: "2026-11-20T18:00:00.000Z",
    });

    const first = readAntigravityAuthState()!;
    expect(first.authenticated).toBe(true);
    expect(first.tierName).toBe("Google AI Pro");
    first.tierName = "MUTATED";
    first.authenticated = false;

    const second = readAntigravityAuthState()!;
    expect(second.authenticated).toBe(true);
    expect(second.tierName).toBe("Google AI Pro");
    expect(listAntigravityAccounts()[0]?.auth).toBe("signed_in");

    await Promise.all(Array.from({ length: 10 }, (_, idx) => Promise.resolve().then(() => {
      recordAntigravityAuthState({
        authenticated: true,
        tierName: `Tier ${idx}`,
        tierId: `tier-${idx}`,
        checkedAt: `2026-11-20T18:00:0${idx}.000Z`,
      });
    })));
    expect(readAntigravityAuthState()?.authenticated).toBe(true);
  });

  it("maps session paths inside the default Antigravity sessions root to the owning home", () => {
    const context = antigravityAccountForSpawn("default");
    const sessionPath = path.join(context.transcriptRoot, crypto.randomUUID(), "events.jsonl");
    expect(antigravityHomeOwningSessionPath(sessionPath)).toBe(context.home);
    expect(antigravityHomeOwningSessionPath(path.join(root, "other", "events.jsonl"))).toBeNull();
  });
});
