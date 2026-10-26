import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExecPort } from "@/lib/workflows/provision";
import type { CloudStageAttempt } from "./cloudStage";
import { CONTROLLER_ARTIFACT_DIRECTORY } from "./controllerArtifacts";

type Patch = NonNullable<CloudStageAttempt["patch"]>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const patchFile = (directory: string, hash: string) => path.join(directory, `${hash}.patch`);

/** Build the expected tree in a private index before touching the lane. The
 * receipt and bytes survive a controller restart at the application seam. */
export async function prepareCloudPatch(directory: string, patch: string, head: string, cwd: string,
  exec: ExecPort, assertCurrent: () => void): Promise<Patch> {
  if (Buffer.byteLength(patch) > 16 * 1024 * 1024) throw new Error("Codex Cloud diff exceeded its byte limit");
  assertCurrent();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const hash = digest(patch), file = patchFile(directory, hash);
  await fs.writeFile(file, patch, { mode: 0o600 });
  const scratch = await fs.mkdtemp(path.join(directory, "index-"));
  const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
  const git = async (args: string[]) => {
    assertCurrent();
    const result = await exec("git", args, cwd, env, { timeoutMs: 30_000 });
    assertCurrent();
    if (result.code !== 0) throw new Error("Codex Cloud diff could not be prepared against the accepted head");
    return result.stdout;
  };
  try {
    await git(["read-tree", head]);
    if (patch) await git(["apply", "--cached", "--whitespace=nowarn", "--", file]);
    const names = (await git(["diff", "--cached", "--name-only", "-z", head, "--"])).split("\0");
    if (names.some(name => name.split("/").some((_, index, parts) => parts.slice(index).join("/").startsWith(CONTROLLER_ARTIFACT_DIRECTORY)))) throw new Error("Codex Cloud diff changes a controller-owned artifact");
    const tree = (await git(["write-tree"])).trim();
    if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("Codex Cloud diff tree is invalid");
    return { digest: hash, tree };
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}

/** The exact resulting index and worktree prove an interrupted apply landed.
 * Any partial or unrelated edit refuses recovery without discarding work. */
export async function applyCloudPatch(directory: string, patch: Patch, head: string, cwd: string,
  exec: ExecPort, assertCurrent: () => void, persist: () => void | Promise<void>): Promise<void> {
  const file = patchFile(directory, patch.digest);
  const bytes = await fs.readFile(file, "utf8");
  if (digest(bytes) !== patch.digest) throw new Error("Codex Cloud diff receipt mismatch");
  const git = async (args: string[]) => {
    assertCurrent();
    const result = await exec("git", args, cwd, undefined, { timeoutMs: 30_000 });
    assertCurrent();
    return result;
  };
  const current = await git(["rev-parse", "HEAD"]);
  if (current.code !== 0 || current.stdout.trim() !== head) throw new Error("Codex Cloud diff base moved");
  const index = await git(["write-tree"]);
  const unstaged = await git(["diff", "--quiet", "--"]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (index.code !== 0 || unstaged.code !== 0 || untracked.code !== 0 || untracked.stdout) throw new Error("Codex Cloud diff requires an unchanged lane worktree");
  if (patch.applying && index.stdout.trim() === patch.tree) {
    patch.applied = true;
    await persist();
    return;
  }
  const staged = await git(["diff", "--cached", "--quiet", head, "--"]);
  if (staged.code !== 0) throw new Error("Codex Cloud diff requires an unchanged lane index");
  patch.applying = true;
  await persist();
  if (bytes) {
    const applied = await git(["apply", "--index", "--whitespace=nowarn", "--", file]);
    if (applied.code !== 0) throw new Error("Codex Cloud diff application failed; preserve the lane worktree");
  }
  const appliedTree = await git(["write-tree"]);
  if (appliedTree.code !== 0 || appliedTree.stdout.trim() !== patch.tree) throw new Error("Codex Cloud applied diff tree differs from its receipt");
  patch.applied = true;
  await persist();
}
