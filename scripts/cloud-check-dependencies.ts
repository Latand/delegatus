import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const refusal = "DELEGATUS_ENVIRONMENT: installed dependencies do not match setup; rerun environment setup";
interface PackageMetadata { dependencies?: Record<string, string> }
interface Lock { workspaces: Record<string, Record<string, unknown>>; packages: Record<string, [string, string, PackageMetadata]>; patchedDependencies?: Record<string, string> }

/** The setup checkout is the dependency source. No resolver, lifecycle script
 * or package-manager network request runs in the agent phase. Copy rather than
 * link so checks cannot change the setup's installation. */
export function reuseCloudDependencies(source: string, target = process.cwd()): void {
  try {
    source = path.resolve(source);
    target = path.resolve(target);
    if (source === target || existsSync(path.join(target, "node_modules"))) throw new Error();
    const lock: Lock = Bun.JSON5.parse(readFileSync(path.join(target, "bun.lock"), "utf8"));
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
    for (const [key, [resolved]] of Object.entries(lock.packages)) {
      const match = resolved.match(/^(@?[^@]+)@(\d[^ ]*)$/);
      if (!match) throw new Error();
      const file = packageFile(key);
      // Bun may omit platform-specific optional packages and their subgraphs.
      if (!existsSync(file) && !required.has(key)) continue;
      const installed = JSON.parse(readFileSync(file, "utf8"));
      if (installed.name !== match[1] || installed.version !== match[2]) throw new Error();
    }
    cpSync(modules, path.join(target, "node_modules"), { recursive: true, dereference: true });
  } catch { throw new Error(refusal); }
}

if (import.meta.main) {
  try {
    if (!process.argv[2]) throw new Error(refusal);
    reuseCloudDependencies(process.argv[2]);
  } catch { console.error(refusal); process.exitCode = 78; }
}
