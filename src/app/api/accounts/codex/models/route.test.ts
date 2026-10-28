import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { createManagedCodexAccount } from "@/lib/accounts/codex";
import { bindAccountToProject } from "@/lib/accounts/projectBindings";
import { GET } from "./route";

let root: string | undefined;
const previous = { LLV_STATE_DIR: process.env.LLV_STATE_DIR, LLV_CODEX_HOME: process.env.LLV_CODEX_HOME };
afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test("tier catalog reports each allowed account's actual models and missing tier evidence", async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tier-catalog-"));
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.LLV_CODEX_HOME = path.join(root, "codex");
  fs.mkdirSync(process.env.LLV_CODEX_HOME, { recursive: true });
  const a = createManagedCodexAccount("Account A");
  const b = createManagedCodexAccount("Account B");
  fs.writeFileSync(path.join(a.home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", service_tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }] },
    { slug: "model-without-tiers" }, { slug: "model-with-no-tiers", service_tiers: [] },
  ] }));
  fs.writeFileSync(path.join(b.home, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", service_tiers: [{ id: "priority", name: "Fast" }] },
  ] }));
  const get = (query: string) => GET(new NextRequest(`http://localhost/api/accounts/codex/models?${query}`));
  const body = await (await get(`account=${a.id}`)).json();
  expect(body.accounts).toEqual([{ id: a.id, label: a.label, models: [
    { slug: "gpt-6.1-sol", tiers: [{ id: "priority", name: "Fast" }, { id: "ultrafast", name: "Ultrafast" }] },
    { slug: "model-without-tiers", tiers: null }, { slug: "model-with-no-tiers", tiers: [] },
  ] }]);
  expect(bindAccountToProject("codex", b.id, "catalog-project").ok).toBe(true);
  expect(await (await get("project=catalog-project")).json()).toEqual({ accounts: [{ id: b.id, label: b.label,
    models: [{ slug: "gpt-6.1-sol", tiers: [{ id: "priority", name: "Fast" }] }] }] });
  expect((await get(`project=catalog-project&account=${a.id}`)).status).toBe(404);
  expect((await get("account=missing-account")).status).toBe(404);
  fs.writeFileSync(path.join(b.home, "models_cache.json"), "invalid");
  expect(await (await get(`account=${b.id}`)).json()).toMatchObject({ accounts: [{ models: [] }] });
});
