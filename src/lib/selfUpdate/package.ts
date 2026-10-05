import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { realPorts } from "./steps";
import { writeAtomic } from "./apply";
import type { LauncherRecord } from "./launcher";
import type { RunnerPort } from "./service";
import { idleUpdate, type Revision, type UpdateState } from "./types";

/** A standalone server carries a copy of package.json. Its launcher
    belongs to the install above it, where bin/cli.mjs actually exists. */
export function manualInstallRoot(cwd = process.cwd()): string | null {
  let directory = cwd;
  for (;;) {
    try {
      if (existsSync(join(directory, "bin", "cli.mjs"))
        && JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === "delegatus-cli") return directory;
    } catch { /* Keep searching the install's ancestors. */ }
    const parent = dirname(directory); if (parent === directory) return null; directory = parent;
  }
}

export function packageRoot(record: LauncherRecord): string {
  if (record.installRoot) return record.installRoot;
  let directory = process.cwd();
  for (;;) {
    try { if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === "delegatus-cli") return directory; } catch { /* ascend */ }
    const parent = dirname(directory); if (parent === directory) throw new Error("The installed package root is unavailable"); directory = parent;
  }
}
/** One published version, as the registry describes it. `sha` is the commit
    the package was packed from: `gitHead`, which scripts/prepack.mjs writes
    into the packed manifest. Every version up to 1.9.0 was published without
    it and answers with an empty `sha`: such a version is named, and it is
    installed with its package manager, never from the dialog. */
export async function registryRevision(version = "latest", fetcher: typeof fetch = fetch): Promise<Revision> {
  if (!/^(latest|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/.test(version)) throw new Error("Invalid package version");
  const response = await fetcher(`https://registry.npmjs.org/delegatus-cli/${version}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Package registry answered ${response.status}`);
  const value = await response.json() as { version?: unknown; gitHead?: unknown };
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version)) throw new Error("The package registry named no version");
  const sha = typeof value.gitHead === "string" && /^[a-f0-9]{40}$/.test(value.gitHead) ? value.gitHead : "";
  return { version: value.version, sha, short: sha.slice(0, 7), date: "" };
}
/** SemVer precedence: numeric core, then prerelease identifiers; build
    metadata never changes precedence. Invalid versions fail the check closed. */
export function comparePackageVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
    if (!match) throw new Error("The package version is not valid SemVer");
    const pre = match[4]?.split(".") ?? [];
    if (pre.some(id => /^0\d+$/.test(id))) throw new Error("The package prerelease version is not valid SemVer");
    return { core: match.slice(1, 4).map(BigInt), pre };
  };
  const a = parse(left); const b = parse(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]! ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]; const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x); const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function packageVersion(root: string): string { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version; }

export class PackageRunner implements RunnerPort {
  state: UpdateState = idleUpdate(["fetch", "install", "ready"]);
  constructor(private readonly record: LauncherRecord, private readonly bun: string, private readonly env: Record<string, string>,
    private readonly logDir: string, private readonly changed: () => void, private readonly ports = realPorts(() => {}), private readonly registry = registryRevision) {}
  logPath(step: string): string { return join(this.logDir, `${step}.log`); }
  restore(state: UpdateState): void { this.state = state.state === "running" ? { ...state, state: "failed" } : state; }
  async retry(): Promise<void> { await this.start(this.state.target!, { version: this.state.targetVersion!, trigger: this.state.trigger ?? "operator" }); }
  async start(target: string, meta: { version?: string; trigger?: "operator" | "auto" | "seat" } = {}): Promise<void> {
    const version = meta.version!;
    if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("A package update needs its published version");
    const container = join(this.record.releasesDir, `npm-${version}`);
    const dir = join(container, "node_modules", "delegatus-cli");
    this.state = { ...idleUpdate(["fetch", "install", "ready"]), state: "running", target, targetShort: target.slice(0, 7), targetVersion: version, releaseDir: dir,
      trigger: meta.trigger ?? "operator", startedAt: new Date().toISOString() };
    mkdirSync(container, { recursive: true }); mkdirSync(this.logDir, { recursive: true });
    const steps = this.state.steps;
    for (let index = 0; index < steps.length; index++) {
      steps[index] = { ...steps[index]!, state: "running", startedAt: new Date().toISOString() }; this.changed();
      try {
        if (index === 0) {
          const revision = await this.registry(version);
          if (!revision.sha || revision.sha !== target) throw new Error("The package revision changed");
        } else if (index === 1) {
          writeAtomic(join(container, "package.json"), { private: true });
          const code = await this.ports.run([this.bun, "add", "--exact", `delegatus-cli@${version}`], { cwd: container, env: this.env, onLine: line => { steps[index]!.tail.push(line); steps[index]!.tail = steps[index]!.tail.slice(-40); this.changed(); } });
          if (code !== 0) throw new Error(`Package install exited with ${code}`);
        } else {
          if (packageVersion(dir) !== version || !existsSync(join(dir, "dist", "standalone", "server.js")) || !existsSync(join(dir, "dist", "runtime-host.mjs"))
            || !existsSync(join(dir, "bin", "launcher-relaunch.mjs"))) throw new Error("The package is missing its update runtime");
          writeAtomic(this.record.releasePointer, { kind: "package", version, sha: target, dir, baseVersion: packageVersion(packageRoot(this.record)) });
        }
        steps[index] = { ...steps[index]!, state: "done" };
      } catch (error) {
        steps[index] = { ...steps[index]!, state: "failed", failure: { kind: "error", text: error instanceof Error ? error.message : String(error) } };
        this.state = { ...this.state, state: "failed", finishedAt: new Date().toISOString() }; this.changed(); return;
      }
    }
    this.state = { ...this.state, state: "done", finishedAt: new Date().toISOString() }; this.changed();
  }
}
