import crypto from "node:crypto";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import { canonicalProject } from "./aliases";
import { writeJsonDurably } from "@/lib/state/durableJson";

export type SetupRecipe = { command: string[]; cwd: string };
export type ApprovedSetupRecipe = SetupRecipe & { hash: string; approvedAt: string };
export type ReviewedSetupRecipe = SetupRecipe & { hash: string; files: Record<string, Buffer> };

/** Resolve only system trees mounted read-only by the setup sandbox. */
export async function setupInterpreter(executable: string): Promise<string> {
  const candidates = executable === "bun" ? [process.execPath]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(directory => path.resolve(directory, executable));
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (executable !== "bun" && !["/usr/", "/bin/"].some(prefix => resolved.startsWith(prefix))) continue;
      await fs.access(resolved, syncFs.constants.X_OK);
      if ((await fs.stat(resolved)).isFile()) return resolved;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw new Error("setup interpreter is unavailable in the sandbox's system trees");
}

const digest = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

function relative(value: string): boolean {
  return value === "." || (!!value && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !/[\\\x00-\x1f]/u.test(value) && value.split("/").every(part => part !== ".." && part !== ".git" && part !== ""));
}

export function setupRecipeOf(value: unknown): SetupRecipe {
  const recipe = value as Partial<SetupRecipe> | null;
  if (!recipe || !Array.isArray(recipe.command) || recipe.command.length < 1 || recipe.command.length > 32
    || !recipe.command.every(arg => typeof arg === "string" && arg.length > 0 && arg.length <= 2048 && !/[\x00-\x1f]/u.test(arg))
    || typeof recipe.cwd !== "string" || recipe.cwd.length > 2048 || !relative(recipe.cwd)) throw new Error("invalid setup recipe: command arguments and a relative cwd are required");
  const [executable, script] = recipe.command;
  const install = executable === "bun" && recipe.command.join(" ") === "bun install --frozen-lockfile";
  const direct = ["sh", "bash", "node", "python3", "bun"].includes(executable!) && script && relative(script) && !script.startsWith("-")
    && !["run", "install", "eval", "exec", "x"].includes(script);
  if (!install && !direct) throw new Error("setup requires a direct repository script or bun install --frozen-lockfile");
  return { command: [...recipe.command], cwd: recipe.cwd } as SetupRecipe;
}

/** Reject links at every component, including cwd: approval cannot escape the checkout. */
export async function setupPath(root: string, relativePath: string): Promise<string> {
  if (!relative(relativePath)) throw new Error("setup paths must stay inside the repository");
  let current = await fs.realpath(root);
  for (const part of relativePath.split("/")) {
    if (part === ".") continue;
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("setup paths may not contain symbolic links");
  }
  return current;
}

async function captureFile(file: string): Promise<Buffer> {
  const limit = 1024 * 1024;
  const handle = await fs.open(file, syncFs.constants.O_RDONLY | syncFs.constants.O_NOFOLLOW | syncFs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("setup files must be regular files of at most 1 MiB");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > limit) throw new Error("setup file grew beyond 1 MiB while it was read");
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

/** The command, cwd, and every file argument are part of the reviewed content.
 * Script bytes are captured once and mounted read-only at execution. */
export async function reviewSetupRecipe(root: string, value: unknown): Promise<ReviewedSetupRecipe> {
  const recipe = setupRecipeOf(value);
  const interpreter = await setupInterpreter(recipe.command[0]!);
  const install = recipe.command[1] === "install";
  if (install && recipe.cwd !== ".") throw new Error("frozen setup installs require the repository root");
  const cwd = await setupPath(root, recipe.cwd);
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("setup cwd must be a directory");
  const files: Record<string, Buffer> = {};
  const candidates = recipe.command[1] === "install"
    ? ["package.json", "bun.lock", "bun.lockb"] : recipe.command.slice(1);
  for (const candidate of candidates) {
    const arg = candidate.startsWith("-") ? candidate.split("=", 2)[1] : candidate;
    if (!arg) continue;
    if (!relative(arg)) throw new Error("setup file arguments must be repository-relative");
    const name = path.posix.join(recipe.cwd, arg);
    try {
      const file = await setupPath(root, name);
      const stat = await fs.stat(file);
      if (stat.isDirectory() && arg !== recipe.command[1]) continue;
      files[name] = await captureFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (arg === recipe.command[1] || arg.includes("/") || /\.(?:sh|[cm]?[jt]sx?|py)$/u.test(arg)) throw new Error("a setup script or file argument is missing");
    }
  }
  if (install && (!files[path.posix.join(recipe.cwd, "package.json")]
    || !["bun.lock", "bun.lockb"].some(name => files[path.posix.join(recipe.cwd, name)]))) throw new Error("frozen setup requires a manifest and Bun lockfile");
  if (install) {
    const manifest = JSON.parse(files["package.json"]!.toString("utf8"));
    if (Object.hasOwn(manifest, "workspaces")) throw new Error("workspace setup installs are unsupported; review a direct setup script instead");
    for (const key of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (manifest[key] && Object.values(manifest[key]).some(value => typeof value === "string" && /^(?:file:|link:|workspace:|[./])/u.test(value))) {
        throw new Error("local dependency setup installs are unsupported; review a direct setup script instead");
      }
    }
    // npm configuration may redirect execution/install inputs. Its absence is
    // pinned as empty bytes too, and mounted over any later replacement.
    try { files[".npmrc"] = await captureFile(await setupPath(root, ".npmrc")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      files[".npmrc"] = Buffer.alloc(0);
    }
  }
  const hash = digest(JSON.stringify({ ...recipe, interpreter, files: Object.keys(files).sort().map(name => [name, digest(files[name]!)]) }));
  return { ...recipe, hash, files };
}

function readSettings(): Record<string, ApprovedSetupRecipe | null> {
  try {
    const file = statePath("project-setup.json");
    if (syncFs.statSync(file).size > 1024 * 1024) throw new Error("oversized setup settings");
    const value = JSON.parse(syncFs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid setup settings");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("project setup settings are unreadable; repair them before starting setup");
  }
}

export function projectSetupRecipe(project: string): ApprovedSetupRecipe | null {
  const settings = readSettings();
  const key = canonicalProject(project);
  const inherited = Object.entries(settings).filter(([source]) => canonicalProject(source) === key).map(([, value]) => value);
  const value = (Object.hasOwn(settings, key) ? settings[key] : inherited[0]) ?? null;
  if (!Object.hasOwn(settings, key) && inherited.some(entry => entry?.hash !== value?.hash)) throw new Error("project setup approvals conflict after a project move; review again");
  if (value === null) return null;
  setupRecipeOf(value);
  if (!/^[a-f0-9]{64}$/.test(value.hash) || typeof value.approvedAt !== "string"
    || !Number.isFinite(Date.parse(value.approvedAt))) throw new Error("project setup approval is invalid");
  return value;
}

/** Only the operator route writes this file. No pipeline input copies approvals. */
export async function setProjectSetupRecipe(project: string, value: ApprovedSetupRecipe | null): Promise<void> {
  const settings = readSettings();
  settings[canonicalProject(project)] = value;
  if (Buffer.byteLength(JSON.stringify(settings)) + 1 > 1024 * 1024) throw new Error("project setup settings exceed 1 MiB");
  const file = statePath("project-setup.json");
  writeJsonDurably(file, settings, { space: 0 });
}
