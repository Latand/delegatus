import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { containedDependencyExec } from "./lockedDependencies";
import { observeLegacyInstaller, type LegacyInstallerObservation } from "./provisionLegacyInstaller";
import { hasCheckoutRelativeDependencies, stageWorktreeDependencyCopy, worktreeDependencyInputs } from "./worktreeDependencies";

const INSTALL_FILES = new Set<string>(["package.json", "bun.lock", "bun.lockb", ".npmrc", "bunfig.toml"]);
const MARKER = ".delegatus-install-receipt.json";
const INTENT = ".delegatus-install-intent.json";
export type PrivateInstallReceipt = { claim: string; inputs: string; device: string; inode: string; mode: "staged" | "handoff" | "in-place" | "copied" };
export type PrivateInstallIntent = Omit<PrivateInstallReceipt, "mode"> & { nonceDigest: string };
export type PrivateInstallEffect = "private-scratch" | "private-install" | "private-marker" | "private-publish" | "private-cleanup"
  | "private-copy" | "create-modules-directory" | "install-in-place";

type PrivateInstallPorts = {
  beforeEffect(effect: PrivateInstallEffect): Promise<void>;
  observeLegacy?: typeof observeLegacyInstaller;
  uncertain(observation: Exclude<LegacyInstallerObservation, { kind: "clear" }>): Promise<never>;
  receipt(value: PrivateInstallReceipt): Promise<void>;
  intent(value: PrivateInstallIntent): Promise<void>;
};

class UnverifiedPrivateInstall extends Error {}
const requireRuntime = createRequire(import.meta.url);
const sameDirectory = (left: BigIntStats, right: BigIntStats | null) => right !== null && right.isDirectory()
  && left.dev === right.dev && left.ino === right.ino;

async function entry(file: string): Promise<BigIntStats | null> {
  try { return await fs.lstat(file, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function fileBytes(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new UnverifiedPrivateInstall();
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new UnverifiedPrivateInstall();
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

function publishNoReplace(source: string, target: string): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new UnverifiedPrivateInstall();
  try {
    const ffi = requireRuntime(`bun:${"ffi"}`) as typeof import("bun:ffi");
    const { ptr, i32, u32 } = ffi.FFIType;
    const from = Buffer.from(source + "\0"), to = Buffer.from(target + "\0");
    if (process.platform === "linux") {
      const library = ffi.dlopen("libc.so.6", { renameat2: { args: [i32, ptr, i32, ptr, u32], returns: i32 } });
      try { return library.symbols.renameat2(-100, ffi.ptr(from), -100, ffi.ptr(to), 1) === 0; }
      finally { library.close(); }
    }
    const library = ffi.dlopen("/usr/lib/libSystem.B.dylib", { renamex_np: { args: [ptr, ptr, u32], returns: i32 } });
    try { return library.symbols.renamex_np(ffi.ptr(from), ffi.ptr(to), 4) === 0; }
    finally { library.close(); }
  } catch { throw new UnverifiedPrivateInstall(); }
}

async function filesMatch(reference: string, actual: string): Promise<boolean> {
  const [wanted, found] = await Promise.all([entry(reference), entry(actual)]);
  if (!wanted || !found || wanted.mode !== found.mode) return false;
  if (wanted.isDirectory()) {
    for (const name of await fs.readdir(reference)) if (!await filesMatch(path.join(reference, name), path.join(actual, name))) return false;
    return sameDirectory(found, await entry(actual));
  }
  if (wanted.isSymbolicLink()) return await fs.readlink(reference) === await fs.readlink(actual);
  if (!wanted.isFile() || wanted.size !== found.size) return false;
  const handles = await Promise.allSettled([reference, actual].map(file => fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)));
  try {
    if (handles[0]?.status !== "fulfilled" || handles[1]?.status !== "fulfilled") return false;
    const left = handles[0].value, right = handles[1].value;
    const [before, current] = await Promise.all([left.stat({ bigint: true }), right.stat({ bigint: true })]);
    if (!before.isFile() || !current.isFile() || current.ino !== found.ino || current.dev !== found.dev) return false;
    const buffers = [Buffer.alloc(64 * 1024), Buffer.alloc(64 * 1024)] as const;
    for (;;) {
      const [a, b] = await Promise.all([left.read(buffers[0]), right.read(buffers[1])]);
      if (a.bytesRead !== b.bytesRead || !buffers[0].subarray(0, a.bytesRead).equals(buffers[1].subarray(0, b.bytesRead))) return false;
      if (!a.bytesRead) break;
    }
    const after = await entry(actual);
    return after?.dev === found.dev && after.ino === found.ino && after.ctimeNs === found.ctimeNs;
  } finally {
    await Promise.all(handles.flatMap(result => result.status === "fulfilled" ? [result.value.close()] : []));
  }
}

export async function preparePrivateDependencies(repository: string, checkout: string, claim: string, prior: PrivateInstallReceipt | undefined, priorIntent: PrivateInstallIntent | undefined,
  budgetMs: number, ports: PrivateInstallPorts): Promise<boolean> {
  const census = async () => {
    const observation = await (ports.observeLegacy ?? observeLegacyInstaller)(checkout);
    if (observation.kind !== "clear") await ports.uncertain(observation);
  };
  const permit = async (effect: PrivateInstallEffect) => { await census(); await ports.beforeEffect(effect); };
  const inputs = async (directory = checkout, names: Iterable<string> = [...worktreeDependencyInputs, "bunfig.toml"]) => {
    const files: Array<[string, Buffer]> = [];
    for (const name of names) {
      const file = path.join(directory, name);
      if (await entry(file)) files.push([name, await fileBytes(file, 8 * 1024 * 1024)]);
    }
    const digest = createHash("sha256");
    for (const [name, value] of files) digest.update(JSON.stringify([name, value.length])).update(value);
    return { files, digest: digest.digest("hex") };
  };
  try {
    await census();
    // Keep the digest of existing install receipts stable across worker versions.
    const selected = await inputs(checkout, INSTALL_FILES);
    const copyInputs = await inputs();
    const manifest = selected.files.find(([name]) => name === "package.json")?.[1].toString();
    if (!manifest) return false;
    const target = path.join(checkout, "node_modules");
    const before = await entry(target);
    if (before && !before.isDirectory()) return false;
    if (prior && before && prior.inputs === (prior.mode === "copied" ? copyInputs.digest : selected.digest)
      && prior.device === String(before.dev) && prior.inode === String(before.ino)) {
      let marker;
      if (prior.mode !== "handoff") {
        try { marker = JSON.parse((await fileBytes(path.join(target, MARKER), 4096)).toString()); }
        catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof UnverifiedPrivateInstall) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (prior.mode === "handoff" || (marker?.claim === prior.claim && marker.inputs === prior.inputs && marker.bun === Bun.version)) {
        await census();
        if (!sameDirectory(before, await entry(target)) || before.ctimeNs !== (await entry(target))?.ctimeNs) return false;
        await ports.receipt(prior);
        return true;
      }
    }
    const relative = hasCheckoutRelativeDependencies(manifest);
    const source = path.join(repository, "node_modules");
    const canCopy = !relative && !before && !priorIntent && !!await entry(source)
      && (await inputs(repository)).digest === copyInputs.digest;
    const canInstall = selected.files.some(([name]) => name === "bun.lock" || name === "bun.lockb");
    if (!canCopy && !canInstall) return false;
    if (relative && (process.platform !== "linux" || (before && !priorIntent))) return false;
    if (relative) {
      const checkoutHandle = await fs.open(checkout, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const probe = await containedDependencyExec(process.execPath, ["--no-env-file", process.argv[1]!, "probe-install-binding"],
          checkout, undefined, { timeoutMs: 5_000, inheritFd: checkoutHandle.fd });
        if (probe.code !== 0) return false;
      } finally { await checkoutHandle.close(); }
    }
    const scratch = path.join(checkout, `.delegatus-dependencies-${claim}`);
    await permit("private-scratch");
    await fs.mkdir(scratch, { mode: 0o700 });
    const owns = (await entry(scratch))!;
    const reference = path.join(scratch, "node_modules");
    try {
      const publish = async (staged: string, digest: string, mode: "copied" | "staged", current: () => Promise<boolean>) => {
        const built = await entry(staged);
        if (!built?.isDirectory() || !await current()) return false;
        await permit("private-marker");
        const marker = path.join(staged, MARKER);
        await fs.writeFile(marker, JSON.stringify({ claim, inputs: digest, bun: Bun.version }), { flag: "wx" });
        await permit("private-publish");
        if (!await current() || !sameDirectory(built, await entry(staged))) return false;
        if (!publishNoReplace(staged, target)) {
          await fs.unlink(marker);
          return false;
        }
        await census();
        if (!sameDirectory(built, await entry(target)) || !await current()) throw new UnverifiedPrivateInstall();
        await ports.receipt({ claim, inputs: digest, device: String(built.dev), inode: String(built.ino), mode });
        return true;
      };
      if (canCopy) {
        const staged = await stageWorktreeDependencyCopy(source, scratch, () => permit("private-copy"));
        const current = async () => (await inputs()).digest === copyInputs.digest
          && (await inputs(repository)).digest === copyInputs.digest;
        if (staged && !await entry(path.join(staged, MARKER)) && !await entry(path.join(staged, INTENT))
          && await publish(staged, copyInputs.digest, "copied", current)) return true;
      }
      if (!canInstall) return false;
      if (relative) {
        const result = await installInPlace({ checkout, target, scratch, reference, claim, inputs: selected.digest, budgetMs,
          prior: priorIntent, original: before, permit, verify: async () => { await census(); return (await inputs(checkout, INSTALL_FILES)).digest === selected.digest; }, ports });
        return result;
      }
      for (const [name, value] of selected.files) await fs.writeFile(path.join(scratch, name), value, { flag: "wx" });
      await permit("private-install");
      const installed = await containedDependencyExec(process.execPath, ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"],
        scratch, { NODE_ENV: "development" }, { timeoutMs: budgetMs });
      if (installed.code !== 0 || !sameDirectory(owns, await entry(scratch))) return false;
      if (!await entry(reference)) await fs.mkdir(reference);
      const current = async () => (await inputs(checkout, INSTALL_FILES)).digest === selected.digest;
      if (!await current()) return false;
      if (!await entry(target) && await publish(reference, selected.digest, "staged", current)) return true;
      await census();
      const foreign = await entry(target);
      if (!foreign?.isDirectory() || !await filesMatch(reference, target) || !sameDirectory(foreign, await entry(target))) return false;
      await census();
      if (!sameDirectory(foreign, await entry(target)) || !await current()) return false;
      await ports.receipt({ claim, inputs: selected.digest, device: String(foreign.dev), inode: String(foreign.ino), mode: "handoff" });
      return true;
    } finally {
      if (sameDirectory(owns, await entry(scratch))) {
        await permit("private-cleanup");
        if (sameDirectory(owns, await entry(scratch))) await fs.rm(scratch, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if (error instanceof UnverifiedPrivateInstall) return false;
    throw error;
  }
}

async function installInPlace({ checkout, target, scratch, reference, claim, inputs, budgetMs, prior, original, permit, verify, ports }: {
  checkout: string; target: string; scratch: string; reference: string; claim: string; inputs: string; budgetMs: number;
  prior?: PrivateInstallIntent; original: BigIntStats | null; permit: (effect: PrivateInstallEffect) => Promise<void>;
  verify: () => Promise<boolean>; ports: PrivateInstallPorts;
}): Promise<boolean> {
  if (original && (!prior || prior.inputs !== inputs || prior.device !== String(original.dev) || prior.inode !== String(original.ino))) return false;
  if (!original) {
    await permit("create-modules-directory");
    await fs.mkdir(reference, { mode: 0o700 });
  }
  const opens = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const directory = await fs.open(original ? target : reference, opens);
  try {
    const identity = await directory.stat({ bigint: true });
    const anchored = `/proc/self/fd/${directory.fd}`;
    const digest = (nonce: string) => createHash("sha256").update(nonce).digest("hex");
    let intent = prior;
    if (original) {
      if (!sameDirectory(original, identity)) return false;
      const existing = JSON.parse((await fileBytes(path.join(anchored, INTENT), 4096)).toString());
      if (typeof existing.nonce !== "string" || existing.claim !== prior!.claim || digest(existing.nonce) !== prior!.nonceDigest) return false;
    } else {
      const nonce = randomUUID();
      intent = { claim, inputs, device: String(identity.dev), inode: String(identity.ino), nonceDigest: digest(nonce) };
      await permit("private-marker");
      await fs.writeFile(path.join(anchored, INTENT), JSON.stringify({ claim, nonce }), { flag: "wx" });
      await ports.intent(intent);
      await permit("private-publish");
      if (!sameDirectory(identity, await entry(reference)) || !publishNoReplace(reference, target)) return false;
    }
    const cache = await fs.open(scratch, opens);
    try {
      await permit("install-in-place");
      if (!sameDirectory(identity, await entry(target))) return false;
      const installed = await containedDependencyExec(process.execPath, ["--no-env-file", process.argv[1]!, "install-bound"], checkout,
        { NODE_ENV: "development", BUN_INSTALL_CACHE_DIR: path.join(scratch, "cache"), TMPDIR: scratch },
        { timeoutMs: budgetMs, inheritFd: directory.fd, additionalInheritedFds: [cache.fd] });
      if (installed.code !== 0 || !sameDirectory(identity, await entry(target))) return false;
      const retained = JSON.parse((await fileBytes(path.join(anchored, INTENT), 4096)).toString());
      if (retained.claim !== intent!.claim || typeof retained.nonce !== "string" || digest(retained.nonce) !== intent!.nonceDigest) return false;
      await permit("private-marker");
      if (!sameDirectory(identity, await entry(target))) return false;
      try {
        await fs.writeFile(path.join(anchored, MARKER), JSON.stringify({ claim: intent!.claim, inputs, bun: Bun.version }), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const marker = JSON.parse((await fileBytes(path.join(anchored, MARKER), 4096)).toString());
        if (marker.claim !== intent!.claim || marker.inputs !== inputs || marker.bun !== Bun.version) return false;
      }
      if (!await verify() || !sameDirectory(identity, await entry(target))) return false;
      await ports.receipt({ claim: intent!.claim, inputs, device: String(identity.dev), inode: String(identity.ino), mode: "in-place" });
      return true;
    } finally { await cache.close(); }
  } finally { await directory.close(); }
}
