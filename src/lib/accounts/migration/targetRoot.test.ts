import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountContext } from "@/lib/accounts/contracts";
import { sharedClaudeProjectsRoot } from "@/lib/accounts/claude";
import { sanitizeProviderError } from "./safeHistoryCopy";
import { validateMigrationTargetRoot } from "./targetRoot";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): AccountContext {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "migration-target-"));
  roots.push(home);
  return { engine: "codex", accountId: "target", kind: "managed", home, transcriptRoot: path.join(home, "sessions"), env: { NODE_ENV: "test" } };
}

test("admission allows a missing root without creating it; the provider creates it privately", async () => {
  const account = fixture();
  await validateMigrationTargetRoot(account);
  expect(fs.existsSync(account.transcriptRoot)).toBe(false);
  await validateMigrationTargetRoot(account, true);
  expect(fs.statSync(account.transcriptRoot).mode & 0o777).toBe(0o700);
});

for (const mode of [0o700, 0o755, 0o775, 0o777]) test(`target directory permissions ${mode.toString(8)}`, async () => {
  const account = fixture();
  fs.mkdirSync(account.transcriptRoot);
  fs.chmodSync(account.transcriptRoot, mode);
  if (mode & 0o022) {
    await expect(validateMigrationTargetRoot(account)).rejects.toThrow("target transcript root failed safety checks");
    await expect(validateMigrationTargetRoot(account, true)).rejects.toThrow("target transcript root failed safety checks");
  } else {
    await validateMigrationTargetRoot(account);
    await validateMigrationTargetRoot(account, true);
  }
  expect(fs.statSync(account.transcriptRoot).mode & 0o777).toBe(mode);
});

for (const hazard of ["writable-home", "file", "symlink", "outside-home"] as const) test(`refuses ${hazard} before creating a target root`, async () => {
  const account = fixture();
  if (hazard === "writable-home") fs.chmodSync(account.home, 0o775);
  if (hazard === "file") fs.writeFileSync(account.transcriptRoot, "fixture");
  if (hazard === "symlink") fs.symlinkSync(account.home, account.transcriptRoot);
  if (hazard === "outside-home") account.transcriptRoot = path.join(fixture().home, "sessions");
  await expect(validateMigrationTargetRoot(account)).rejects.toThrow();
  await expect(validateMigrationTargetRoot(account, true)).rejects.toThrow();
  if (hazard === "outside-home" || hazard === "writable-home") expect(fs.existsSync(account.transcriptRoot)).toBe(false);
});

test("the canonical shared Claude transcript directory keeps its exception", async () => {
  const account = fixture();
  account.engine = "claude";
  account.transcriptRoot = sharedClaudeProjectsRoot();
  // The explicit test command gives this suite its own state and config roots.
  fs.mkdirSync(account.transcriptRoot, { recursive: true, mode: 0o700 });
  await validateMigrationTargetRoot(account);
  await validateMigrationTargetRoot(account, true);
  account.engine = "codex";
  await expect(validateMigrationTargetRoot(account)).rejects.toThrow("outside its account home");
});

test("unreadable directories return repair guidance without disclosing paths", async () => {
  const account = fixture();
  account.home = path.join(account.home, "absent");
  try { await validateMigrationTargetRoot(account); throw new Error("expected refusal"); }
  catch (error) {
    const refusal = sanitizeProviderError(error);
    expect(refusal.code).toBe("target-account-unavailable");
    expect(refusal.message).toContain("repair");
    expect(refusal.message).not.toContain(account.home);
    expect(refusal.message).not.toContain("recoverable preflight");
  }
});
