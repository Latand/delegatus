import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexServiceTierRefusal, codexLaunchTier, codexModelServiceTiers, fastestTier, raisesTier, tierOffers } from "./codexServiceTiers";

test("explicit catalogue tiers are authoritative per account", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tier-catalog-"));
  try {
    const accounts = ["account-a", "account-b", "account-c"].map((id, i) => {
      const home = path.join(root, id); fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-astra", additional_speed_tiers: ["ultrafast"], service_tiers: [{ id: "priority", name: "Fast" }, ...(i === 2 ? [{ id: "ultrafast", name: "Ultrafast" }] : [])] }] }));
      return { id, home };
    });
    expect(tierOffers(accounts, "gpt-6-astra", "ultrafast")).toEqual({ offering: ["account-c"], lacking: ["account-a", "account-b"], offered: ["priority", "ultrafast"] });
    expect(codexModelServiceTiers(accounts[0]!.home, "missing")).toBeNull();
    fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models: [{
      slug: "gpt-6.1-sol", service_tiers: [], additional_speed_tiers: ["ultrafast"],
    }] }));
    expect(codexModelServiceTiers(root, "gpt-6.1-sol")).toEqual([]);
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

test("Turbo's fastest tier per account catalog: ultrafast, else priority, else none", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tier-fastest-"));
  try {
    const home = (id: string, rows: unknown[]) => {
      const dir = path.join(root, id); fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "models_cache.json"), JSON.stringify({ models: rows }));
      return dir;
    };
    // Account A lists ultrafast only for Sol and Astra; B and C only priority; D lists no tiers.
    const a = home("a", [
      { slug: "gpt-6.1-sol", service_tiers: [{ id: "priority" }, { id: "ultrafast" }] },
      { slug: "gpt-6-luna", service_tiers: [{ id: "priority" }] },
    ]);
    const b = home("b", [{ slug: "gpt-6.1-sol", service_tiers: [{ id: "priority" }] }, { slug: "gpt-daybreak-blue-latest", service_tiers: [] }]);
    expect(fastestTier(a, "gpt-6.1-sol")).toBe("ultrafast");
    expect(fastestTier(a, "gpt-6-luna")).toBe("priority");
    expect(fastestTier(b, "gpt-6.1-sol")).toBe("priority");
    expect(fastestTier(b, "gpt-daybreak-blue-latest")).toBeNull();
    expect(fastestTier(b, "unlisted")).toBeNull();
    expect(fastestTier(path.join(root, "missing"), "gpt-6.1-sol")).toBeNull();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Turbo only raises: tier order flex < default < priority < ultrafast, unknown ids left alone", () => {
  expect(raisesTier(null, "priority")).toBe(true);
  expect(raisesTier("default", "priority")).toBe(true);
  expect(raisesTier("standard", "ultrafast")).toBe(true);
  expect(raisesTier("flex", "priority")).toBe(true);
  expect(raisesTier("priority", "ultrafast")).toBe(true);
  expect(raisesTier("priority", "priority")).toBe(false);
  expect(raisesTier("ultrafast", "priority")).toBe(false);
  expect(raisesTier("scale", "ultrafast")).toBe(false);
});


test("refusal diagnostics preserve per-account model evidence and scope", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tier-refusal-"));
  try {
    const accounts = ["account-a", "account-b"].map(id => {
      const home = path.join(root, id); fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
        { slug: "gpt-6-luna", service_tiers: [{ id: "priority" }] },
        { slug: "gpt-6-astra", service_tiers: [{ id: "ultrafast" }] },
        { slug: "gpt-6.1-sol", service_tiers: [{ id: "ultrafast" }] },
      ] }));
      return { id, label: id === "account-a" ? "account A" : "account B", home };
    });
    const message = codexServiceTierRefusal(accounts, "gpt-6-luna", "ultrafast");
    expect(message).toContain("serviceTier ultrafast for model gpt-6-luna; evaluated allowed accounts");
    for (const account of accounts) expect(message).toContain(`account "${account.label}" (${account.id}): gpt-6-luna offered: priority; ultrafast offered for other models on this account: gpt-6-astra, gpt-6.1-sol`);
    const pinned = codexServiceTierRefusal([accounts[0]!], "gpt-6-luna", "ultrafast", "account-a");
    expect(pinned).toContain('evaluated pinned account "account-a"');
    expect(pinned).not.toContain("account-b");
    expect(codexServiceTierRefusal(accounts, "missing", "ultrafast")).toContain("missing offered: unknown (catalog unavailable)");
    expect(codexServiceTierRefusal([], "gpt-6-luna", "ultrafast", "unknown-account")).toContain('pinned account "unknown-account": none');
    fs.writeFileSync(path.join(root, "models_cache.json"), "invalid");
    expect(codexServiceTierRefusal([{ id: "account-c", home: root }], "gpt-6-luna", "ultrafast")).toContain("catalog unavailable");
    expect(tierOffers(accounts, "gpt-6-astra", "ultrafast").offering).toEqual(["account-a", "account-b"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy cache speed tiers supply explicit launch tier ids when service tiers are absent", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-tiers-"));
  try {
    fs.writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({ models: [
      { slug: "gpt-6.1-sol", additional_speed_tiers: ["fast", "ultrafast", "unknown"] },
    ] }));
    expect(codexModelServiceTiers(home, "gpt-6.1-sol")).toEqual([
      { id: "priority", name: "priority" }, { id: "ultrafast", name: "ultrafast" },
    ]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test("inherited launch tiers are preferences and explicit speed still wins", () => {
  const input = { engine: "codex" as const, model: "gpt-6.1-sol", fast: undefined, serviceTier: undefined,
    inheritedServiceTier: "ultrafast", roleDefault: "priority", roleDefaultApplies: true };
  expect(codexLaunchTier(input)).toEqual({ tier: "ultrafast", required: false, source: "inherited" });
  expect(codexLaunchTier({ ...input, serviceTier: "priority" })).toEqual({ tier: "priority", required: true, source: "explicit" });
  expect(codexLaunchTier({ ...input, fast: true })).toEqual({ tier: "priority", required: true, source: "fast" });
  expect(codexLaunchTier({ ...input, fast: false })).toMatchObject({ tier: null });
  expect(codexLaunchTier({ ...input, inheritedServiceTier: "bad tier" })).toHaveProperty("error");
  expect(codexLaunchTier({ ...input, engine: "claude" })).toHaveProperty("error");
});
