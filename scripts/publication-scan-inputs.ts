import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fingerprint } from "./gate-cache";
import { readSafeRegularFile } from "./privacy-safe-path";

const catalogs = {
  LLV_PRIVACY_KNOWN_VALUES_FILE: "privacy known values catalog",
  LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: "privacy fingerprint catalog",
} as const;
const catalogNames = Object.keys(catalogs) as (keyof typeof catalogs)[];
export const publicationScanDirectory = "publication-scan";
const attributesFile = ".git/info/attributes";

class ScanInputError extends Error {
  constructor(readonly component: string, reason: string) { super(reason); }
}

function git(root: string, env: NodeJS.ProcessEnv, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0) throw new ScanInputError("privacy Git repository", "Git inspection input is unavailable");
  return result.stdout;
}

function readInput(file: string, component: string, optional: boolean, setting?: string): Buffer | undefined {
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
      if (optional) return undefined;
      throw new ScanInputError(component, setting ? `configured source is missing: ${setting}` : `missing ${component}`);
    }
    if ((stat.mode & 0o444) === 0) throw new Error("unreadable file");
    return readSafeRegularFile(file);
  } catch (error) {
    if (error instanceof ScanInputError) throw error;
    throw new ScanInputError(component, setting ? `cannot read configured source: ${setting}` : `cannot read ${component}`);
  }
}

export function publicationScanDriftComponent(error: unknown): string {
  return error instanceof ScanInputError ? publicationScanComponentLabel(error.component) : "privacy scan";
}

export function publicationScanComponentLabel(component: string): string {
  const catalog = catalogNames.find(name => catalogs[name] === component);
  return catalog ? `privacy files (${catalog})` : component;
}

/** Resolve all variable scan data together. Commit IDs bind the complete Git
 * graph, including the trees and blobs used for hunks and provenance. Git's
 * graph overrides and ambient system attributes are disabled for the scan.
 * Replay attribute matching and scalar diff settings. Capture path-valued
 * diff/attribute inputs as files. Git commands disable external diff drivers. */
export function publicationScanInputs(root: string, base: string, env: NodeJS.ProcessEnv) {
  const head = git(root, env, ["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const scanBase = git(root, env, ["--no-replace-objects", "rev-parse", "--verify", `${base}^{commit}`]).trim();
  if (git(root, env, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new ScanInputError("privacy Git repository", "publication privacy requires complete Git history");
  }
  const gitPath = (file: string) => git(root, env, ["rev-parse", "--path-format=absolute", "--git-path", file]).trimEnd();
  const values = git(root, env, ["config", "--null", "--includes", "--list"]).split("\0").filter(Boolean)
    .map((entry): [string, string] => {
      const end = entry.indexOf("\n");
      return end === -1 ? [entry, "true"] : [entry.slice(0, end), entry.slice(end + 1)];
    });
  const config = values.filter(([key]) => key === "core.ignorecase"
    || /^diff\./.test(key) && !/^(?:diff\.(?:external|orderfile)|diff\..+\.(?:command|textconv))$/.test(key));
  const configPath = (key: string) => {
    if (!values.some(([name]) => name === key)) return undefined;
    return path.resolve(root, git(root, env, ["config", "--null", "--path", "--get", key]).slice(0, -1));
  };
  const files = new Map<string, Buffer>();
  const objectFormat = git(root, env, ["rev-parse", "--show-object-format"]).trim();
  const components: Record<string, string> = { "privacy commit range": fingerprint([head, scanBase, objectFormat]) };
  const capture = (source: string | undefined, target: string, component: string, optional = false, setting?: string) => {
    const bytes = source ? readInput(source, component, optional, setting) : undefined;
    if (bytes) files.set(target, bytes);
    components[component] = bytes ? createHash("sha256").update(bytes).digest("hex") : fingerprint(null);
  };
  for (const name of catalogNames) {
    const source = env[name] ?? (name === "LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE" ? "scripts/privacy-known-value-fingerprints.json" : "");
    capture(source ? path.resolve(root, source) : undefined, `inputs/${name}`, catalogs[name], false, name);
  }
  capture(gitPath("info/attributes"), `repository/${attributesFile}`, "privacy attribute overlay", true);
  const userAttributes = configPath("core.attributesfile") ?? path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config"), "git/attributes");
  capture(userAttributes === "/dev/null" ? undefined : userAttributes,
    "inputs/user-attributes", "privacy user attributes", true);
  capture(configPath("diff.orderfile"), "inputs/diff-order", "privacy diff order");
  components["privacy git configuration"] = fingerprint(config);
  // The scanner uses entities for HTML decoding. Seal its installed runtime
  // beside the checked-out scanner so Bun resolves it inside the snapshot.
  const decoder = realpathSync(path.resolve(import.meta.dir, "../node_modules/entities"));
  const decoderFiles: [string, string][] = [];
  visit(decoder, (file, directory) => {
    if (directory) return;
    const relative = path.relative(decoder, file);
    const bytes = readInput(file, "privacy scanner dependencies", false)!;
    files.set(path.join("repository/node_modules/entities", relative), bytes);
    decoderFiles.push([relative, createHash("sha256").update(bytes).digest("hex")]);
  });
  components["privacy scanner dependencies"] = fingerprint(decoderFiles);
  components["privacy scan"] = fingerprint([1, components]);
  return { head, scanBase, config, files, components, objectFormat, objects: gitPath("objects") };
}

function copyObjects(objects: string, target: string, seen = new Set<string>()): void {
  if (seen.has(objects)) return;
  seen.add(objects);
  for (const entry of readdirSync(objects, { withFileTypes: true })) {
    if (entry.name !== "pack" && !/^[a-f0-9]{2}$/.test(entry.name)) continue;
    if (!entry.isDirectory()) throw new Error("invalid Git object storage");
    const destination = path.join(target, entry.name);
    mkdirSync(destination, { recursive: true });
    for (const file of readdirSync(path.join(objects, entry.name), { withFileTypes: true })) {
      const valid = entry.name === "pack" ? /^pack-[a-f0-9]+\.(?:pack|idx)$/.test(file.name) : /^[a-f0-9]{38,62}$/.test(file.name);
      if (!valid) continue;
      if (!file.isFile()) throw new Error("invalid Git object file");
      try {
        copyFileSync(path.join(objects, entry.name, file.name), path.join(destination, file.name),
          constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }
  const alternates = readInput(path.join(objects, "info/alternates"), "privacy Git repository", true);
  for (const alternate of alternates?.toString().split("\n").filter(Boolean) ?? []) {
    copyObjects(path.resolve(objects, alternate), target, seen);
  }
}

function visit(directory: string, file: (name: string, directory: boolean, symlink: boolean) => void) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(name, file);
    else file(name, false, entry.isSymbolicLink());
  }
  file(directory, true, false);
}

export function removePublicationScan(sandbox: string) {
  const snapshot = path.join(sandbox, publicationScanDirectory);
  if (!lstatSync(snapshot, { throwIfNoEntry: false })?.isDirectory()) return;
  visit(snapshot, (name, directory) => { if (directory) chmodSync(name, 0o700); });
  rmSync(snapshot, { recursive: true });
}

/** The scanner and any scratch Git clones it creates see one independent
 * object store and a private, detached checkout. No hard links, alternates,
 * include directives or path-valued Git settings point back to live inputs. */
export function sealPublicationScan(sandbox: string, inputs: ReturnType<typeof publicationScanInputs>, sourceEnv: NodeJS.ProcessEnv) {
  const physical = realpathSync(sandbox);
  const snapshot = path.join(physical, publicationScanDirectory);
  const repository = path.join(snapshot, "repository");
  const scratch = path.join(physical, "publication-scan-tmp");
  const env = Object.fromEntries(Object.entries(sourceEnv).filter(([name]) => !name.startsWith("GIT_") && name !== "BASH_ENV" && name !== "ENV"));
  Object.assign(env, {
    GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0",
    BUN_OPTIONS: "--no-env-file --no-install", HOME: path.join(snapshot, "home"), XDG_CONFIG_HOME: path.join(snapshot, "xdg"),
    XDG_CACHE_HOME: path.join(scratch, "cache"), TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    LLV_PRIVACY_FINGERPRINT_CACHE_DIR: path.join(scratch, "fingerprint-cache"),
  });
  mkdirSync(repository, { recursive: true, mode: 0o700 });
  mkdirSync(scratch, { mode: 0o700 });
  git(repository, env, ["init", "--quiet", "--template=", `--object-format=${inputs.objectFormat}`]);
  try { copyObjects(inputs.objects, path.join(repository, ".git/objects")); }
  catch { throw new ScanInputError("privacy Git repository", "Git objects could not be copied for publication privacy"); }
  const write = (relative: string, contents: Buffer | string, mode = 0o400) => {
    const file = path.join(snapshot, relative);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, contents, { mode, flag: "wx" });
    return file;
  };
  write("repository/.git/info/attributes", "* -filter -ident -working-tree-encoding -text\n");
  git(repository, env, ["checkout", "--quiet", "--detach", "--no-recurse-submodules", inputs.head]);
  rmSync(path.join(repository, attributesFile));
  for (const [file, bytes] of inputs.files) write(file, bytes);
  for (const name of catalogNames) env[name] = inputs.files.has(`inputs/${name}`) ? path.join(snapshot, "inputs", name) : "";
  git(repository, env, ["config", "--local", "core.ignoreCase", "false"]);
  for (const [key, value] of inputs.config) git(repository, env, ["config", "--local", "--add", key, value]);
  git(repository, env, ["config", "--local", "core.attributesFile", inputs.files.has("inputs/user-attributes")
    ? path.join(snapshot, "inputs/user-attributes") : "/dev/null"]);
  if (inputs.files.has("inputs/diff-order"))
    git(repository, env, ["config", "--local", "diff.orderFile", path.join(snapshot, "inputs/diff-order")]);

  // The scanner's historical-index helper resets its Git environment. Keep
  // that helper on the same system-attribute policy as the primary reader.
  const executable = Bun.which("git", { PATH: env.PATH ?? "" });
  if (!executable) throw new Error("Git is unavailable for the publication privacy scan");
  const quoted = "'" + executable.replaceAll("'", "'\\''") + "'";
  write("bin/git", `#!/bin/sh\nexport GIT_ATTR_NOSYSTEM=1\nexec ${quoted} "$@"\n`, 0o700);
  env.PATH = path.join(snapshot, "bin") + path.delimiter + (env.PATH ?? "");

  visit(snapshot, (name, directory, symlink) => {
    if (!symlink) chmodSync(name, directory || name === path.join(snapshot, "bin/git") ? 0o500 : 0o400);
  });
  // An owning process can change permissions. Detect intervening inode or
  // metadata changes too, even if a writer restores the original bytes.
  const stamp = () => {
    const hash = createHash("sha256");
    visit(snapshot, (name) => {
      const info = lstatSync(name, { bigint: true });
      hash.update(JSON.stringify([name, info.dev.toString(), info.ino.toString(), info.mode.toString(), info.ctimeNs.toString()]));
    });
    return hash.digest("hex");
  };
  const sealed = stamp();
  for (const [file, bytes] of inputs.files) {
    if (!readSafeRegularFile(path.join(snapshot, file)).equals(bytes))
      throw new ScanInputError("privacy scan", "publication privacy snapshot changed while sealing");
  }
  return { repository, env, assertSealed: () => {
    if (stamp() !== sealed) throw new ScanInputError("privacy scan", "publication privacy snapshot changed during scanning");
  } };
}
