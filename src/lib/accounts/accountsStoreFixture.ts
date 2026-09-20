import { readStateCollectionRows } from "@/lib/state/sqliteStateStore";

import {
  accountsDatabasePath,
  accountsStateDirectory,
  ACCOUNTS_COLLECTION,
  CLAUDE_ACCOUNTS_SOURCE,
  CODEX_ACCOUNTS_SOURCE,
  CODEX_LOGIN_SOURCE,
  clearAccountSource,
  readAccountSource,
  writeAccountSource,
  type AccountSourceName,
} from "./accountsStore";

/* Test fixtures for the SQLite account store (#1870, slice 7). Tests that used
   to read or write `claude-accounts.json` and `codex-accounts.json` to prove
   what was persisted read and write these instead: the rows exactly as stored,
   through the same collection the product reads. */

export interface PersistedRegistry {
  version?: number;
  active?: string;
  accounts: { id: string; label?: string }[];
  retired: { id: string; label?: string; archived?: boolean }[];
  removals?: { id: string; phase?: string }[];
}

function source(engine: "claude" | "codex") {
  return engine === "claude" ? CLAUDE_ACCOUNTS_SOURCE : CODEX_ACCOUNTS_SOURCE;
}

/** One engine's registry, in the shape its legacy file held. */
export function persistedAccountRegistry(engine: "claude" | "codex", directory = accountsStateDirectory()): PersistedRegistry {
  const read = readAccountSource(source(engine), directory);
  const body = (read.kind === "collection" ? read.body : undefined) as Partial<PersistedRegistry> | undefined;
  return { ...body, accounts: body?.accounts ?? [], retired: body?.retired ?? [] };
}

/** Replace one engine's registry, the way a legacy fixture wrote its file. */
export function seedAccountRegistry(engine: "claude" | "codex", body: unknown, directory = accountsStateDirectory()): void {
  writeAccountSource(source(engine), body, directory);
}

/** Every persisted account row, exactly as stored, in row order. */
export function persistedAccountRows(directory = accountsStateDirectory()): { k: string; v: unknown }[] {
  return (readStateCollectionRows(accountsDatabasePath(directory), ACCOUNTS_COLLECTION) ?? []) as { k: string; v: unknown }[];
}

/** The persisted account state as one comparable string: the successor of
    comparing the bytes of a registry file to prove a refusal wrote nothing. */
export function persistedAccountState(directory = accountsStateDirectory()): string {
  return JSON.stringify(persistedAccountRows(directory));
}

/** Replace one account store, the way a legacy fixture wrote its JSON file.
    Named for what fixtures do with it rather than for the collection, so a
    test reads as "this is what was on record". */
export function seedAccountSource(name: AccountSourceName, body: unknown, directory = accountsStateDirectory()): void {
  writeAccountSource(name, body, directory);
}

/** One account store as the collection holds it, in its legacy body shape. */
export function persistedAccountSource(name: AccountSourceName, directory = accountsStateDirectory()): unknown {
  const read = readAccountSource(name, directory);
  return read.kind === "collection" ? read.body : undefined;
}

/** Leave an account store holding nothing, the way removing its legacy file
    left it. */
export function clearAccountFixture(name: AccountSourceName, directory = accountsStateDirectory()): void {
  clearAccountSource(name, directory);
}

/** The Codex device-login attempts on record, for a store rooted at
    `directory` (the state directory a `ManagedCodexRuntime` was given). */
export function persistedCodexLoginAttempts(directory: string): Record<string, { state?: string }> {
  const body = persistedAccountSource(CODEX_LOGIN_SOURCE, directory) as { attempts?: Record<string, { state?: string }> } | undefined;
  return body?.attempts ?? {};
}
