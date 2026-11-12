import { checkFixtureParent } from "@/lib/testing/fixtureLifetime";
import fs from "node:fs";
import path from "node:path";

import { RuntimeImageStore } from "../runtimeImageStore";

const [root, maxBytesValue, tag, readyFile, startFile, writerLockWaitValue, publicationMode, controls] = process.argv.slice(2);
if (!root || !maxBytesValue || !tag || !readyFile || !startFile) process.exit(64);

const header = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
  "hex",
);
const data = Buffer.concat([header, Buffer.alloc(4 * 1024 * 1024, tag.charCodeAt(0))]);
fs.writeFileSync(readyFile, "ready");
const startDeadline = Date.now() + 30_000;
while (!fs.existsSync(startFile)) {
  checkFixtureParent();
  if (Date.now() >= startDeadline) throw new Error("runtime image writer did not reach its start barrier within 30 seconds");
  Bun.sleepSync(20);
}

function waitForRelease(filename: string): void {
  const deadline = Date.now() + 30_000;
  while (!fs.existsSync(filename)) {
    checkFixtureParent();
    if (Date.now() >= deadline) throw new Error("image writer fixture barrier timed out");
    Bun.sleepSync(5);
  }
}

if (publicationMode === "maintenance" && controls) {
  let paused = false;
  fs.lstatSync = new Proxy(fs.lstatSync, {
    apply(target, receiver, args) {
      if (!paused && path.basename(String(args[0])).startsWith(".writer-ticket.")) {
        paused = true;
        fs.writeFileSync(path.join(controls, "maintenance-scanned"), "ready");
        waitForRelease(path.join(controls, "maintenance-release"));
      }
      return Reflect.apply(target, receiver, args);
    },
  });
} else if (publicationMode === "gate-owner" && controls) {
  const writeFile = fs.writeFileSync;
  const link = fs.linkSync;
  let paused = false;
  fs.writeFileSync = (file, contents, options) => {
    const filename = String(file);
    if (!paused && path.basename(filename) === "owner.json"
      && path.basename(path.dirname(filename)) === ".writer-lock-gate") {
      paused = true;
      writeFile(path.join(controls, "gate-owner-paused"), "ready");
      waitForRelease(path.join(controls, "gate-owner-release"));
    }
    return writeFile(file, contents, options);
  };
  fs.linkSync = (from, to) => {
    if (!paused && path.basename(String(from)).startsWith(".writer-lock-gate.")
      && path.basename(String(from)).endsWith(".partial")
      && path.basename(String(to)) === ".writer-lock-gate") {
      paused = true;
      writeFile(path.join(controls, "gate-owner-paused"), "ready");
      waitForRelease(path.join(controls, "gate-owner-release"));
    }
    return link(from, to);
  };
} else if (publicationMode && controls) {
  // Reproduce the actual open/write cut in writeFileSync. Hold this process
  // with its descriptor open while a peer scans the acquisition queue.
  const writeFile = fs.writeFileSync;
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (path.dirname(String(to)).endsWith(".writer-lock-gate.queue")) {
      writeFile(path.join(controls, "ticket-published"), "ready");
    }
  };
  let paused = false;
  fs.writeFileSync = (file, contents, options) => {
    const filename = String(file);
    const ticket = path.dirname(filename).endsWith(".writer-lock-gate.queue")
      || path.basename(filename).startsWith(".writer-ticket.");
    if (paused || !ticket || typeof contents !== "string") return writeFile(file, contents, options);
    paused = true;
    const fd = fs.openSync(filename, "wx", 0o600);
    try {
      const cut = publicationMode === "empty" ? 0 : Math.floor(contents.length / 2);
      fs.writeSync(fd, contents.slice(0, cut));
      const milestone = path.join(controls, "publication-paused");
      // A /proc/self/fd path belongs to this child; the observer needs the
      // shared filesystem name rather than its own descriptor with that id.
      writeFile(`${milestone}.partial`, fs.realpathSync(filename));
      fs.renameSync(`${milestone}.partial`, milestone);
      waitForRelease(path.join(controls, "publication-release"));
      fs.writeSync(fd, contents.slice(cut));
    } finally { fs.closeSync(fd); }
  };
}

try {
  new RuntimeImageStore(root, {
    maxBytes: Number(maxBytesValue),
    ...(writerLockWaitValue ? { writerLockWaitMs: Number(writerLockWaitValue) } : {}),
  }).putMany([{
    base64: data.toString("base64"),
    mime: "image/png",
  }]);
  process.exit(0);
} catch (error) {
  if (error instanceof Error && error.message.includes("quota exceeded")) process.exit(2);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
