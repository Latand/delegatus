import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, expect, spyOn, test } from "bun:test";
import { attemptReferencesClear, inspectAttemptTree, attemptTempUtilityImage, removeAttemptTree, RepositoryLinkInventory } from "./attemptTempFilesystem";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
const exec = promisify(execFile);
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const root = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-filesystem-")); roots.push(directory); return directory; };

test.skipIf(process.platform !== "linux")("a bound Unix socket keeps its attempt root", async () => {
  const parent = root(), directory = path.join(parent, "actual/llv-stage-holder");
  fs.mkdirSync(directory, { recursive: true });
  const aliasParent = path.join(parent, "alias"); fs.symlinkSync(path.dirname(directory), aliasParent, "dir");
  const alias = path.join(aliasParent, path.basename(directory));
  const fd = fs.openSync(directory, "r");
  const socket = `/proc/self/fd/${fd}/held.sock`;
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes: [] })).toBeFalse();
    expect(await attemptReferencesClear(alias, alias, { ownNamespace: null, processes: [] })).toBeFalse();
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.closeSync(fd);
  }
});

test.skipIf(process.platform !== "linux")("registered inspection streams beyond the legacy entry ceiling", async () => {
  // Empty fixtures keep allocation small while exercising an actual tree
  // larger than the old 200,000-entry inspection ceiling. The fixture is made
  // and removed by native tools inside this test's own budget; a synchronous
  // removal in the shared hook outlived the hook timeout on loaded hosts.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-filesystem-"));
  try {
    for (let group = 0; group < 21; group++) {
      await exec("sh", ["-c", 'mkdir "$1" && cd "$1" && seq 0 9999 | xargs touch', "sh", path.join(directory, String(group))], { timeout: 60_000 });
    }
    expect(await inspectAttemptTree(directory)).toBeTrue();
  } finally {
    await exec("rm", ["-rf", "--", directory], { timeout: 60_000 });
  }
}, 150_000);

function repositoryProcesses(parent: string, count: number) {
  return Array.from({ length: count }, (_, n) => {
    const repository = path.join(parent, `repository-${n}`), cwd = path.join(repository, "work");
    fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(cwd);
    return { pid: 10_000 + n, namespace: null, stamped: false, paths: [cwd] };
  });
}

test("a settled root retires beside more than 32 unrelated checkouts; a linking checkout still holds it", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-busy-machine"); fs.mkdirSync(directory);
  const processes = repositoryProcesses(parent, 40);
  const scan = () => ({ ownNamespace: null, processes });
  expect(await attemptReferencesClear(directory, directory, scan(), async () => true)).toBeTrue();
  fs.mkdirSync(path.join(parent, "repository-39/nested"));
  fs.symlinkSync(path.join(directory, "packages"), path.join(parent, "repository-39/nested/node_modules"), "dir");
  expect(await attemptReferencesClear(directory, directory, scan(), async () => true)).toBeFalse();
});

test("one tick shares checkout walks and invalidates a negative result after a late link", async () => {
  const parent = root(), first = path.join(parent, "llv-stage-first"), second = path.join(parent, "llv-stage-second");
  fs.mkdirSync(first); fs.mkdirSync(second);
  const processes = repositoryProcesses(parent, 34);
  let now = 1_000;
  const inventory = new RepositoryLinkInventory({ now: () => now, freshMs: 10_000, budgetMs: 30_000 });
  for (const directory of [first, second])
    expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes }, async () => true, inventory)).toBeTrue();
  expect(inventory.walks.length).toBe(34);
  // Checkouts are read in name order; repository-9 is the last one.
  fs.symlinkSync(second, path.join(parent, "repository-9/work/late-link"), "dir");
  // Unchanged checkouts reuse their inventory. A nested directory change
  // invalidates just that checkout's negative result immediately.
  expect(await attemptReferencesClear(second, second, { ownNamespace: null, processes }, async () => true, inventory)).toBeFalse();
  expect(inventory.walks.length).toBe(35);
  now += 10_001;
  expect(await attemptReferencesClear(second, second, { ownNamespace: null, processes }, async () => true, inventory)).toBeFalse();
  expect(inventory.walks.length).toBe(69);
  now += 20_000;
  await expect(attemptReferencesClear(second, second, { ownNamespace: null, processes }, async () => true, inventory)).rejects.toThrow("tick budget");
});

test("a link created between directory enumeration and metadata capture cannot become a cached negative", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-link-race"); fs.mkdirSync(directory);
  const repository = path.join(parent, "repository"), cwd = path.join(repository, "work");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(cwd);
  const link = path.join(cwd, "node_modules");
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  let injected = false;
  const observed = spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    const entries = await readdir(target, options);
    if (!injected && target === cwd) { injected = true; fs.symlinkSync(directory, link, "dir"); }
    return entries;
  });
  const inventory = new RepositoryLinkInventory();
  const scan = { ownNamespace: null, processes: [{ pid: 7, namespace: null, stamped: false, paths: [cwd] }] };
  try {
    await expect(attemptReferencesClear(directory, directory, scan, async () => true, inventory)).rejects.toThrow("changed during link inventory");
    expect(await attemptReferencesClear(directory, directory, scan, async () => true, inventory)).toBeFalse();
    expect(fs.existsSync(directory)).toBeTrue();
  } finally { observed.mockRestore(); }
});

test("a nested link added during a later directory read defers the real sweep", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-race-target"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"), earlier = path.join(repository, "a"), later = path.join(repository, "b");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true }); fs.mkdirSync(earlier); fs.mkdirSync(later);
  const link = path.join(earlier, "dependency");
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  let injected = false;
  const observed = spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    const entries = await readdir(target, options);
    if (!injected && target === later) { injected = true; fs.symlinkSync(directory, link, "dir"); }
    return entries;
  });
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-lane", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  store.measure(directory, 4096); store.release(directory);
  const scan = { ownNamespace: null, processes: [{ pid: 42, namespace: null, stamped: false, paths: [repository] }] };
  const inventory = new RepositoryLinkInventory();
  let now = 2;
  const sweep = () => sweepAttemptTemps(store, { now: () => now, maxRoots: 1, capBytes: 0,
    state: async () => "closed",
    references: (original, current, currentScan) => attemptReferencesClear(original, current, currentScan, async () => true, inventory),
    scan: () => scan });
  try {
    const raced = await sweep();
    expect(injected).toBeTrue();
    expect(raced).toMatchObject({ removed: 0, deferred: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    observed.mockRestore();
    now += 60_001;
    const retry = await sweep();
    expect(retry).toMatchObject({ removed: 0, held: 1, errors: 0 });
    expect(fs.readlinkSync(link)).toBe(directory);

    fs.unlinkSync(link); store.defer(directory, 0);
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { observed.mockRestore(); store.close(); }
});

test("a real sweep rechecks an external symlink alias before removing its target root", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-linked-root"); fs.mkdirSync(directory);
  const data = path.join(directory, "data"); fs.writeFileSync(data, "owned scratch");
  const safe = path.join(parent, "safe"); fs.mkdirSync(safe); fs.writeFileSync(path.join(safe, "data"), "safe target");
  const alias = path.join(parent, "external-alias"); fs.symlinkSync(safe, alias, "dir");
  const repository = path.join(parent, "checkout"); fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.symlinkSync(path.join(alias, "data"), path.join(repository, "dependency"));
  const processScan = { ownNamespace: null, processes: [{ pid: 42, namespace: null, stamped: false, paths: [repository] }] };
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "fixture", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  const inventory = new RepositoryLinkInventory();
  let firstRead = true;
  try {
    const report = await sweepAttemptTemps(store, {
      now: () => Date.parse("2030-01-01T00:00:00Z"), capBytes: 0, state: async () => "closed",
      scan: () => processScan,
      references: async (original, current, scan) => {
        const clear = await attemptReferencesClear(original, current, scan, async () => true, inventory);
        if (firstRead) {
          firstRead = false;
          fs.unlinkSync(alias);
          fs.symlinkSync(directory, alias, "dir");
        }
        return clear;
      },
    });
    expect(report).toMatchObject({ removed: 0, held: 1, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(data, "utf8")).toBe("owned scratch");
    expect(fs.lstatSync(path.join(repository, "dependency")).isSymbolicLink()).toBeTrue();
  } finally { store.close(); }
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a failed checkout inventory names its real error and retries the recovered checkout in the same run", async () => {
  const parent = root();
  const repository = path.join(parent, "repository"), blocked = path.join(repository, "blocked");
  fs.mkdirSync(blocked, { recursive: true }); fs.chmodSync(blocked, 0);
  const inventory = new RepositoryLinkInventory();
  try {
    await expect(inventory.targets(repository)).rejects.toThrow("permission denied");
    fs.chmodSync(blocked, 0o700);
    expect(await inventory.targets(repository)).toEqual([]);
    expect(inventory.walks).toHaveLength(2);
  } finally { fs.chmodSync(blocked, 0o700); }
});

test.each(["before walk", "during walk"])("an absent checkout refuses inventory and retries after restoration (%s)", async disappearance => {
  const parent = root(), repository = path.join(parent, "checkout"), directory = path.join(parent, "llv-stage-linked");
  fs.mkdirSync(directory);
  if (disappearance === "during walk") fs.mkdirSync(repository);
  const directoryReads = fs.promises as unknown as {
    readdir: (target: fs.PathLike, options: { withFileTypes: true }) => Promise<fs.Dirent[]>;
  };
  const readdir = directoryReads.readdir.bind(directoryReads);
  const observed = spyOn(directoryReads, "readdir").mockImplementation(async (target, options) => {
    const entries = await readdir(target, options);
    if (target === repository && disappearance === "during walk") fs.renameSync(repository, repository + "-previous");
    return entries;
  });
  const inventory = new RepositoryLinkInventory({ now: () => 1_000 });
  try { await expect(inventory.targets(repository)).rejects.toThrow(); }
  finally { observed.mockRestore(); }
  fs.mkdirSync(repository);
  fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
  expect(await inventory.targets(repository)).toContain(directory);
  expect(inventory.walks).toHaveLength(2);
});

test.skipIf(process.platform === "win32")("a large unrelated checkout allows reclaim and its nested link still holds scratch", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "llv-large-checkout-"));
  const repository = path.join(parent, "checkout"), directory = path.join(parent, "llv-stage-settled");
  fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "data"), "retained payload");
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  try {
    for (let group = 0; group < 21; group++) {
      await exec("sh", ["-c", 'mkdir "$1" && cd "$1" && seq 0 9999 | xargs touch', "sh", path.join(repository, String(group).padStart(2, "0"))], { timeout: 60_000 });
    }
    store.register({ directory, pipelineId: "closed-lane", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
    store.measure(directory, 4096); store.release(directory);
    const link = path.join(repository, "20", "dependency"); fs.symlinkSync(directory, link, "dir");
    const sweep = () => sweepAttemptTemps(store, { now: () => 2, maxRoots: 1, capBytes: 0, state: async () => "closed",
      references: (original, current, scan) => attemptReferencesClear(original, current, scan, async () => true, inventory),
      scan: () => ({ ownNamespace: null, processes: [{ pid: 999, namespace: null, stamped: false, paths: [repository] }] }) });
    // Reuse the full inventory through the real sweep's deletion boundaries.
    const inventory = new RepositoryLinkInventory();
    expect(await sweep()).toMatchObject({ removed: 0, held: 1, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "data"), "utf8")).toBe("retained payload");
    expect(inventory.walks).toHaveLength(1);
    fs.unlinkSync(link); store.defer(directory, 0);
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
    expect(inventory.walks).toHaveLength(2);
  } finally { store.close(); await exec("rm", ["-rf", "--", parent], { timeout: 60_000 }); }
}, 150_000);

test("an absent checkout is never a successful empty inventory", async () => {
  const inventory = new RepositoryLinkInventory();
  const repository = path.join(root(), "gone");
  await expect(inventory.targets(repository)).rejects.toThrow();
  await expect(inventory.targets(repository)).rejects.toThrow();
  expect(inventory.walks).toHaveLength(2);
});

test.each([1, 2, 3])("an absent consumer checkout keeps scratch at removal observation %i and permits later reclaim", async boundary => {
  const parent = root(), directory = path.join(parent, "llv-stage-restored-consumer");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"), cwd = path.join(repository, "work");
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(repository, ".git"));
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-producer", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  let now = 1000, reads = 0, containers = 0;
  let inventory = new RepositoryLinkInventory({ now: () => now });
  const processes = [{ pid: 42, namespace: null, stamped: false, paths: [cwd] }];
  const sweep = () => sweepAttemptTemps(store, { now: () => now, capBytes: 0, state: async () => "closed",
    scan: () => ({ ownNamespace: null, processes }),
    references: async (original, current, scan) => {
      if (++reads === boundary) { now += 10001; fs.renameSync(repository, repository + "-previous"); }
      return attemptReferencesClear(original, current, scan, async () => {
        containers++;
        // This is the retained probe's former deletion window. An absent
        // checkout must stop the observation before this await is reached.
        if (reads === boundary) {
          await Promise.resolve();
          fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(repository, ".git"));
          fs.symlinkSync(original, path.join(repository, "dependency"), "dir");
        }
        return true;
      }, inventory);
    } });
  // Discover the consumer before its cwd disappears, as in the retained probe.
  expect(inventory.repositoryOf(cwd)).toBe(repository);
  try {
    expect(await sweep()).toMatchObject({ removed: 0, errors: 1 });
    expect(reads).toBe(boundary); expect(containers).toBe(boundary - 1);
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(path.join(repository, ".git"));
    const link = path.join(repository, "dependency"); fs.symlinkSync(directory, link, "dir");
    now += 60001; inventory = new RepositoryLinkInventory({ now: () => now });
    expect(await sweep()).toMatchObject({ removed: 0, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    fs.unlinkSync(link); now += 60001; inventory = new RepositoryLinkInventory({ now: () => now });
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
  } finally { store.close(); }
});

test.skipIf(process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1" || process.getuid?.() === 0).each(["plain", "capture", "late-capture", "dispatch-capture", "fallback-capture", "bmp-capture", "bmp-dispatch-capture", "bmp-fallback-capture"])("container-owned private files retain evidence and retire empty scratch (%s)", async variant => {
  const kind = variant.replace(/^bmp-/, ""), extension = variant.startsWith("bmp-") ? "BMP" : "png";
  const parent = root(), directory = path.join(parent, "llv-stage-private"); fs.mkdirSync(directory);
  const image = await attemptTempUtilityImage();
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  cleanups.push(async () => {
    store.close();
    if (fs.existsSync(directory)) await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c", "find /attempt -depth -mindepth 1 -delete"], { timeout: 15000 });
  });
  store.register({ directory, pipelineId: "fixture", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0", "--mount", `type=bind,source=${directory},target=/attempt`,
    "--entrypoint", "/bin/sh", image, "-c", "mkdir -p /attempt/private/deep; dd if=/dev/zero of=/attempt/private/data bs=1048576 count=4 2>/dev/null; chown -R 12345:12345 /attempt/private; chmod 700 /attempt/private"], { timeout: 15000 });
  try {
    expect(() => fs.readdirSync(path.join(directory, "private"))).toThrow();
    const now = Date.parse("2030-01-01T00:00:00Z");
    const pin = path.join(directory, ".delegatus-keep"); fs.writeFileSync(pin, "keep");
    const sweep = (at: number) => sweepAttemptTemps(store, { now: () => at, state: async () => "closed", scan: () => ({ ownNamespace: null, processes: [] }) });
    expect((await sweep(now)).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    fs.unlinkSync(pin);
    const writeCapture = () => exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c",
      `mkdir -p /attempt/private/deep; printf 'private capture' > /attempt/private/deep/frame.${extension}`], { timeout: 15000 });
    const readCapture = async () => (await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt,readonly`, "--entrypoint", "/bin/cat", image,
      `/attempt/private/deep/frame.${extension}`], { timeout: 15000 })).stdout;
    if (kind === "capture") {
      await writeCapture();
      expect((await sweep(now + 60000)).removed).toBe(0);
      expect(await readCapture()).toBe("private capture");
      return;
    }
    if (kind === "dispatch-capture" || kind === "fallback-capture") {
      await expect(removeAttemptTree(directory, directory, async () => { await writeCapture(); return true; }, kind === "dispatch-capture")).rejects.toThrow();
      expect(await readCapture()).toBe("private capture");
      return;
    }
    if (kind === "late-capture") {
      let reads = 0;
      const report = await sweepAttemptTemps(store, { now: () => now + 60000, scan: () => ({ ownNamespace: null, processes: [] }),
        references: async () => true, state: async () => {
          if (++reads === 2) await writeCapture();
          return "closed";
        } });
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(report.removed).toBe(0);
      expect(await readCapture()).toBe("private capture");
      return;
    }
    let report;
    // Other test runs may remove a container between ps and inspect. Production
    // must retain this tree on that incomplete observation, then retry next tick.
    for (let tick = 1; tick <= 4; tick++) {
      report = await sweep(now + tick * 60000);
      if (report.removed) break;
      expect(report.held + report.errors).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(directory, "private"))).toBeTrue();
    }
    expect(report!.errors).toBe(0); expect(report!.removed).toBe(1); expect(report!.removedBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024); expect(fs.existsSync(directory)).toBeFalse();
  } finally { store.close(); }
}, 60000);


test.skipIf(process.platform !== "linux")("an incomplete container inventory cannot authorize deletion", async () => {
  const directory = root();
  const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
  const docker = path.join(bin, "docker");
  fs.writeFileSync(docker, '#!/bin/sh\nif [ "$1" = ps ]; then printf "111111111111\\n"; else printf "[]\\n"; fi\n', { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = bin + path.delimiter + previous;
  try { expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes: [] })).toBeFalse(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});


test.skipIf(process.platform !== "linux")("a complete inventory above 64 unrelated containers permits retirement", async () => {
  const directory = root(); const bin = path.join(directory, "bin"); fs.mkdirSync(bin);
  const ids = Array.from({ length: 65 }, (_, n) => String(n + 1).padStart(12, "0"));
  const script = `#!/bin/sh
if [ "$1" = ps ]; then
printf '%s\\n' ${ids.join(" ")}
else
for id in "$@"; do case "$id" in [0-9]*) printf '{"Id":"%s","Mounts":[]}\\n' "$id";; esac; done
fi
`;
  fs.writeFileSync(path.join(bin, "docker"), script, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + (previous ?? "");
  try { expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes: [] })).toBeTrue(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test.skipIf(process.platform !== "linux")("a container bind through a physical parent alias retains scratch", async () => {
  const parent = root(), directory = path.join(parent, "actual/llv-stage-mounted");
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(path.dirname(directory), path.join(parent, "alias"), "dir");
  const alias = path.join(parent, "alias", path.basename(directory));
  const bin = path.join(parent, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "docker"), `#!${process.execPath}\nif (process.argv[2] === "ps") console.log("111111111111"); else console.log(${JSON.stringify(JSON.stringify({ Id: "111111111111", Mounts: [{ Type: "bind", Source: directory }] }))});\n`, { mode: 0o700 });
  const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + (previous ?? "");
  try { expect(await attemptReferencesClear(alias, alias, { ownNamespace: null, processes: [] })).toBeFalse(); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});


test.each(["cache/uv/sdists-v9", "uv-cache/sdists-v9", "uvcache/sdists-v9/nested"])("real uv layout %s is disposable", async layout => {
  const directory = root(), marker = path.join(directory, layout, ".git");
  fs.mkdirSync(path.dirname(marker), { recursive: true }); fs.writeFileSync(marker, "");
  expect(await inspectAttemptTree(directory)).toBeTrue();
  fs.writeFileSync(marker, "unknown");
  expect(await inspectAttemptTree(directory)).toBeFalse();
});

test("fixture Git worktrees contained in the attempt can retire", async () => {
  const directory = root(), repo = path.join(directory, "repo"), wt = path.join(directory, "wt");
  fs.mkdirSync(repo);
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["-C", repo, "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "commit", "--allow-empty", "-qm", "fixture"]);
  await exec("git", ["-C", repo, "worktree", "add", "--detach", wt]);
  expect(await inspectAttemptTree(directory)).toBeTrue();
  const external = root();
  await exec("git", ["-C", repo, "worktree", "add", "--detach", path.join(external, "outside")]);
  expect(await inspectAttemptTree(directory)).toBeFalse();
  expect(await inspectAttemptTree(wt)).toBeFalse();
});

test.each([".git", "project/.git", ".delegatus-keep"])("unknown marker %s is retained", async marker => {
  const directory = root(), file = path.join(directory, marker);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "");
  expect(await inspectAttemptTree(directory)).toBeFalse();
});


test.skipIf(process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1" || process.getuid?.() === 0).each(["uv", "internal", "missing", "external", "unknown", "pin"])("private container marker classifier preserves its boundary (%s)", async kind => {
  const directory = root(), privateRoot = path.join(directory, "private");
  fs.mkdirSync(privateRoot);
  const image = await attemptTempUtilityImage();
  const docker = (script: string) => exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
    "--mount", `type=bind,source=${directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c", script], { timeout: 15_000 });
  cleanups.push(async () => { await docker("find /attempt -depth -mindepth 1 -delete"); });
  if (kind === "uv") {
    const cache = path.join(privateRoot, "cache/uv/sdists-v9"); fs.mkdirSync(cache, { recursive: true }); fs.writeFileSync(path.join(cache, ".git"), "");
  } else if (kind === "pin") fs.writeFileSync(path.join(privateRoot, ".delegatus-keep"), "keep");
  else if (kind === "internal") {
    const metadata = path.join(privateRoot, "metadata"); fs.mkdirSync(metadata);
    fs.writeFileSync(path.join(privateRoot, ".git"), `gitdir: ${metadata}\n`);
  } else fs.writeFileSync(path.join(privateRoot, ".git"), kind === "unknown" ? "unknown" : `gitdir: ${kind === "missing" ? path.join(privateRoot, "absent") : root()}\n`);
  await docker("chown -R 12345:12345 /attempt/private; chmod 700 /attempt/private");
  expect(() => fs.readdirSync(privateRoot)).toThrow();
  expect(await inspectAttemptTree(directory)).toBe(kind === "uv" || kind === "internal");
}, 60_000);


test.skipIf(process.platform !== "linux")("a closed lane's checkout link stops holding scratch when its real consumer exits", async () => {
  const parent = root(), directory = path.join(parent, "llv-stage-dead-consumer");
  fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "payload"), "keep");
  const repository = path.join(parent, "checkout"); fs.mkdirSync(path.join(repository, ".git"), { recursive: true });
  fs.symlinkSync(directory, path.join(repository, "dependency"), "dir");
  const store = new AttemptTempStore(path.join(parent, "owners.sqlite"));
  store.register({ directory, pipelineId: "closed-lane", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "attemptTempRetention.fixture.ts"), "--hold"], {
    cwd: repository, env: { ...process.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let now = 1000;
  // Read only this fixture's PID. The shared machine's process inventory is
  // outside this test's observations and cannot affect its removal result.
  const scan = () => {
    let cwd: string | undefined;
    try { cwd = fs.readlinkSync(`/proc/${child.pid}/cwd`); } catch { /* Exited consumer. */ }
    return { ownNamespace: null, processes: cwd ? [{ pid: child.pid, namespace: null, stamped: false, paths: [cwd] }] : [] };
  };
  const sweep = () => sweepAttemptTemps(store, { now: () => now, state: async () => "closed", scan,
    references: (original, current, observed) => attemptReferencesClear(original, current, observed, async () => true) });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
    expect(await sweep()).toMatchObject({ removed: 0, liveHeld: 1, errors: 0 });
    expect(fs.readFileSync(path.join(directory, "payload"), "utf8")).toBe("keep");
    child.stdin.end(); expect(await child.exited).toBe(0);
    now += 60001;
    expect(await sweep()).toMatchObject({ removed: 1, errors: 0 });
    expect(fs.existsSync(directory)).toBeFalse();
    expect(fs.lstatSync(path.join(repository, "dependency")).isSymbolicLink()).toBeTrue();
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await child.exited; store.close();
  }
});
