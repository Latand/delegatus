import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildPipeline } from "../store";
import { realExec } from "../../workflows/provision";

function removeFixture(root: string): void {
  const writable = (filename: string) => {
    const entry = fs.lstatSync(filename);
    if (entry.isSymbolicLink()) return;
    fs.chmodSync(filename, (entry.mode & 0o777) | (entry.isDirectory() ? 0o700 : 0o200));
    if (entry.isDirectory()) for (const name of fs.readdirSync(filename)) writable(path.join(filename, name));
  };
  writable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

// Read dependency plans through the production builder; the installer, lockfile
// and package payload are real. A loopback registry keeps these cases offline.
export async function lockedFixture(options: { registry?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "locked-dependencies-"));
  const repoDir = path.join(root, "repo");
  const pipeline = buildPipeline({ id: "12345678", task: "locked dependency fixture", project: "fixture", repoDir,
    stages: [{ id: "build", kind: "run", prompt: "Build", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-10-29T00:00:00.000Z" });
  const { worktreeDir } = pipeline;
  fs.mkdirSync(repoDir); fs.mkdirSync(worktreeDir);
  const archive = async (version: string) => await new Bun.Archive({
    "package/package.json": JSON.stringify({ name: "fixture-tool", version, bin: { "fixture-tool": "cli.js" } }),
    "package/index.js": `module.exports = ${JSON.stringify(version)};\n`,
    "package/cli.js": "#!/usr/bin/env node\nprocess.exit(0);\n",
  }, { compress: "gzip" }).bytes();
  const payloads = { previous: await archive("1.0.0"), current: await archive("2.0.0"), next: await archive("3.0.0") };
  const parent = { name: "fixture-parent", version: "1.0.0", dependencies: { "fixture-tool": "1.0.0" } };
  const parentPayload = await new Bun.Archive({ "package/package.json": JSON.stringify(parent) }, { compress: "gzip" }).bytes();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => {
    const url = new URL(request.url);
    const dist = (name: string, bytes: Uint8Array) => ({ tarball: `${url.origin}/${name}.tgz`, shasum: createHash("sha1").update(bytes).digest("hex") });
    if (url.pathname === "/fixture-tool") return Response.json({ name: "fixture-tool", "dist-tags": { latest: "3.0.0" },
      versions: Object.fromEntries((["previous", "current", "next"] as const).map((name, index) => {
        const version = `${index + 1}.0.0`;
        return [version, { name: "fixture-tool", version, bin: { "fixture-tool": "cli.js" }, dist: dist(name, payloads[name]) }];
      })) });
    if (url.pathname === "/fixture-parent") return Response.json({ name: parent.name, "dist-tags": { latest: parent.version },
      versions: { [parent.version]: { ...parent, dist: dist("parent", parentPayload) } } });
    return new Response(url.pathname === "/parent.tgz" ? parentPayload : url.pathname === "/next.tgz" ? payloads.next
      : url.pathname === "/previous.tgz" ? payloads.previous : payloads.current);
  } });
  const env = { ...process.env, NODE_ENV: "development" };
  const run = async (args: string[], cwd = repoDir) => {
    const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", timeout: 20_000, killSignal: "SIGKILL" });
    const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code) throw new Error(stderr);
  };
  try {
    await run(["git", "init", "--initial-branch=main"]);
    fs.mkdirSync(path.join(repoDir, ".git/hooks"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "/node_modules\n");
    fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "delegatus-cli",
      devDependencies: options.registry ? { "fixture-tool": "2.0.0", "fixture-parent": "1.0.0" }
        : { "fixture-tool": `http://127.0.0.1:${server.port}/fixture.tgz` },
      scripts: { postinstall: "touch lifecycle-ran" },
    }));
    if (options.registry) fs.writeFileSync(path.join(repoDir, ".npmrc"), `registry=http://127.0.0.1:${server.port}\n`);
    await run(["bun", "install", "--ignore-scripts", "--backend=copyfile"]);
    for (const name of ["package.json", "bun.lock", ".gitignore"]) fs.copyFileSync(path.join(repoDir, name), path.join(worktreeDir, name));
    // Use a real linked checkout, so cache ownership is the common Git directory.
    await run(["git", "add", "."]);
    await run(["git", "-c", "user.name=Fixture", "-c", `user.email=${["noreply", "example.invalid"].join("@")}`, "commit", "-m", "fixture"]);
    fs.rmSync(worktreeDir, { recursive: true });
    pipeline.baseBranch = "main";
    pipeline.baseRef = (await realExec("git", ["rev-parse", "HEAD"], repoDir)).stdout.trim();
    await run(["git", "worktree", "add", "-b", pipeline.branch, worktreeDir]);
    const makeLagging = async () => {
      const manifestFile = path.join(repoDir, "package.json"), lockFile = path.join(repoDir, "bun.lock");
      const manifestBytes = fs.readFileSync(manifestFile), lockBytes = fs.readFileSync(lockFile);
      const manifest = JSON.parse(manifestBytes.toString());
      manifest.devDependencies["fixture-tool"] = options.registry ? "1.0.0" : `http://127.0.0.1:${server.port}/previous.tgz`;
      try {
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
        await run(["bun", "install", "--ignore-scripts", "--backend=copyfile"]);
      } finally {
        // A checkout update moves the inputs without refreshing the real old install.
        fs.writeFileSync(manifestFile, manifestBytes); fs.writeFileSync(lockFile, lockBytes);
      }
    };
    return { root, repoDir, worktreeDir, run, server, pipeline, makeLagging,
      close: () => { server.stop(true); removeFixture(root); } };
  } catch (error) { server.stop(true); removeFixture(root); throw error; }
}
