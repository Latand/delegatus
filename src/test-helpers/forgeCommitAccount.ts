import path from "node:path";
import { stateDir } from "@/lib/configDir";
import { ownerNoreplyAddress } from "@/lib/git/forgeCommitAccount";
import { writeJsonDurably } from "@/lib/state/durableJson";

export const fixtureForgeAccount = { id: 1042, login: "fixture-lane" };
export const fixtureNoreply = ownerNoreplyAddress(fixtureForgeAccount);

export function seedForgeCommitAccount(directory = stateDir(), at = Date.parse("2026-11-25T16:10:00Z")): void {
  writeJsonDurably(path.join(directory, "forge-commit-account.json"), {
    schemaVersion: 1, host: "github.com", ...fixtureForgeAccount, resolvedAt: at, checkedAt: at,
  });
}
