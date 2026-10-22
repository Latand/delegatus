import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { attemptReferencesClear, inspectAttemptTree, attemptTempUtilityImage } from "./attemptTempFilesystem";
import { AttemptTempStore, sweepAttemptTemps } from "./attemptTempRetention";
const exec = promisify(execFile);
const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const root = () => { const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-filesystem-")); roots.push(directory); return directory; };

test.skipIf(process.platform !== "linux")("a bound Unix socket keeps its attempt root", async () => {
  const directory = root(); const socket = path.join(directory, "held.sock");
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
  try { expect(await attemptReferencesClear(directory, directory, { ownNamespace: null, processes: [] })).toBeFalse(); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test.skipIf(process.platform !== "linux")("registered inspection streams beyond the legacy entry ceiling", async () => {
  const directory = root();
  // Empty fixtures keep allocation small while exercising an actual tree
  // larger than the old 200,000-entry inspection ceiling.
  for (let group = 0; group < 21; group++) {
    const child = path.join(directory, String(group)); fs.mkdirSync(child);
    for (let item = 0; item < 10000; item++) fs.closeSync(fs.openSync(path.join(child, String(item)), "w"));
  }
  expect(await inspectAttemptTree(directory)).toBeTrue();
}, 60000);

test.skipIf(process.env.LLV_ATTEMPT_TEMP_DOCKER_TEST !== "1")("container-owned private files retire through a scoped cleanup container", async () => {
  const directory = root(); const image = await attemptTempUtilityImage();
  const store = new AttemptTempStore(path.join(path.dirname(directory), path.basename(directory) + ".sqlite"));
  roots.push(store.filename); roots.push(store.filename + "-wal"); roots.push(store.filename + "-shm");
  cleanups.push(async () => {
    store.close();
    if (fs.existsSync(directory)) await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0",
      "--mount", `type=bind,source=${directory},target=/attempt`, "--entrypoint", "/bin/sh", image, "-c", "find /attempt -depth -mindepth 1 -delete"], { timeout: 15000 });
  });
  store.register({ directory, pipelineId: "fixture", launchId: "fixture", retainUntilClose: false, createdAt: 1 });
  await exec("docker", ["run", "--rm", "--pull=never", "--network=none", "--user=0", "--mount", `type=bind,source=${directory},target=/attempt`,
    "--entrypoint", "/bin/sh", image, "-c", "mkdir /attempt/private; echo fixture > /attempt/private/data; chown -R 12345:12345 /attempt/private; chmod 700 /attempt/private"], { timeout: 15000 });
  try {
    expect(() => fs.readdirSync(path.join(directory, "private"))).toThrow();
    const now = Date.parse("2030-01-01T00:00:00Z");
    const pin = path.join(directory, ".delegatus-keep"); fs.writeFileSync(pin, "keep");
    const sweep = (at: number) => sweepAttemptTemps(store, { now: () => at, state: async () => "closed", scan: () => ({ ownNamespace: null, processes: [] }) });
    expect((await sweep(now)).removed).toBe(0); expect(fs.existsSync(directory)).toBeTrue();
    fs.unlinkSync(pin);
    const report = await sweep(now + 60000);
    expect(report.errors).toBe(0); expect(report.removed).toBe(1); expect(fs.existsSync(directory)).toBeFalse();
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
