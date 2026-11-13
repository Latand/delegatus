import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { attemptMutationCurrent, attemptPathWatches } from "./attemptMutationFence";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mutation-fence-")); roots.push(root);
  const tree = path.join(root, "tree"), checkout = path.join(root, "checkout");
  fs.mkdirSync(tree); fs.mkdirSync(checkout);
  return { root, tree, checkout };
}

test.skipIf(process.platform !== "linux").each(["tree", "checkout"] as const)(
  "a separate writer changing %s during the other validation refuses dispatch", changed => {
    const f = fixture();
    const current = attemptMutationCurrent([f.tree, f.checkout], () => {
      // Both validators may return stale successful observations. The queue
      // must reject either ordering without relying on a JS watcher callback.
      fs.lstatSync(f.tree); fs.lstatSync(f.checkout);
      execFileSync(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], "pin")',
        path.join(f[changed], ".delegatus-keep")]);
      return true;
    });
    expect(current).toBeFalse();
    expect(fs.readFileSync(path.join(f[changed], ".delegatus-keep"), "utf8")).toBe("pin");
  });

test.skipIf(process.platform !== "linux")("unchanged reads admit and a fresh fence observes its own interval", () => {
  const f = fixture();
  expect(attemptMutationCurrent([f.tree, f.checkout], () => { fs.readdirSync(f.tree); return true; })).toBeTrue();
  expect(attemptMutationCurrent([f.tree], () => { fs.writeFileSync(path.join(f.tree, "old"), "old"); return true; })).toBeFalse();
  expect(attemptMutationCurrent([f.tree], () => true)).toBeTrue();
  expect(attemptMutationCurrent([f.tree], () => false)).toBeFalse();
});

test.skipIf(process.platform !== "linux").each(["absent", "link"] as const)("an unavailable watch (%s) never admits", kind => {
  const f = fixture(), unavailable = path.join(f.root, kind);
  if (kind === "link") fs.symlinkSync(f.tree, unavailable);
  expect(() => attemptMutationCurrent([unavailable], () => true)).toThrow("watch unavailable");
  expect(attemptMutationCurrent([unavailable], () => false)).toBeFalse();
});

test.skipIf(process.platform !== "linux")("a marker write through an external hardlink invalidates the common fence", () => {
  const f = fixture(), marker = path.join(f.tree, ".git"), alias = path.join(f.checkout, "marker-alias");
  fs.writeFileSync(marker, ""); fs.linkSync(marker, alias);
  expect(attemptMutationCurrent([f.tree, { file: marker }], () => {
    execFileSync(process.execPath, ["-e", 'require("node:fs").writeFileSync(process.argv[1], "gitdir: /external")', alias]);
    return true;
  })).toBeFalse();
});

test.each(["darwin", "win32"])("an unavailable platform fence refuses before any validation (%s branch)", platform => {
  const previous = Object.getOwnPropertyDescriptor(process, "platform")!;
  let invoked = false;
  Object.defineProperty(process, "platform", { ...previous, value: platform });
  try {
    expect(() => attemptMutationCurrent([], () => { invoked = true; return true; })).toThrow("fence unavailable on this platform");
    expect(invoked).toBeFalse();
    expect(() => attemptMutationCurrent([], () => true, 0)).toThrow("fence unavailable on this platform");
  } finally { Object.defineProperty(process, "platform", previous); }
});

test.skipIf(process.platform !== "linux")("ancestor traffic is independent of a checkout discovery or an absent authority file", () => {
  const f = fixture(), marker = path.join(f.checkout, ".git");
  expect(attemptMutationCurrent(attemptPathWatches([marker]), () => {
    fs.writeFileSync(path.join(f.checkout, "unrelated"), "unrelated"); return true;
  })).toBeTrue();
  expect(attemptMutationCurrent(attemptPathWatches([marker]), () => { fs.mkdirSync(marker); return true; })).toBeFalse();
  const authority = path.join(f.root, "missing-state", "state.sqlite");
  expect(attemptMutationCurrent(attemptPathWatches([authority]), () => true)).toBeTrue();
  expect(attemptMutationCurrent(attemptPathWatches([authority]), () => {
    fs.mkdirSync(path.dirname(authority)); return true;
  })).toBeFalse();
});

test.skipIf(process.platform !== "linux")("an expired fence budget refuses before validation", () => {
  const f = fixture();
  let invoked = false;
  expect(() => attemptMutationCurrent([f.tree], () => { invoked = true; return true; }, 0)).toThrow("time budget exhausted");
  expect(invoked).toBeFalse();
});

test.skipIf(process.platform !== "linux").each(["content", "link", "mode"])(
  "structural checkout watches classify %s writes", mutation => {
    const f = fixture(), log = path.join(f.checkout, "build.log");
    fs.writeFileSync(log, "before");
    const admitted = attemptMutationCurrent([{ directory: f.checkout, content: false }], () => {
      if (mutation === "content") fs.appendFileSync(log, "after");
      else if (mutation === "link") fs.symlinkSync(f.tree, path.join(f.checkout, "dependency"));
      else fs.chmodSync(f.checkout, 0o755);
      return true;
    });
    expect(admitted).toBe(mutation === "content");
  });

test.skipIf(process.platform !== "linux")("overlapping watches retain marker content and structural checkout proofs", () => {
  const f = fixture(), marker = path.join(f.checkout, ".git"), log = path.join(f.checkout, "build.log");
  fs.writeFileSync(marker, "before"); fs.writeFileSync(log, "before");
  for (const watches of [
    [{ directory: f.checkout, content: false }, ...attemptPathWatches([marker])],
    [...attemptPathWatches([marker]), { directory: f.checkout, content: false }],
  ]) {
    expect(attemptMutationCurrent(watches, () => { fs.appendFileSync(log, "after"); return true; })).toBeTrue();
    expect(attemptMutationCurrent(watches, () => { fs.appendFileSync(marker, "after"); return true; })).toBeFalse();
  }
});

test.skipIf(process.platform !== "linux")("row authority runs after observations and its reads remain inside filesystem proof", () => {
  const f = fixture();
  let current = true;
  expect(() => attemptMutationCurrent([f.tree], () => { current = false; return true; }, 30_000, () => current))
    .toThrow("fence authority changed");
  expect(() => attemptMutationCurrent([f.tree], () => true, 30_000, () => {
    fs.writeFileSync(path.join(f.tree, ".delegatus-keep"), "pin"); return true;
  })).toThrow("filesystem proof changed");
});

test.skipIf(process.platform !== "linux").each([false, true])("database traffic rechecks row authority during the final read (revoked=%s)", revoked => {
  const f = fixture(), database = path.join(f.checkout, "state.sqlite");
  fs.writeFileSync(database, "before");
  let current = true, checks = 0;
  const run = () => attemptMutationCurrent(attemptPathWatches([database], "authority"), () => true, 30_000, () => {
    const observed = current;
    if (++checks === 1) {
      fs.appendFileSync(database, "write during the authority read");
      if (revoked) current = false;
    }
    return observed;
  });
  if (revoked) expect(run).toThrow("fence authority changed");
  else expect(run()).toBeTrue();
  expect(checks).toBe(2);
});
