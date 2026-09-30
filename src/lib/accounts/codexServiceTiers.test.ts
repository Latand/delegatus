import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexLaunchTier, codexModelServiceTiers, tierOffers } from "./codexServiceTiers";

test("catalog tiers are per account and never inferred from speed hints", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tier-catalog-"));
  try {
    const accounts = ["account-a", "account-b", "account-c"].map((id, i) => {
      const home = path.join(root, id); fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra", additional_speed_tiers: ["ultrafast"], service_tiers: [{ id: "priority", name: "Fast" }, ...(i === 2 ? [{ id: "ultrafast", name: "Ultrafast" }] : [])] }] }));
      return { id, home };
    });
    expect(tierOffers(accounts, "gpt-6-astra", "ultrafast")).toEqual({ offering: ["account-c"], lacking: ["account-a", "account-b"], offered: ["priority", "ultrafast"] });
    expect(codexModelServiceTiers(accounts[0]!.home, "missing")).toBeNull();
    expect(codexModelServiceTiers(root, "gpt-6-astra")).toBeNull();
    fs.writeFileSync(path.join(root, "models_cache.json"), "invalid");
    expect(codexModelServiceTiers(root, "gpt-6-astra")).toBeNull();
    expect(tierOffers(accounts, "gpt-6-astra", "default").offering).toHaveLength(3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit tiers, fast compatibility and role preference resolution", () => {
  const input = { engine: "codex" as const, model: "gpt-6-astra", fast: undefined, serviceTier: undefined, roleDefault: "ultrafast", roleDefaultApplies: true };
  expect(codexLaunchTier(input)).toEqual({ tier: "ultrafast", required: false, source: "role-default" });
  expect(codexLaunchTier({ ...input, roleDefaultApplies: false })).toMatchObject({ tier: null });
  expect(codexLaunchTier({ ...input, fast: true })).toEqual({ tier: "priority", required: true, source: "fast" });
  expect(codexLaunchTier({ ...input, fast: false })).toMatchObject({ tier: null });
  expect(codexLaunchTier({ ...input, fast: true, serviceTier: "priority" })).toMatchObject({ tier: "priority", required: true });
  for (const serviceTier of ["ultrafast", "default"]) expect(codexLaunchTier({ ...input, fast: true, serviceTier })).toHaveProperty("error");
  expect(codexLaunchTier({ ...input, fast: false, serviceTier: "ultrafast" })).toHaveProperty("error");
  for (const serviceTier of ["default", "standard"]) expect(codexLaunchTier({ ...input, fast: false, serviceTier })).toMatchObject({ tier: serviceTier, required: true });
  for (const serviceTier of [false, "", "bad tier"]) expect(codexLaunchTier({ ...input, serviceTier })).toHaveProperty("error");
  expect(codexLaunchTier({ ...input, engine: "claude", serviceTier: "ultrafast" })).toHaveProperty("error");
  expect(codexLaunchTier({ ...input, model: null, serviceTier: "ultrafast" })).toHaveProperty("error");
});
