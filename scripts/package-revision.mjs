/* The commit a package was packed from, written into the packed manifest as
   `gitHead`. The release publishes a tarball (`npm publish <tarball>`), and a
   tarball has no git directory for npm to read, so the registry served no
   revision for any version up to 1.9.0. A packaged install's Update dialog
   reads this field (`registryRevision` in src/lib/selfUpdate/package.ts):
   prepack writes it, postpack takes it out of the working tree again, and the
   release gate refuses a packed manifest without it. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REVISION = /^[a-f0-9]{40}$/;
const STAMP = /^ {2}"gitHead": "[a-f0-9]{40}",\n/m;

export function headRevision(root, env = process.env) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const head = result.status === 0 ? result.stdout.trim() : "";
  if (REVISION.test(head)) return head;
  return REVISION.test(env.GITHUB_SHA ?? "") ? env.GITHUB_SHA : null;
}

/** Answers the revision written, or null when the package has none to name. */
export function stampPackageRevision(root, revision = headRevision(root)) {
  if (!revision || !REVISION.test(revision)) return null;
  const file = join(root, "package.json");
  const text = readFileSync(file, "utf8").replace(STAMP, "");
  const stamped = text.replace(/^( {2}"version": "[^"\n]*",\n)/m, `$1  "gitHead": "${revision}",\n`);
  if (stamped === text || JSON.parse(stamped).gitHead !== revision) throw new Error("package.json has no version line to stamp the revision after");
  writeFileSync(file, stamped);
  return revision;
}

export function restorePackageRevision(root) {
  const file = join(root, "package.json");
  const text = readFileSync(file, "utf8");
  const restored = text.replace(STAMP, "");
  if (restored !== text) writeFileSync(file, restored);
}

/** The release gate: the manifest that was packed names the commit it was
    packed from, in the field the updater reads. */
export function verifyPackedRevision(manifestFile, expected) {
  const revision = JSON.parse(readFileSync(manifestFile, "utf8")).gitHead;
  if (typeof revision !== "string" || !REVISION.test(revision)) throw new Error("The packed manifest names no gitHead; a packaged install could not update to this version from its dialog");
  if (expected && revision !== expected) throw new Error(`The packed manifest names ${revision}, and the release is ${expected}`);
  return revision;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--restore") restorePackageRevision(process.cwd());
    else if (process.argv[2] === "--verify" && process.argv[3]) console.log(verifyPackedRevision(process.argv[3], process.argv[4]));
    else throw new Error("Usage: package-revision.mjs --restore | --verify <packed package.json> [revision]");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
