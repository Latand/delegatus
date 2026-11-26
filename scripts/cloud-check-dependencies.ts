import { cpSync, existsSync, lstatSync, readlinkSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const refusal = "DELEGATUS_ENVIRONMENT: installed dependencies do not match setup; rerun environment setup";
interface PackageMetadata { dependencies?: Record<string, string>; bin?: string | Record<string, string> }
interface Lock { workspaces: Record<string, Record<string, unknown>>; packages: Record<string, [string, string, PackageMetadata]>; patchedDependencies?: Record<string, string> }

/** The setup checkout is the dependency source. No resolver, lifecycle script
 * or package-manager network request runs in the agent phase. Copy rather than
 * link so checks cannot change the setup's installation. */
export function reuseCloudDependencies(source: string, target = process.cwd()): void {
  let copiedModules: string | undefined;
  let copyStarted = false;
  try {
    source = path.resolve(source);
    target = path.resolve(target);
    if (source === target) throw new Error();
    const lock = Bun.JSON5.parse(readFileSync(path.join(target, "bun.lock"), "utf8")) as Lock;
    const manifest = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
    // The current project has one workspace and a hoisted Bun installation.
    // Unknown layouts fail closed until their setup validator is implemented.
    if (Object.keys(lock.workspaces).length !== 1 || !lock.workspaces[""]) throw new Error();
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      const sorted = (value: unknown) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
      if (sorted(manifest[field]) !== sorted(lock.workspaces[""][field])) throw new Error();
    }
    const inputs = ["package.json", "bun.lock", "bunfig.toml", ...Object.values(manifest.patchedDependencies ?? {}) as string[]];
    for (const file of inputs) {
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error();
      const from = path.join(source, file), to = path.join(target, file);
      if (existsSync(from) !== existsSync(to) || (existsSync(to) && !readFileSync(from).equals(readFileSync(to)))) throw new Error();
    }
    const sortedEntries = (value: unknown) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
    if (sortedEntries(lock.patchedDependencies) !== sortedEntries(manifest.patchedDependencies)) throw new Error();
    const modules = path.join(source, "node_modules");
    if (!statSync(modules).isDirectory() || !Object.keys(lock.packages).length) throw new Error();
    const packageFile = (key: string) => {
      // Bun lock keys encode nested packages as parent/child, with scopes
      // consuming two path segments. Refuse links/git/unknown resolutions.
      const segments = key.split("/"), names: string[] = [];
      for (let index = 0; index < segments.length; index++) {
        const part = segments[index]!;
        if (!part || part === "." || part === ".." || part.includes("\\")) throw new Error();
        if (part.startsWith("@")) {
          const name = segments[++index];
          if (!name || name === "." || name === ".." || name.includes("\\")) throw new Error();
          names.push(`${part}/${name}`);
        } else names.push(part);
      }
      return path.join(modules, names.join("/node_modules/"), "package.json");
    };
    const required = new Set<string>();
    const resolve = (parent: string, name: string): string => {
      for (let current = parent; ; ) {
        const key = current ? `${current}/${name}` : name;
        if (Object.hasOwn(lock.packages, key)) return key;
        if (!current) throw new Error();
        // A scoped package is one segment in the dependency ancestry.
        current = current.replace(/(?:^|\/)(?:@[^/]+\/)?[^/]+$/, "");
      }
    };
    const pending = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).map(name => resolve("", name));
    // Every installed optional package also needs its required children.
    pending.push(...Object.keys(lock.packages).filter(key => existsSync(packageFile(key))));
    while (pending.length) {
      const key = pending.pop()!;
      if (required.has(key)) continue;
      required.add(key);
      const metadata = lock.packages[key]![2];
      for (const name of Object.keys(metadata.dependencies ?? {})) pending.push(resolve(key, name));
    }
    const declaredExecutables = new Map<string, Set<string>>();
    const binDirectories: { directory: string; scope: string }[] = [];
    const inspectNodeModules = (directory: string, parentKey = "") => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".bin") {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
          binDirectories.push({ directory: path.join(directory, entry.name), scope: parentKey });
          continue;
        }
        // Package-manager metadata is not importable by package name. Any other
        // non-package entry can shadow a locked package (for example foo.js).
        if ([".package-lock.json", ".modules.yaml", ".bun-tag"].includes(entry.name)) {
          if (entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
          continue;
        }
        if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error();
        if (entry.name.startsWith(".")) throw new Error();
        const entryPath = path.join(directory, entry.name);
        if (entry.name.startsWith("@")) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error();
          for (const scoped of readdirSync(entryPath, { withFileTypes: true })) {
            if (!scoped.isDirectory() && !scoped.isSymbolicLink()) throw new Error();
            inspectPackage(path.join(entryPath, scoped.name), `${parentKey ? `${parentKey}/` : ""}${entry.name}/${scoped.name}`, parentKey);
          }
        } else inspectPackage(entryPath, `${parentKey ? `${parentKey}/` : ""}${entry.name}`, parentKey);
      }
    };
    const inspectPackage = (directory: string, key: string, binScope: string) => {
      const file = path.join(directory, "package.json");
      if (!existsSync(file)) throw new Error();
      const resolved = lock.packages[key]?.[0];
      if (!resolved) throw new Error();
      const match = resolved.match(/^(@?[^@]+)@(\d[^ ]*)$/);
      const installed = JSON.parse(readFileSync(file, "utf8"));
      if (!match || installed.name !== match[1] || installed.version !== match[2]) throw new Error();
      const binName = String(installed.name).split("/").at(-1) ?? "";
      const bins: Record<string, string> = typeof installed.bin === "string"
        ? { [binName]: installed.bin }
        : installed.bin && typeof installed.bin === "object" ? installed.bin : {};
      for (const [name, executable] of Object.entries(bins)) {
        if (!name || path.isAbsolute(executable) || executable.split(/[\\/]/).includes("..")) throw new Error();
        const targetPath = realpathSync(path.resolve(directory, executable));
        const relative = path.relative(modules, targetPath);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error();
        const mapKey = `${binScope}\0${name}`;
        const targets = declaredExecutables.get(mapKey) ?? new Set<string>();
        targets.add(targetPath);
        declaredExecutables.set(mapKey, targets);
      }
      inspectNodeModules(path.join(directory, "node_modules"), key);
    };
    inspectNodeModules(modules);
    for (const { directory, scope } of binDirectories) for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) throw new Error();
      const targetPath = realpathSync(path.join(directory, entry.name));
      const relative = path.relative(modules, targetPath);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error();
      if (!declaredExecutables.get(`${scope}\0${entry.name}`)?.has(targetPath)) throw new Error();
    }
    for (const [key, [resolved]] of Object.entries(lock.packages)) {
      const match = resolved.match(/^(@?[^@]+)@(\d[^ ]*)$/);
      if (!match) throw new Error();
      const file = packageFile(key);
      // Bun may omit platform-specific optional packages and their subgraphs.
      if (!existsSync(file) && !required.has(key)) continue;
      const installed = JSON.parse(readFileSync(file, "utf8"));
      if (installed.name !== match[1] || installed.version !== match[2]) throw new Error();
    }
    for (const [patchName, patchFile] of Object.entries(lock.patchedDependencies ?? {})) {
      const packageName = patchName.slice(0, patchName.lastIndexOf("@"));
      const packageVersion = patchName.slice(patchName.lastIndexOf("@") + 1);
      const entries = Object.entries(lock.packages).filter(([, value]) => value[0] === `${packageName}@${packageVersion}`);
      if (entries.length !== 1) throw new Error();
      const packagePath = packageFile(entries[0]![0]);
      const check = spawnSync("git", ["apply", "--reverse", "--check", "--verbose", "--unsafe-paths", "--directory", path.relative(source, path.dirname(realpathSync(packagePath))), path.join(target, patchFile)], {
        cwd: source, encoding: "utf8",
      });
      if (check.error || check.status !== 0 || /Skipped patch/.test(`${check.stdout ?? ""}${check.stderr ?? ""}`)) throw new Error();
    }
    const destination = path.join(target, "node_modules");
    // Cloud retries retain their detached clone. Revalidate the locked setup
    // above, then replace only that clone's ignored dependency directory.
    if (existsSync(destination)) {
      if (!lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink()) throw new Error();
      rmSync(destination, { recursive: true, force: true });
    }
    copiedModules = destination;
    copyStarted = true;
    cpSync(modules, destination, { recursive: true, dereference: true });
    // Package-manager executable links are relative to .bin. Dereferencing
    // those links leaves a script whose relative imports resolve from .bin.
    // Recreate only links that resolve within the installed tree.
    const preserveBinLinks = (sourceDirectory: string, destinationDirectory: string) => {
      for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const from = path.join(sourceDirectory, entry.name), to = path.join(destinationDirectory, entry.name);
        if (entry.name === ".bin") {
          for (const executable of readdirSync(from, { withFileTypes: true })) {
            if (!executable.isSymbolicLink()) continue;
            const link = path.join(from, executable.name);
            const targetPath = path.resolve(path.dirname(link), readlinkSync(link));
            const relative = path.relative(modules, targetPath);
            if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error();
            const copiedTarget = path.join(destination, relative);
            rmSync(path.join(to, executable.name), { force: true });
            symlinkSync(path.relative(to, copiedTarget), path.join(to, executable.name));
          }
        }
        preserveBinLinks(from, to);
      }
    };
    preserveBinLinks(modules, destination);
    // Confirm every restored executable link resolves inside the candidate.
    const verifyBinLinks = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const child = path.join(directory, entry.name);
        if (entry.name === ".bin") for (const executable of readdirSync(child, { withFileTypes: true })) {
          if (!executable.isSymbolicLink()) continue;
          const relative = path.relative(destination, realpathSync(path.join(child, executable.name)));
          if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error();
        }
        verifyBinLinks(child);
      }
    };
    verifyBinLinks(destination);
  } catch {
    if (copyStarted && copiedModules) rmSync(copiedModules, { recursive: true, force: true });
    throw new Error(refusal);
  }
}

if (import.meta.main) {
  try {
    if (!process.argv[2]) throw new Error(refusal);
    reuseCloudDependencies(process.argv[2]);
  } catch { console.error(refusal); process.exitCode = 78; }
}
