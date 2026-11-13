import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// TypeScript's command-line entry is shared by its CLI and module wrappers.
// Interpose there in a private mount namespace: neither interpreter options
// nor the name of the script determines whether the compiler is counted.
const mountAndExec = String.raw`
import ctypes, json, os, sys
libc = ctypes.CDLL(None, use_errno=True)
for source, target in json.loads(sys.argv[1]):
    if libc.mount(source.encode(), target.encode(), None, 4096, None) != 0:
        raise OSError(ctypes.get_errno(), "compiler admission bind refused")
    # Keep nosuid/nodev/noexec flags locked by an enclosing agent namespace.
    flags = 4096 | 32 | 1 | (os.statvfs(target).f_flag & 14)
    if libc.mount(source.encode(), target.encode(), None, flags, None) != 0:
        raise OSError(ctypes.get_errno(), "compiler admission mount refused")
os.execvp(sys.argv[2], sys.argv[2:])
`;

export function withCompilerEntry(command: string[], cwd = process.cwd()) {
  // Mount namespaces are a Linux gate facility. Other platforms retain their
  // test admission and native owned-runner cleanup.
  if (process.platform !== "linux") return;
  const installations = new Set<string>();
  for (const directory of [cwd, path.resolve(import.meta.dir, "..")]) {
    // Bun's require.resolve can auto-install an absent package. Only an
    // installation actually on this command's filesystem belongs to its gate.
    for (let parent = directory; ; parent = path.dirname(parent)) {
      const manifest = path.join(parent, "node_modules/typescript/package.json");
      if (fs.existsSync(manifest)) {
        installations.add(path.dirname(fs.realpathSync(manifest)));
        break;
      }
      if (path.dirname(parent) === parent) break;
    }
  }
  let root: string | undefined;
  const mounts: [string, string][] = [];
  try {
    // Bun evaluates bunfig test preloads before BUN_OPTIONS preloads. Supply
    // their order through a private config, keeping tracked preload bytes
    // unchanged for publication's Git and input certification.
    const configOption = /(?:^|\s)--config=(\S*\/delegatus-test-config-\d+\.toml)(?=\s|$)/g;
    let previousConfig: string | undefined;
    process.env.BUN_OPTIONS = (process.env.BUN_OPTIONS ?? "").replace(configOption, (_match, file: string) => { previousConfig = file; return ""; }).trim();
    const config = path.join(cwd, "bunfig.toml");
    if (fs.existsSync(config)) {
      const settings = Bun.TOML.parse(fs.readFileSync(config, "utf8")) as { preload?: string[]; test?: { preload?: string | string[] } };
      const preloads = settings.test?.preload;
      const absolute = (entry: string) => fs.existsSync(path.resolve(cwd, entry)) ? path.resolve(cwd, entry) : entry;
      if (settings.preload) settings.preload = settings.preload.map(absolute);
      settings.test = { ...settings.test, preload: [path.join(import.meta.dir, "check-runtime-preload.mjs"),
        ...(typeof preloads === "string" ? [preloads] : preloads ?? []).map(absolute)] };
      // One empty mount target per temp root; config contents exist only
      // in this command's namespace. Its stable path binds prepare/transport
      // to identical BUN_OPTIONS without retaining per-run config files.
      const temp = os.tmpdir();
      const target = previousConfig && (path.dirname(previousConfig) === temp || /\s/.test(temp))
        ? previousConfig : path.join(temp, `delegatus-test-config-${process.getuid!()}.toml`);
      if (/\s/.test(target)) throw new Error("Bun admission config requires a whitespace-free temp path");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(target, "", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!fs.lstatSync(target).isFile()) throw new Error("test admission config target must be a regular file");
      root ??= fs.mkdtempSync(path.join(os.tmpdir(), "compiler-entry-"));
      const copy = path.join(root, "test-config.toml");
      const toml = Bun.TOML as typeof Bun.TOML & { stringify(value: unknown): string };
      fs.writeFileSync(copy, toml.stringify(settings), { mode: 0o600 });
      mounts.push([copy, target]);
      process.env.BUN_OPTIONS = `--config=${target} ${process.env.BUN_OPTIONS ?? ""}`.trim();
    }
    for (const installation of installations) {
      const lib = path.join(installation, "lib");
      if (!fs.existsSync(lib)) continue;
      let found = false;
      for (const name of fs.readdirSync(lib).sort()) {
        if (!name.endsWith(".js")) continue;
        const file = fs.realpathSync(path.join(lib, name));
        // A nested service starts in the manager's mount namespace. Rebuild
        // the entry even when our caller already sees an instrumented copy.
        const source = fs.readFileSync(file, "utf8").replace(
          /async (function executeCommandLine\([^)]*\) \{)\n\/\* delegatus compiler entry \*\/\nawait import\([^\n]+\)\.then\(m => m\.admitWorker\("compiler"\)\);/g,
          "$1",
        );
        const entry = /function executeCommandLine\([^)]*\) \{/g;
        if (!entry.test(source)) continue;
        found = true;
        root ??= fs.mkdtempSync(path.join(os.tmpdir(), "compiler-entry-"));
        const copy = path.join(root, `${mounts.length}.js`);
        const client = pathToFileURL(path.join(import.meta.dir, "check-worker-client.mjs")).href;
        const patched = source.replace(entry, match => `async ${match}\n/* delegatus compiler entry */\nawait import(${JSON.stringify(client)}).then(m => m.admitWorker("compiler"));`);
        fs.writeFileSync(copy, patched, { mode: 0o600 });
        mounts.push([copy, file]);
      }
      if (!found) throw new Error("compiler admission could not locate TypeScript's command-line entry; command did not run");
    }
    if (!mounts.length) return;
    // Lifecycle probes deliberately hide systemd with a minimal command PATH.
    // Resolve our own setup tools separately from the command's environment.
    const unshare = Bun.which("unshare") ?? "/usr/bin/unshare";
    const python = Bun.which("python3") ?? "/usr/bin/python3";
    return {
      command: [unshare, "--user", "--map-current-user", "--keep-caps", "--mount", "--propagation", "private",
        python, "-I", "-c", mountAndExec, JSON.stringify(mounts), ...command],
      release: () => fs.rmSync(root!, { recursive: true, force: true }),
    };
  } catch (error) {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
