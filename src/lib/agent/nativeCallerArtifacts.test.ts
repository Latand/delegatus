import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NativeCallerArtifacts } from "./nativeCallerArtifacts";

function inotifyDescriptors(): Set<string> {
  const descriptors = new Set<string>();
  const directory = fs.opendirSync("/proc/self/fd");
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      try {
        if (fs.readlinkSync(`/proc/self/fd/${entry.name}`) === "anon_inode:inotify") descriptors.add(entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    directory.closeSync();
  }
  return descriptors;
}

function withCollector(run: (collector: NativeCallerArtifacts, root: string, watchCount: () => number) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-artifact-watch-"));
  try {
    const before = inotifyDescriptors();
    const collector = new NativeCallerArtifacts();
    let fd: string;
    try {
      const added = [...inotifyDescriptors()].filter(descriptor => !before.has(descriptor));
      expect(added).toHaveLength(1);
      fd = added[0]!;
      run(collector, fs.realpathSync(root), () => (
        fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^inotify wd:/gm)?.length ?? 0
      ));
    } finally {
      collector.close();
    }
    expect(inotifyDescriptors().has(fd)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "linux")("releases the last reference to each kernel watch before close", () => {
  withCollector((collector, root, watchCount) => {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    const first = path.join(left, "first.jsonl");
    const alias = `${left}/./first.jsonl`;
    const second = path.join(right, "second.jsonl");
    fs.writeFileSync(first, "");
    fs.writeFileSync(second, "");

    const counts = [watchCount()];
    collector.add(first);
    const shared = watchCount();
    expect(shared).toBeGreaterThan(0);
    counts.push(shared);
    collector.add(alias);
    counts.push(watchCount());
    expect(collector.aliases(first)).toEqual(new Set([first, alias]));
    collector.add(second);
    counts.push(watchCount());
    collector.delete(first);
    counts.push(watchCount());
    expect(collector.aliases(first)).toEqual(new Set([alias]));

    // Leave named events in the queue alongside the watch removal events.
    fs.unlinkSync(first);
    collector.delete(alias);
    counts.push(watchCount());
    expect(collector.aliases(first)).toBeUndefined();
    expect(collector.aliases(second)).toEqual(new Set([second]));
    fs.unlinkSync(second);
    collector.delete(second);
    counts.push(watchCount());
    expect(counts).toEqual([0, shared, shared, shared + 1, shared + 1, shared, 0]);

    // Re-register with the old removal events still queued.
    fs.writeFileSync(first, "");
    collector.add(first);
    expect(watchCount()).toBe(shared);
    expect(collector.refresh(16)).toBe(true);
    expect(collector.aliases(first)).toEqual(new Set([first]));
  });
});

test.skipIf(process.platform !== "linux")("rebinds a changed alias and detects loss of a live watch", () => {
  withCollector((collector, root, watchCount) => {
    const left = path.join(root, "left");
    const right = path.join(root, "right");
    fs.mkdirSync(left);
    fs.mkdirSync(right);
    const first = path.join(left, "artifact.jsonl");
    const second = path.join(right, "artifact.jsonl");
    const alias = path.join(root, "alias.jsonl");
    fs.writeFileSync(first, "");
    fs.writeFileSync(second, "");
    fs.symlinkSync(first, alias);
    collector.add(alias);
    const initial = watchCount();
    expect(collector.aliases(first)).toEqual(new Set([alias]));

    fs.unlinkSync(alias);
    fs.symlinkSync(second, alias);
    expect(collector.refresh(16)).toBe(false);
    expect(collector.refresh(16)).toBe(true);
    expect(collector.aliases(first)).toBeUndefined();
    expect(collector.aliases(second)).toEqual(new Set([alias]));
    expect(watchCount()).toBe(initial);

    fs.unlinkSync(second);
    fs.rmdirSync(right);
    expect(() => collector.refresh(16)).toThrow("native caller artifact watch lost");
    collector.delete(alias);
    expect(watchCount()).toBe(0);
    expect(collector.refresh(16)).toBe(true);
  });
});
