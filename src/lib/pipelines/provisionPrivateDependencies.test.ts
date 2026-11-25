import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePrivateDependencies, type PrivateInstallEffect, type PrivateInstallIntent, type PrivateInstallReceipt } from "./provisionPrivateDependencies";
import { stageWorktreeDependencyCopy } from "./worktreeDependencies";

test("a failed CoW request uses the staged ordinary copy and keeps the source private", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "provision-copy-"));
  try {
    const source = path.join(scratch, "source");
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, "tool"), "source", { mode: 0o755 });
    let permits = 0;
    const staged = await stageWorktreeDependencyCopy(source, scratch, async () => { permits++; }, async (from, to, flags) => {
      if (flags) throw Object.assign(new Error("clone unavailable"), { code: "ENOTSUP" });
      await fs.copyFile(from, to);
    });
    expect(permits).toBe(2);
    expect(staged).toBe(path.join(scratch, "copy"));
    expect((await fs.stat(path.join(staged!, "tool"))).mode & 0o111).toBe(0o111);
    await fs.writeFile(path.join(staged!, "tool"), "lane");
    expect(await fs.readFile(path.join(source, "tool"), "utf8")).toBe("source");
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
});

test.each(["enumeration", "process-identity", "expired"] as const)("private preparation stops before writes when the census reports %s", async reason => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-census-"));
  const source = path.join(root, "source"), checkout = path.join(root, "checkout");
  const effects: PrivateInstallEffect[] = [];
  const refusal = new Error("fixture legacy installer census refused");
  try {
    await fs.mkdir(source);
    await fs.mkdir(checkout);
    await expect(preparePrivateDependencies(source, checkout, "census-test-claim", undefined, undefined, 5_000, {
      async observeLegacy() { return { kind: "incomplete", reason }; },
      async beforeEffect(effect) { effects.push(effect); },
      async uncertain(observation) {
        expect(observation).toEqual({ kind: "incomplete", reason });
        throw refusal;
      },
      async receipt() { throw new Error("unexpected completion receipt"); },
      async intent() { throw new Error("unexpected install intent"); },
    })).rejects.toBe(refusal);
    expect(effects).toEqual([]);
    expect(await fs.readdir(checkout)).toEqual([]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a staged install marker reconciles after restart without dispatching a second installer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-receipt-recovery-"));
  try {
    const source = path.join(root, "source"), checkout = path.join(root, "checkout"), target = path.join(checkout, "node_modules");
    await fs.mkdir(source);
    await fs.mkdir(target, { recursive: true });
    const manifest = Buffer.from('{"name":"fixture-tools"}\n');
    const lock = Buffer.from('{"lockfileVersion":1}\n');
    await fs.writeFile(path.join(checkout, "package.json"), manifest);
    await fs.writeFile(path.join(checkout, "bun.lock"), lock);
    const inputs = createHash("sha256").update(JSON.stringify(["package.json", manifest.length])).update(manifest)
      .update(JSON.stringify(["bun.lock", lock.length])).update(lock).digest("hex");
    const identity = await fs.stat(target, { bigint: true });
    const nonce = "recovery-nonce";
    const nonceDigest = createHash("sha256").update(nonce).digest("hex");
    const claim = "recovery-claim";
    const priorIntent: PrivateInstallIntent = { claim, inputs, device: String(identity.dev), inode: String(identity.ino), nonceDigest };
    await fs.writeFile(path.join(target, ".delegatus-install-intent.json"), JSON.stringify({ claim, nonce }));
    await fs.writeFile(path.join(target, ".delegatus-install-receipt.json"), JSON.stringify({ claim, inputs, bun: Bun.version,
      device: priorIntent.device, inode: priorIntent.inode, mode: "staged", nonceDigest }));
    const effects: PrivateInstallEffect[] = [], receipts: PrivateInstallReceipt[] = [];
    expect(await preparePrivateDependencies(source, checkout, claim, undefined, priorIntent, 5_000, {
      async observeLegacy() { return { kind: "clear", observedAt: 1_000 }; },
      async beforeEffect(effect) { effects.push(effect); },
      async uncertain(cause) { throw new Error(JSON.stringify(cause)); },
      async receipt(value) { receipts.push(value); },
      async intent() { throw new Error("recovery must not create a new install intent"); },
    })).toBe(true);
    expect(effects).toEqual([]);
    expect(receipts).toEqual([{ claim, inputs, device: priorIntent.device, inode: priorIntent.inode, mode: "staged" }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const native = process.platform === "linux" || process.platform === "darwin" ? test : test.skip;
native.each(["empty", "populated"] as const)("copy publication preserves a late %s foreign directory", async foreign => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "provision-publish-"));
  try {
    const source = path.join(root, "source"), checkout = path.join(root, "checkout");
    const target = path.join(checkout, "node_modules");
    await fs.mkdir(path.join(source, "node_modules"), { recursive: true });
    await fs.mkdir(checkout);
    for (const directory of [source, checkout]) {
      await fs.writeFile(path.join(directory, "package.json"), '{"name":"fixture-tools"}');
      await fs.writeFile(path.join(directory, "package-lock.json"), '{"lockfileVersion":3}');
    }
    await fs.writeFile(path.join(source, "node_modules", "fixture"), "source");
    const effects: PrivateInstallEffect[] = [], receipts: PrivateInstallReceipt[] = [];
    let foreignInode: bigint | undefined;
    expect(await preparePrivateDependencies(source, checkout, "copy-test-claim", undefined, undefined, 5_000, {
      async observeLegacy() { return { kind: "clear", observedAt: 1_000 }; },
      async beforeEffect(effect) {
        effects.push(effect);
        if (effect !== "private-publish") return;
        await fs.mkdir(target);
        if (foreign === "populated") await fs.writeFile(path.join(target, "fixture"), "foreign");
        foreignInode = (await fs.stat(target, { bigint: true })).ino;
      },
      async uncertain(cause) { throw new Error(JSON.stringify(cause)); },
      async receipt(value) { receipts.push(value); },
      async intent() { throw new Error("unexpected install intent"); },
    })).toBe(false);
    expect(effects).toContain("private-publish");
    expect(effects).not.toContain("private-install");
    expect(receipts).toHaveLength(0);
    expect((await fs.stat(target, { bigint: true })).ino).toBe(foreignInode!);
    expect(await fs.readdir(target)).toEqual(foreign === "empty" ? [] : ["fixture"]);
    if (foreign === "populated") expect(await fs.readFile(path.join(target, "fixture"), "utf8")).toBe("foreign");
    expect(await fs.readFile(path.join(source, "node_modules", "fixture"), "utf8")).toBe("source");
    expect((await fs.readdir(checkout)).sort()).toEqual(["node_modules", "package-lock.json", "package.json"].sort());
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
