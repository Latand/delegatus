import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { PUBLICATION_TRANSPORT_MS, publicationCheckBinding, readPublicationCheckReceipt, writePublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture } = createPublicationFixtures(root, roots);

test("prepared checks are consumed once by a fresh native hook, with fresh privacy and no second admission", () => {
  const f = fixture();
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  const before = f.calls().length;
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
  expect(f.calls().slice(before).map(call => call.args[0])).toEqual(["scripts/privacy-publication-gate.ts"]);
  expect(hook.stderr).not.toContain("CPU admission");
  expect(fs.existsSync(f.receipt)).toBeFalse();
  expect(f.run(false).status).not.toBe(0);
}, 60_000);

test("prepared checks reach native transport when the caller already has Git's exec path", () => {
  const f = fixture();
  const execPath = f.git("--exec-path").toString().trim();
  f.env.PATH = `${execPath}${path.delimiter}${f.env.PATH ?? ""}`;
  const prepared = f.run(true);
  expect(prepared.status, prepared.stderr).toBe(0);
  const hook = f.run(false);
  expect(hook.status, hook.stderr).toBe(0);
  expect(fs.existsSync(f.receipt)).toBeFalse();
}, 60_000);

test("receipt deadlines, malformed records and missing custody fail closed", () => {
  const f = fixture();
  const binding = publicationCheckBinding(f.env);
  writePublicationCheckReceipt(f.receipt, binding, "a".repeat(64));
  const record = readPublicationCheckReceipt(f.receipt, binding);
  expect(() => readPublicationCheckReceipt(f.receipt, binding, record.completedAt + PUBLICATION_TRANSPORT_MS)).toThrow("stale");
  expect(() => readPublicationCheckReceipt(f.receipt, binding, record.completedAt - 1)).toThrow("stale");
  fs.writeFileSync(f.receipt, "{}");
  expect(() => readPublicationCheckReceipt(f.receipt, binding)).toThrow();
  expect(() => publicationCheckBinding({ ...f.env, LLV_GATE_PUBLICATION_EPOCH: undefined })).toThrow("incomplete");
});

test("receipt component hashes round trip and malformed component records refuse", () => {
  const f = fixture();
  const binding = publicationCheckBinding(f.env);
  const components = { head: "b".repeat(64), "privacy configuration": "c".repeat(64) };
  writePublicationCheckReceipt(f.receipt, binding, "a".repeat(64), components);
  const record = readPublicationCheckReceipt(f.receipt, binding);
  expect(record.components).toEqual(components);
  for (const invalid of [null, [], { head: "unhashed value" }, { HEAD: "b".repeat(64) }]) {
    fs.writeFileSync(f.receipt, JSON.stringify({ ...record, components: invalid }));
    expect(() => readPublicationCheckReceipt(f.receipt, binding, record.completedAt)).toThrow("components are invalid");
  }
  const refused = path.join(f.dir, ".git", "invalid-receipt.json");
  expect(() => writePublicationCheckReceipt(refused, binding, "a".repeat(64), { head: "unhashed value" })).toThrow("components are invalid");
  const large = Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`component ${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}`, "b".repeat(64)]));
  expect(() => writePublicationCheckReceipt(refused, binding, "a".repeat(64), large)).toThrow("size limit");
  expect(fs.existsSync(refused)).toBeFalse();
});

test("transport input validation retains a named deadline refusal", () => {
  const f = fixture();
  expect(f.run(true).status).toBe(0);
  const result = f.run(false, { LLV_GATE_PUSH_DEADLINE: String(Date.now() - 1) });
  expect(result.status).toBe(75);
  expect(result.stderr).toContain('no verdict within the push budget');
  expect(result.stderr).toContain('"publication input validation"');
});
