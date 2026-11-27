import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { renameDirectoryNoReplace } from "@/lib/state/renameDirectoryNoReplace";
import { containedDependencyExec } from "./lockedDependencies";
import { observeLegacyInstaller, type LegacyInstallerObservation } from "./provisionLegacyInstaller";
import { hasCheckoutRelativeDependencies, stageWorktreeDependencyCopy, worktreeDependencyInputs } from "./worktreeDependencies";

const INSTALL_FILES = new Set<string>(["package.json", "bun.lock", "bun.lockb", ".npmrc", "bunfig.toml"]);
const MARKER = ".delegatus-install-receipt.json";
const INTENT = ".delegatus-install-intent.json";
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_OUTPUT_ENTRIES = 200_000;
type PrivateInstallDirectory = { claim: string; inputs: string; device: string; inode: string };
export type PrivateInstallReceipt = PrivateInstallDirectory & { mode: "staged" | "handoff" | "in-place" | "copied"; workspaceDigest?: string };
export type PrivateInstallIntent = PrivateInstallDirectory & { nonceDigest: string };
export type PrivateInstallEffect = "private-scratch" | "private-install" | "private-marker" | "private-publish" | "private-cleanup"
  | "private-copy" | "create-modules-directory" | "install-in-place";

type PrivateInstallPorts = {
  beforeEffect(effect: PrivateInstallEffect): Promise<void>;
  afterModulesDirectoryCreated?(): Promise<void>;
  now?(): number;
  workerEntry?: string;
  observeLegacy?: typeof observeLegacyInstaller;
  uncertain(observation: Exclude<LegacyInstallerObservation, { kind: "clear" }>): Promise<never>;
  receipt(value: PrivateInstallReceipt): Promise<void>;
  intent(value: PrivateInstallIntent): Promise<void>;
};

class UnverifiedPrivateInstall extends Error {}
const sameDirectory = (left: BigIntStats, right: BigIntStats | null) => right !== null && right.isDirectory()
  && left.dev === right.dev && left.ino === right.ino;
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const descriptorPath = (fd: number) => `/proc/self/fd/${fd}`;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const workspacePathChanged = (error: unknown) => ["ENOENT", "ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

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
  try { return renameDirectoryNoReplace(source, target); }
  catch { throw new UnverifiedPrivateInstall(); }
}

async function supportsNoReplacePublish(directory: string): Promise<boolean> {
  const source = path.join(directory, `.publish-probe-${randomUUID()}`);
  const target = `${source}-target`;
  await fs.mkdir(source, { mode: 0o700 });
  try {
    try { return publishNoReplace(source, target); }
    catch (error) { if (error instanceof UnverifiedPrivateInstall) return false; throw error; }
  } finally {
    await Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(target, { recursive: true, force: true })]);
  }
}

// Use Bun's workspace globs for both lockfile formats. Open each path relative
// to the checkout, one component at a time, so a symlink cannot grant writes
// to another tree.
async function openWorkspace(checkout: string, member: string): Promise<FileHandle> {
  let directory = await fs.open(checkout, directoryFlags);
  try {
    for (const component of member.split("/")) {
      const child = await fs.open(path.join(descriptorPath(directory.fd), component), directoryFlags);
      await directory.close();
      directory = child;
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function workspaceMembers(checkout: string, manifest: string): Promise<string[]> {
  const { workspaces } = JSON.parse(manifest);
  if (!workspaces) return [];
  const patterns: unknown = Array.isArray(workspaces) ? workspaces : workspaces.packages;
  if (!Array.isArray(patterns)) return [];
  const included: { filename: string; literal: boolean }[] = [], excluded: Bun.Glob[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== "string") throw new UnverifiedPrivateInstall();
    const negative = pattern.startsWith("!");
    const glob = pattern.slice(negative ? 1 : 0).replace(/^(?:\.\/)+|\/+$/g, "");
    if (!glob || glob === ".") continue;
    if (path.isAbsolute(glob) || glob.split("/").includes("..")) throw new UnverifiedPrivateInstall();
    if (negative) excluded.push(new Bun.Glob(glob));
    else included.push({ filename: `${glob}/package.json`, literal: !/[*?[\]{}\\]/.test(glob) });
  }
  const members = new Set<string>();
  for (const { filename, literal } of included) {
    for await (const file of new Bun.Glob(filename).scan({ cwd: checkout })) {
      const member = path.dirname(file);
      if (member === "." || path.isAbsolute(member) || member.split("/").some(part =>
        ["", ".", "..", ".git", "node_modules"].includes(part) || part.startsWith(".delegatus-dependencies-"))) continue;
      // Bun applies negative globs to discovered members. Explicit paths win.
      if (!literal && excluded.some(glob => glob.match(member))) continue;
      members.add(member);
    }
  }
  const named: string[] = [];
  for (const member of [...members].sort()) {
    const parent = await openWorkspace(checkout, member);
    try {
      const packageFile = await fileBytes(path.join(descriptorPath(parent.fd), "package.json"), MAX_INPUT_BYTES);
      const manifest = Bun.JSONC.parse(packageFile.toString()) as { name?: unknown } | null;
      if (typeof manifest?.name === "string" && manifest.name) named.push(member);
    } finally { await parent.close(); }
  }
  return named;
}

async function workspaceIdentity(member: string, parent: FileHandle, modules: FileHandle): Promise<string[]> {
  const owner = await parent.stat({ bigint: true });
  const target = await modules.stat({ bigint: true });
  const manifest = await fileBytes(path.join(descriptorPath(parent.fd), "package.json"), MAX_INPUT_BYTES);
  return [member, String(owner.dev), String(owner.ino), String(target.dev), String(target.ino), sha256(manifest)];
}

async function workspaceOutputDigest(member: string, parent: FileHandle, modules: FileHandle): Promise<string> {
  const digest = createHash("sha256");
  const root = descriptorPath(modules.fd);
  const visit = async (directory: string, relative = "") => {
    const names = (await fs.readdir(directory)).sort();
    for (const name of names) {
      const child = path.join(directory, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = await fs.lstat(child, { bigint: true });
      if (++entries > MAX_WORKSPACE_OUTPUT_ENTRIES) throw new UnverifiedPrivateInstall();
      const type = stat.isDirectory() ? "d" : stat.isFile() ? "f" : stat.isSymbolicLink() ? "l" : "?";
      const link = stat.isSymbolicLink() ? await fs.readlink(child) : null;
      digest.update(JSON.stringify([childRelative, type, link]));
      if (stat.isSymbolicLink()) {
        const after = await entry(child);
        if (after?.dev !== stat.dev || after.ino !== stat.ino) throw new UnverifiedPrivateInstall();
      } else if (stat.isDirectory()) await visit(child, childRelative);
      else if (!stat.isFile()) throw new UnverifiedPrivateInstall();
    }
  };
  let entries = 0;
  await visit(root);
  return sha256(JSON.stringify([member, await workspaceIdentity(member, parent, modules), digest.digest("hex")]));
}

async function currentWorkspaceOutputDigest(checkout: string): Promise<string> {
  const manifest = await fileBytes(path.join(checkout, "package.json"), MAX_INPUT_BYTES);
  const identities: string[][] = [];
  for (const member of await workspaceMembers(checkout, manifest.toString())) {
    const parent = await openWorkspace(checkout, member);
    try {
      const target = path.join(descriptorPath(parent.fd), "node_modules");
      const modules = await fs.open(target, directoryFlags);
      try {
        const output = await workspaceOutputDigest(member, parent, modules);
        const current = await openWorkspace(checkout, member);
        try {
          if (!sameDirectory(await parent.stat({ bigint: true }), await current.stat({ bigint: true }))
            || !sameDirectory(await modules.stat({ bigint: true }), await entry(target))) throw new UnverifiedPrivateInstall();
        } finally { await current.close(); }
        identities.push([member, output]);
      } finally { await modules.close(); }
    } finally { await parent.close(); }
  }
  return sha256(JSON.stringify(identities));
}

export async function verifyPrivateWorkspaceInstall(checkout: string, digest: string): Promise<boolean> {
  try {
    return await currentWorkspaceOutputDigest(checkout) === digest;
  } catch (error) {
    if (error instanceof UnverifiedPrivateInstall || error instanceof SyntaxError || workspacePathChanged(error)) return false;
    throw error;
  }
}

async function verifyWorkspaceDirectories(checkout: string, expected: string[][]): Promise<boolean> {
  try {
    const manifest = await fileBytes(path.join(checkout, "package.json"), MAX_INPUT_BYTES);
    const members = await workspaceMembers(checkout, manifest.toString());
    if (members.length !== expected.length) return false;
    for (let index = 0; index < members.length; index++) {
      const member = members[index]!;
      const parent = await openWorkspace(checkout, member);
      try {
        const target = path.join(descriptorPath(parent.fd), "node_modules");
        const modules = await fs.open(target, directoryFlags);
        try {
          const identity = await workspaceIdentity(member, parent, modules);
          if (JSON.stringify(identity) !== JSON.stringify(expected[index])) return false;
          if (!sameDirectory(await modules.stat({ bigint: true }), await entry(target))) return false;
        } finally { await modules.close(); }
      } finally { await parent.close(); }
    }
    return true;
  } catch (error) {
    if (error instanceof UnverifiedPrivateInstall || error instanceof SyntaxError || workspacePathChanged(error)) return false;
    throw error;
  }
}

async function bindWorkspaceModules(checkout: string, member: string, scratch: string, nonce: string,
  permit: (effect: PrivateInstallEffect) => Promise<void>): Promise<{ directory: FileHandle; identity: string[] }> {
  const parent = await openWorkspace(checkout, member);
  let modules: FileHandle | undefined;
  try {
    const target = path.join(descriptorPath(parent.fd), "node_modules");
    // The root intent is durable before any member directory is published.
    // A retry can bind a member it created even if it lost the install reply.
    const owner = await parent.stat({ bigint: true });
    const proof = (identity: BigIntStats) => sha256(JSON.stringify([
      nonce, member, String(owner.dev), String(owner.ino), String(identity.dev), String(identity.ino),
    ]));
    const ignoreModules = async (directoryFd: number) => {
      const file = path.join(descriptorPath(directoryFd), ".gitignore");
      try {
        await fs.writeFile(file, "*\n", { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if ((await fileBytes(file, 16)).toString() !== "*\n") throw new UnverifiedPrivateInstall();
      }
    };
    if (await entry(target)) {
      modules = await fs.open(target, directoryFlags);
      const existing = await fileBytes(path.join(descriptorPath(modules.fd), INTENT), 4096);
      if (existing.toString() !== proof(await modules.stat({ bigint: true }))) throw new UnverifiedPrivateInstall();
      await permit("private-marker");
      await ignoreModules(modules.fd);
    } else {
      await permit("create-modules-directory");
      const staged = await fs.mkdtemp(path.join(scratch, "workspace-"));
      modules = await fs.open(staged, directoryFlags);
      const created = await modules.stat({ bigint: true });
      await fs.writeFile(path.join(descriptorPath(modules.fd), INTENT), proof(created), { flag: "wx" });
      await ignoreModules(modules.fd);
      const current = await openWorkspace(checkout, member);
      try {
        if (!sameDirectory(owner, await current.stat({ bigint: true }))
          || !sameDirectory(created, await entry(staged)) || !publishNoReplace(staged, target)) throw new UnverifiedPrivateInstall();
      } finally { await current.close(); }
    }
    if (!sameDirectory(await modules.stat({ bigint: true }), await entry(target))) throw new UnverifiedPrivateInstall();
    return { directory: modules, identity: await workspaceIdentity(member, parent, modules) };
  } catch (error) {
    await modules?.close();
    throw error;
  } finally { await parent.close(); }
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
  const now = ports.now ?? Date.now;
  const census = async () => {
    const observation = await (ports.observeLegacy ?? observeLegacyInstaller)(checkout);
    if (observation.kind !== "clear") return ports.uncertain(observation);
    if (observation.observedAt > now() || now() - observation.observedAt > 5_000) {
      await ports.uncertain({ kind: "incomplete", reason: "expired" });
    }
  };
  const permit = async (effect: PrivateInstallEffect) => {
    await census();
    await ports.beforeEffect(effect);
    // Admission may wait for a worker handoff. Recheck after that wait so the
    // observation still covers the effect which follows the permit.
    await census();
  };
  const inputs = async (directory = checkout, names: Iterable<string> = [...worktreeDependencyInputs, "bunfig.toml"]) => {
    const files: Array<[string, Buffer]> = [];
    for (const name of names) {
      const file = path.join(directory, name);
      if (await entry(file)) files.push([name, await fileBytes(file, MAX_INPUT_BYTES)]);
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
    // A marker may have been published immediately before the controller lost
    // its receipt reply. The durable intent is the authority to reconcile that
    // exact directory after restart, before any new installer child is run.
    if (before && priorIntent && priorIntent.inputs === selected.digest
      && priorIntent.device === String(before.dev) && priorIntent.inode === String(before.ino)) {
      try {
        const marker = JSON.parse((await fileBytes(path.join(target, MARKER), 4096)).toString());
        const intent = JSON.parse((await fileBytes(path.join(target, INTENT), 4096)).toString());
        const { mode, workspaceDigest } = marker;
        if (["staged", "in-place"].includes(mode)
          && marker.claim === priorIntent.claim && marker.inputs === selected.digest && marker.bun === Bun.version
          && marker.device === priorIntent.device && marker.inode === priorIntent.inode
          && marker.nonceDigest === priorIntent.nonceDigest
          && intent.claim === priorIntent.claim && typeof intent.nonce === "string"
          && sha256(intent.nonce) === priorIntent.nonceDigest) {
          await census();
          const verifiedWorkspace = workspaceDigest === undefined || (mode === "in-place" && typeof workspaceDigest === "string"
            && await verifyPrivateWorkspaceInstall(checkout, workspaceDigest));
          const after = await entry(target);
          if (verifiedWorkspace && sameDirectory(before, after) && before.ctimeNs === after?.ctimeNs
            && (await inputs(checkout, INSTALL_FILES)).digest === selected.digest) {
            await ports.receipt({ claim: priorIntent.claim, inputs: selected.digest, device: priorIntent.device,
              inode: priorIntent.inode, mode, workspaceDigest });
            return true;
          }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof UnverifiedPrivateInstall)
          && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (prior && before && prior.inputs === (prior.mode === "copied" ? copyInputs.digest : selected.digest)
      && prior.device === String(before.dev) && prior.inode === String(before.ino)) {
      let marker;
      if (prior.mode !== "handoff") {
        try { marker = JSON.parse((await fileBytes(path.join(target, MARKER), 4096)).toString()); }
        catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof UnverifiedPrivateInstall) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (prior.mode === "handoff" || (marker?.claim === prior.claim && marker.inputs === prior.inputs && marker.bun === Bun.version
        && marker.workspaceDigest === prior.workspaceDigest)) {
        await census();
        if (prior.workspaceDigest !== undefined && !await verifyPrivateWorkspaceInstall(checkout, prior.workspaceDigest)) return false;
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
    if (priorIntent && !before && !relative && process.platform !== "win32") {
      const priorScratch = path.join(checkout, `.delegatus-dependencies-${priorIntent.claim}`);
      const priorRoot = await entry(priorScratch);
      const staged = path.join(priorScratch, "node_modules");
      const stagedEntry = await entry(staged);
      if (priorRoot?.isDirectory() && stagedEntry?.isDirectory()
        && priorIntent.inputs === selected.digest && priorIntent.device === String(stagedEntry.dev)
        && priorIntent.inode === String(stagedEntry.ino)) {
        try {
          const marker = JSON.parse((await fileBytes(path.join(staged, MARKER), 4096)).toString());
          const intent = JSON.parse((await fileBytes(path.join(staged, INTENT), 4096)).toString());
          const nonceMatches = typeof intent.nonce === "string"
            && createHash("sha256").update(intent.nonce).digest("hex") === priorIntent.nonceDigest;
          const valid = marker.claim === priorIntent.claim && marker.inputs === selected.digest && marker.bun === Bun.version
            && marker.device === priorIntent.device && marker.inode === priorIntent.inode && marker.mode === "staged"
            && marker.nonceDigest === priorIntent.nonceDigest && intent.claim === priorIntent.claim && nonceMatches;
          if (valid && (await inputs(checkout, INSTALL_FILES)).digest === selected.digest
            && sameDirectory(priorRoot, await entry(priorScratch)) && sameDirectory(stagedEntry, await entry(staged))) {
            await permit("private-publish");
            if (!(await entry(target)) && (await inputs(checkout, INSTALL_FILES)).digest === selected.digest
              && sameDirectory(priorRoot, await entry(priorScratch)) && sameDirectory(stagedEntry, await entry(staged))
              && publishNoReplace(staged, target)) {
              await census();
              if (sameDirectory(stagedEntry, await entry(target)) && (await inputs(checkout, INSTALL_FILES)).digest === selected.digest) {
                await ports.receipt({ claim: priorIntent.claim, inputs: selected.digest, device: priorIntent.device,
                  inode: priorIntent.inode, mode: "staged" });
                await permit("private-cleanup");
                if (sameDirectory(priorRoot, await entry(priorScratch))) await fs.rm(priorScratch, { recursive: true, force: true });
                return true;
              }
              throw new UnverifiedPrivateInstall();
            }
          }
        } catch (error) {
          if (!(error instanceof SyntaxError) && !(error instanceof UnverifiedPrivateInstall)
            && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    const scratch = path.join(checkout, `.delegatus-dependencies-${claim}`);
    await permit("private-scratch");
    await fs.mkdir(scratch, { mode: 0o700 });
    const owns = (await entry(scratch))!;
    const reference = path.join(scratch, "node_modules");
    try {
      const atomicPublish = await supportsNoReplacePublish(scratch);
      if ((relative || !atomicPublish) && process.platform !== "linux") return false;
      if (relative || !atomicPublish) {
        const checkoutHandle = await fs.open(checkout, directoryFlags);
        try {
          const probe = await containedDependencyExec(process.execPath, ["--no-env-file", ports.workerEntry ?? process.argv[1]!, "probe-install-binding"],
            checkout, undefined, { timeoutMs: 5_000, inheritFd: checkoutHandle.fd });
          if (probe.code !== 0) return false;
        } finally { await checkoutHandle.close(); }
      }
      const publish = async (staged: string, digest: string, mode: "copied" | "staged", current: () => Promise<boolean>) => {
        const built = await entry(staged);
        if (!built?.isDirectory() || !await current()) return false;
        await permit("private-marker");
        const marker = path.join(staged, MARKER);
        if (mode === "staged") {
          const nonce = randomUUID();
          const intent: PrivateInstallIntent = { claim, inputs: digest, device: String(built.dev), inode: String(built.ino),
            nonceDigest: createHash("sha256").update(nonce).digest("hex") };
          await fs.writeFile(marker, JSON.stringify({ claim, inputs: digest, bun: Bun.version,
            device: intent.device, inode: intent.inode, mode, nonceDigest: intent.nonceDigest }), { flag: "wx" });
          await fs.writeFile(path.join(staged, INTENT), JSON.stringify({ claim, nonce }), { flag: "wx" });
          await ports.intent(intent);
        } else await fs.writeFile(marker, JSON.stringify({ claim, inputs: digest, bun: Bun.version }), { flag: "wx" });
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
      if (canCopy && atomicPublish) {
        const staged = await stageWorktreeDependencyCopy(source, scratch, () => permit("private-copy"));
        const current = async () => (await inputs()).digest === copyInputs.digest
          && (await inputs(repository)).digest === copyInputs.digest;
        if (staged && !await entry(path.join(staged, MARKER)) && !await entry(path.join(staged, INTENT))
          && await publish(staged, copyInputs.digest, "copied", current)) return true;
      }
      if (!canInstall) return false;
      if (relative || !atomicPublish) {
        try {
          return await installInPlace({ checkout, target, scratch, claim, manifest, inputs: selected.digest, budgetMs,
            prior: priorIntent, original: before, permit, verify: async () => { await census(); return (await inputs(checkout, INSTALL_FILES)).digest === selected.digest; }, ports });
        } catch (error) {
          if (error instanceof SyntaxError || workspacePathChanged(error)) return false;
          throw error;
        }
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

async function installInPlace({ checkout, target, scratch, claim, manifest, inputs, budgetMs, prior, original, permit, verify, ports }: {
  checkout: string; target: string; scratch: string; claim: string; manifest: string; inputs: string; budgetMs: number;
  prior?: PrivateInstallIntent; original: BigIntStats | null; permit: (effect: PrivateInstallEffect) => Promise<void>;
  verify: () => Promise<boolean>; ports: PrivateInstallPorts;
}): Promise<boolean> {
  if (original && (!prior || prior.inputs !== inputs || prior.device !== String(original.dev) || prior.inode !== String(original.ino))) return false;
  const members = await workspaceMembers(checkout, manifest);
  let directoryFd: number | undefined;
  if (!original) {
    await permit("create-modules-directory");
    // Build the directory under the private scratch root, acquire its inode
    // before publishing the public name, then publish with no-replace. This
    // keeps a competing node_modules from becoming the install write target.
    const staged = path.join(scratch, "node_modules");
    try {
      mkdirSync(staged, { mode: 0o700 });
      directoryFd = openSync(staged, directoryFlags);
      const createdIdentity = fstatSync(directoryFd, { bigint: true });
      if (!createdIdentity.isDirectory() || !sameDirectory(createdIdentity, await entry(staged))) {
        closeSync(directoryFd);
        directoryFd = undefined;
        return false;
      }
      await ports.afterModulesDirectoryCreated?.();
      if (!sameDirectory(createdIdentity, await entry(staged)) || !publishNoReplace(staged, target)
        || !sameDirectory(createdIdentity, await entry(target))) {
        closeSync(directoryFd);
        directoryFd = undefined;
        return false;
      }
    }
    catch (error) {
      if (directoryFd !== undefined) closeSync(directoryFd);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  } else {
    try { directoryFd = openSync(target, directoryFlags); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ELOOP") return false; throw error; }
  }
  if (directoryFd === undefined) return false;
  const boundDirectoryFd = directoryFd;
  const workspaces: FileHandle[] = [];
  try {
    const identity = fstatSync(boundDirectoryFd, { bigint: true });
    if (!sameDirectory(identity, await entry(target))) return false;
    const anchored = descriptorPath(boundDirectoryFd);
    let intent = prior;
    let nonce: string;
    if (original) {
      if (!sameDirectory(original, identity)) return false;
      const existing = JSON.parse((await fileBytes(path.join(anchored, INTENT), 4096)).toString());
      if (typeof existing.nonce !== "string" || existing.claim !== prior!.claim || sha256(existing.nonce) !== prior!.nonceDigest) return false;
      nonce = existing.nonce;
    } else {
      nonce = randomUUID();
      intent = { claim, inputs, device: String(identity.dev), inode: String(identity.ino), nonceDigest: sha256(nonce) };
      await permit("private-marker");
      await fs.writeFile(path.join(anchored, INTENT), JSON.stringify({ claim, nonce }), { flag: "wx" });
      await ports.intent(intent);
      if (!sameDirectory(identity, await entry(target))) return false;
    }
    const identities: string[][] = [];
    for (const member of members) {
      const binding = await bindWorkspaceModules(checkout, member, scratch, nonce, permit);
      workspaces.push(binding.directory);
      identities.push(binding.identity);
    }
    const workspacesMatch = () => verifyWorkspaceDirectories(checkout, identities);
    const cache = await fs.open(scratch, directoryFlags);
    try {
      await permit("install-in-place");
      if (!await workspacesMatch() || !sameDirectory(identity, await entry(target))) return false;
      const installed = await containedDependencyExec(process.execPath,
        ["--no-env-file", ports.workerEntry ?? process.argv[1]!, "install-bound", ...workspaces.map((_, index) => String(index + 5))], checkout,
        { NODE_ENV: "development", BUN_INSTALL_CACHE_DIR: path.join(scratch, "cache"), TMPDIR: scratch },
        { timeoutMs: budgetMs, inheritFd: boundDirectoryFd, additionalInheritedFds: [cache.fd, ...workspaces.map(directory => directory.fd)] });
      if (installed.code !== 0 || !sameDirectory(identity, await entry(target))) return false;
      const workspaceDigest = members.length ? await currentWorkspaceOutputDigest(checkout) : undefined;
      const retained = JSON.parse((await fileBytes(path.join(anchored, INTENT), 4096)).toString());
      if (retained.claim !== intent!.claim || retained.nonce !== nonce) return false;
      await permit("private-marker");
      if (!await verify() || !await workspacesMatch() || !sameDirectory(identity, await entry(target))) return false;
      const receipt = { claim: intent!.claim, inputs, device: String(identity.dev), inode: String(identity.ino),
        mode: "in-place" as const, workspaceDigest };
      try {
        await fs.writeFile(path.join(anchored, MARKER), JSON.stringify({ ...receipt, bun: Bun.version, nonceDigest: intent!.nonceDigest }), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const marker = JSON.parse((await fileBytes(path.join(anchored, MARKER), 4096)).toString());
        if (marker.claim !== intent!.claim || marker.inputs !== inputs || marker.bun !== Bun.version || marker.workspaceDigest !== workspaceDigest) return false;
      }
      if (!await verify() || !await workspacesMatch() || !sameDirectory(identity, await entry(target))) return false;
      await ports.receipt(receipt);
      return true;
    } finally { await cache.close(); }
  } finally {
    closeSync(boundDirectoryFd);
    await Promise.all(workspaces.map(directory => directory.close()));
  }
}
