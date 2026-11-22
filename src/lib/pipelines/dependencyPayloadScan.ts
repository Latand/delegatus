// Run in the owned dependency child so a filesystem stall or a large graph
// cannot block the Viewer. The source travels with the bootstrap module and
// needs no installed packages. Only digests and the executable/CLI inventory
// cross stdout.
export const dependencyPayloadScan = String.raw`
  import { createHash } from "node:crypto";
  import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
  import path from "node:path";

  const [root, content] = process.argv.slice(1);
  const metadata = createHash("sha256");
  const payload = content === "content" && createHash("sha256");
  const portable = payload && createHash("sha256");
  const buffer = payload && Buffer.allocUnsafe(256 * 1024);
  const executables = [], cliLinks = [];
  let reseal = false;
  const identity = entry => [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeNs, entry.ctimeNs, entry.nlink].join(":");

  function scan(file, relative) {
    const entry = lstatSync(file, { bigint: true });
    const stamp = identity(entry);
    metadata.update(JSON.stringify([relative, stamp]));
    if (entry.isSymbolicLink()) {
      const target = readlinkSync(file);
      portable && portable.update(JSON.stringify(["link", relative, target]));
      if (path.basename(path.dirname(file)) === ".bin") {
        cliLinks.push({ file: relative, target });
        // Frozen reinstalls recreate these symlinks with the same target.
        payload && payload.update(JSON.stringify(["cli", relative, target]));
      } else {
        payload && payload.update(JSON.stringify(["link", relative, String(entry.dev), String(entry.ino), target]));
      }
      return;
    }
    const mode = Number(entry.mode);
    const bin = entry.isDirectory() && path.basename(file) === ".bin"
      && path.basename(path.dirname(file)) === "node_modules";
    reseal ||= (mode & (bin ? 0o022 : 0o222)) !== 0;
    if (entry.isDirectory()) {
      if (payload) {
        const row = JSON.stringify(["directory", relative]);
        payload.update(row);
        portable.update(row);
      }
      for (const name of readdirSync(file).sort()) {
        scan(path.join(file, name), relative ? path.join(relative, name) : name);
      }
      if (identity(lstatSync(file, { bigint: true })) !== stamp) throw new Error("dependency directory changed during scan");
      return;
    }
    if (!entry.isFile()) throw new Error("unsupported dependency graph entry");
    if (mode & 0o111) executables.push(relative);
    if (!payload) return;
    payload.update(JSON.stringify(["file", relative, String(entry.dev), String(entry.ino), String(entry.size)]));
    portable.update(JSON.stringify(["file", relative, String(entry.size)]));
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (identity(fstatSync(fd, { bigint: true })) !== stamp) throw new Error("dependency file changed before scan");
      let count;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
        const chunk = buffer.subarray(0, count);
        payload.update(chunk);
        portable.update(chunk);
      }
      if (identity(fstatSync(fd, { bigint: true })) !== stamp) throw new Error("dependency file changed during scan");
    } finally { closeSync(fd); }
  }

  if (!lstatSync(root).isDirectory()) throw new Error("invalid dependency root");
  scan(root, "");
  process.stdout.write(JSON.stringify({ metadata: metadata.digest("hex"), payload: payload && payload.digest("hex"),
    portable: portable && portable.digest("hex"), reseal, executables, cliLinks }));
`;
