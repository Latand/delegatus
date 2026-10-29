import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPipeline } from "../store";
import { realExec } from "../../workflows/provision";

// Read dependency plans through the production builder; the installer, lockfile
// and package payload are real. A loopback registry keeps these cases offline.
export async function lockedFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "locked-dependencies-"));
  const repoDir = path.join(root, "repo");
  const pipeline = buildPipeline({ id: "12345678", task: "locked dependency fixture", project: "fixture", repoDir,
    stages: [], srcPath: null, srcConversationId: null, now: "2026-10-29T00:00:00.000Z" });
  const { worktreeDir } = pipeline;
  fs.mkdirSync(repoDir); fs.mkdirSync(worktreeDir);
  const archive = async (version: string) => await new Bun.Archive({
    "package/package.json": JSON.stringify({ name: "fixture-tool", version, bin: { "fixture-tool": "cli.js" } }),
    "package/index.js": `module.exports = ${JSON.stringify(version)};\n`,
    "package/cli.js": "#!/usr/bin/env node\nprocess.exit(0);\n",
  }, { compress: "gzip" }).bytes();
  const payloads = { previous: await archive("1.0.0"), current: await archive("2.0.0"), next: await archive("3.0.0") };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => new Response(
    request.url.endsWith("/next.tgz") ? payloads.next : request.url.endsWith("/previous.tgz") ? payloads.previous : payloads.current,
  ) });
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
      devDependencies: { "fixture-tool": `http://127.0.0.1:${server.port}/fixture.tgz` },
      scripts: { postinstall: "touch lifecycle-ran" },
    }));
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
      manifest.devDependencies["fixture-tool"] = `http://127.0.0.1:${server.port}/previous.tgz`;
      try {
        fs.writeFileSync(manifestFile, JSON.stringify(manifest));
        await run(["bun", "install", "--ignore-scripts", "--backend=copyfile"]);
      } finally {
        // A checkout update moves the inputs without refreshing the real old install.
        fs.writeFileSync(manifestFile, manifestBytes); fs.writeFileSync(lockFile, lockBytes);
      }
    };
    return { root, repoDir, worktreeDir, run, server, pipeline, makeLagging,
      close: () => { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { server.stop(true); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
