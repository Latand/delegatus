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

test("a legacy census that expires while install admission is held cannot create scratch or dispatch Bun", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-census-stale-permit-"));
  const source = path.join(root, "source"), checkout = path.join(root, "checkout");
  const effects: PrivateInstallEffect[] = [];
  let now = 1_000;
  const refusal = new Error("stale legacy installer census");
  try {
    await fs.mkdir(source);
    await fs.mkdir(checkout);
    await fs.writeFile(path.join(checkout, "package.json"), '{"name":"fixture-tools"}\n');
    await fs.writeFile(path.join(checkout, "bun.lock"), '{"lockfileVersion":1}\n');
    await expect(preparePrivateDependencies(source, checkout, "stale-census-claim", undefined, undefined, 5_000, {
      now: () => now,
      async observeLegacy() { return { kind: "clear", observedAt: 1_000 }; },
      async beforeEffect(effect) { effects.push(effect); now = 6_001; },
      async uncertain(observation) {
        expect(observation).toEqual({ kind: "incomplete", reason: "expired" });
        throw refusal;
      },
      async receipt() { throw new Error("stale census must not produce a receipt"); },
      async intent() { throw new Error("stale census must not produce an intent"); },
    })).rejects.toBe(refusal);
    expect(effects).toEqual(["private-scratch"]);
    expect((await fs.readdir(checkout)).sort()).toEqual(["bun.lock", "package.json"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("in-place installation refuses a directory replaced between creation and descriptor binding", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-in-place-race-"));
  try {
    const source = path.join(root, "source"), checkout = path.join(root, "checkout"), target = path.join(checkout, "node_modules");
    await fs.mkdir(source);
    await fs.mkdir(checkout);
    await fs.writeFile(path.join(checkout, "package.json"), '{"name":"fixture-tools","workspaces":["packages/*"]}\n');
    await fs.writeFile(path.join(checkout, "bun.lock"), '{"lockfileVersion":1}\n');
    const effects: PrivateInstallEffect[] = [];
    const sentinel = "preserve foreign install bytes\n";
    expect(await preparePrivateDependencies(source, checkout, "directory-race-claim", undefined, undefined, 5_000, {
      async observeLegacy() { return { kind: "clear", observedAt: Date.now() }; },
      workerEntry: path.resolve("src/lib/pipelines/provisionToolchain.worker.ts"),
      async beforeEffect(effect) { effects.push(effect); },
      async afterModulesDirectoryCreated() {
        await fs.mkdir(target);
        await fs.writeFile(path.join(target, "sentinel"), sentinel);
      },
      async uncertain(observation) { throw new Error(JSON.stringify(observation)); },
      async receipt() { throw new Error("replaced install directory must not be received"); },
      async intent() { throw new Error("replaced install directory must not receive an intent"); },
    })).toBe(false);
    expect(effects).toContain("create-modules-directory");
    expect(effects).not.toContain("install-in-place");
    expect(effects).not.toContain("private-marker");
    expect(await fs.readFile(path.join(target, "sentinel"), "utf8")).toBe(sentinel);
    expect(await fs.readdir(target)).toEqual(["sentinel"]);
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
      async observeLegacy() { return { kind: "clear", observedAt: Date.now() }; },
      async beforeEffect(effect) { effects.push(effect); },
      async uncertain(cause) { throw new Error(JSON.stringify(cause)); },
      async receipt(value) { receipts.push(value); },
      async intent() { throw new Error("recovery must not create a new install intent"); },
    })).toBe(true);
    expect(effects).toEqual([]);
    expect(receipts).toEqual([{ claim, inputs, device: priorIntent.device, inode: priorIntent.inode, mode: "staged" }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a completed staged scratch receipt publishes after restart without another install", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-scratch-recovery-"));
  try {
    const source = path.join(root, "source"), checkout = path.join(root, "checkout"), claim = "scratch-recovery-claim";
    const scratch = path.join(checkout, `.delegatus-dependencies-${claim}`), staged = path.join(scratch, "node_modules");
    await fs.mkdir(source);
    await fs.mkdir(staged, { recursive: true });
    const manifest = Buffer.from('{"name":"fixture-tools"}\n'), lock = Buffer.from('{"lockfileVersion":1}\n');
    await fs.writeFile(path.join(checkout, "package.json"), manifest);
    await fs.writeFile(path.join(checkout, "bun.lock"), lock);
    await fs.writeFile(path.join(staged, "package.json"), "installed\n");
    const digest = createHash("sha256");
    digest.update(JSON.stringify(["package.json", manifest.length])).update(manifest);
    digest.update(JSON.stringify(["bun.lock", lock.length])).update(lock);
    const inputs = digest.digest("hex");
    const info = await fs.stat(staged, { bigint: true });
    const nonce = "staged-scratch-nonce";
    const nonceDigest = createHash("sha256").update(nonce).digest("hex");
    const prior: PrivateInstallIntent = { claim, inputs, device: String(info.dev), inode: String(info.ino), nonceDigest };
    await fs.writeFile(path.join(staged, ".delegatus-install-intent.json"), JSON.stringify({ claim, nonce }));
    await fs.writeFile(path.join(staged, ".delegatus-install-receipt.json"), JSON.stringify({ claim, inputs, bun: Bun.version,
      device: prior.device, inode: prior.inode, mode: "staged", nonceDigest }));
    const effects: PrivateInstallEffect[] = [], receipts: PrivateInstallReceipt[] = [];
    expect(await preparePrivateDependencies(source, checkout, "successor-claim", undefined, prior, 5_000, {
      async observeLegacy() { return { kind: "clear", observedAt: Date.now() }; },
      async beforeEffect(effect) { effects.push(effect); },
      async uncertain(observation) { throw new Error(JSON.stringify(observation)); },
      async receipt(value) { receipts.push(value); },
      async intent() { throw new Error("scratch recovery must not dispatch a fresh installer"); },
    })).toBe(true);
    expect(effects).toEqual(["private-publish", "private-cleanup"]);
    expect(receipts).toEqual([{ claim, inputs, device: prior.device, inode: prior.inode, mode: "staged" }]);
    expect(await fs.readFile(path.join(checkout, "node_modules", "package.json"), "utf8")).toBe("installed\n");
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
      async observeLegacy() { return { kind: "clear", observedAt: Date.now() }; },
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
