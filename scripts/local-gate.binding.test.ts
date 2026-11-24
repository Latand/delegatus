import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createPublicationFixtures } from "./publicationHook.fixture";
import { PUBLICATION_TRANSPORT_MS, publicationCheckBinding, readPublicationCheckReceipt, writePublicationCheckReceipt } from "../src/lib/git/publicationCheckReceipt";

const root = path.resolve(import.meta.dir, "..");
const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const { fixture } = createPublicationFixtures(root, roots);

test.each(["head", "base", "source", "config", "environment", "tool", "operation", "epoch", "authority", "privacy", "privacy-path", "destination"])("a changed %s refuses a prepared operation", kind => {
  const f = fixture();
  if (kind === "environment") f.env.LANG = "en_US.UTF-8";
  if (kind === "privacy-path") {
    f.env.LLV_PRIVACY_KNOWN_VALUES_FILE = path.join(f.dir, ".git", "known.json");
    fs.writeFileSync(f.env.LLV_PRIVACY_KNOWN_VALUES_FILE, "[]");
  }
  const prepared = f.run(true); expect(prepared.status, prepared.stderr).toBe(0);
  const extra: Partial<NodeJS.ProcessEnv> = {};
  if (kind === "head") { f.git("-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "moved head"); }
  if (kind === "base") f.git("update-ref", "refs/remotes/origin/main", f.head);
  if (kind === "source") fs.writeFileSync(path.join(f.dir, "example.ts"), "export const value = 3;\n");
  if (kind === "config") f.git("config", "delegatus.checks", "local");
  if (kind === "environment") extra.LANG = "C";
  if (kind === "tool") fs.appendFileSync(path.join(f.dir, "shims", "bunx"), "# changed executable\n");
  if (kind === "operation") extra.LLV_GATE_PUBLICATION_ID = "operation-two";
  if (kind === "epoch") extra.LLV_GATE_PUBLICATION_EPOCH = "2";
  if (kind === "authority") extra.LLV_GATE_PUBLICATION_FENCE = "custody-two";
  if (kind === "privacy") extra.LLV_PRIVACY_KNOWN_VALUES = "fixture-only private label";
  if (kind === "privacy-path") {
    extra.LLV_PRIVACY_KNOWN_VALUES_FILE = path.join(f.dir, ".git", "other-known.json");
    fs.writeFileSync(extra.LLV_PRIVACY_KNOWN_VALUES_FILE, "[]");
  }
  if (kind === "destination") extra.LLV_GATE_PUBLICATION_REF = "refs/heads/other";
  const before = f.calls().length;
  const refused = f.run(false, extra);
  expect(refused.status, refused.stderr).not.toBe(0);
  expect(f.calls().slice(before)).toHaveLength(0);
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

test("publication receipt records check duration and peak RSS and rejects invalid values", () => {
  const f = fixture();
  const binding = publicationCheckBinding(f.env);
  writePublicationCheckReceipt(f.receipt, binding, "a".repeat(64), undefined, 0, 4096);
  expect(readPublicationCheckReceipt(f.receipt, binding)).toMatchObject({ checksMs: 0, peakRssBytes: 4096 });
  fs.rmSync(f.receipt);
  expect(() => writePublicationCheckReceipt(f.receipt, binding, "a".repeat(64), undefined, -1))
    .toThrow("publication check receipt timing is invalid");
  expect(() => writePublicationCheckReceipt(f.receipt, binding, "a".repeat(64), undefined, 0, -1))
    .toThrow("publication check receipt peak RSS is invalid");
  fs.writeFileSync(f.receipt, JSON.stringify({ version: 1, binding, inputs: "a".repeat(64), completedAt: Date.now(), checksMs: -1 }), { mode: 0o600 });
  expect(() => readPublicationCheckReceipt(f.receipt, binding)).toThrow("stale or belongs to another operation");
  fs.writeFileSync(f.receipt, JSON.stringify({ version: 1, binding, inputs: "a".repeat(64), completedAt: Date.now(), checksMs: 0, peakRssBytes: -1 }));
  expect(() => readPublicationCheckReceipt(f.receipt, binding)).toThrow("publication check receipt peak RSS is invalid");
});

test("transport input validation retains a named deadline refusal", () => {
  const f = fixture();
  expect(f.run(true).status).toBe(0);
  const result = f.run(false, { LLV_GATE_PUSH_DEADLINE: String(Date.now() - 1) });
  expect(result.status).toBe(75);
  expect(result.stderr).toContain('no verdict within the push budget');
  expect(result.stderr).toContain('"publication input validation"');
});
