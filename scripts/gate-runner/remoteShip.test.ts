// ship() and the real serve.ts: a symlink, and what an export bundle carries (T4, T19).
// The remote command really runs, under a temporary runner home, through the
// real serve.ts (harness.fixture.ts); every file stays well under the 300 s
// file budget on a loaded runner, so each holds at most three cases.
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ship } from "./client";
import { cleanGitEnv, git, makeHarness, testFile, type Harness } from "./harness.fixture";

const linux = process.platform === "linux";
/** Several stub runs, each a full checkout, install and owned test run; slow under load. */
const E2E_TIMEOUT = 240_000;
const harnesses: Harness[] = [];
afterEach(() => { for (const h of harnesses.splice(0)) h.cleanup(); });
function harness(): Harness { const h = makeHarness(); harnesses.push(h); return h; }

// T4 (symlink) and T19 (what a bundle carries): ship() and the real serve.ts,
// without the privacy scan, which refuses any changed symlink.
test.if(linux)("a shipped tree keeps a symlink, and an export's bundle carries one gate-run commit on main", async () => {
  const h = harness();
  fs.symlinkSync("README.md", path.join(h.fixture, "readme-link"));
  const scratch = path.join(h.root, "ship"); fs.mkdirSync(scratch);
  const shipment = ship({ kind: "git", root: h.fixture }, scratch, h.base);
  const id = randomBytes(6).toString("hex");
  const dir = path.join(h.runnerHome, "runs", id);
  fs.mkdirSync(dir);
  fs.copyFileSync(shipment.bundle, path.join(dir, "run.bundle"));
  fs.copyFileSync(path.join(import.meta.dir, "serve.ts"), path.join(dir, "serve.ts"));
  const file = testFile(h, "link.test.ts", `import fs from "node:fs"; test("link", () => expect(fs.readlinkSync("readme-link")).toBe("README.md"));`);
  // The fixture file joins the tree after capture, so capture again.
  fs.rmSync(scratch, { recursive: true }); fs.mkdirSync(scratch);
  const again = ship({ kind: "git", root: h.fixture }, scratch, h.base);
  fs.copyFileSync(again.bundle, path.join(dir, "run.bundle"));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ version: 1, id, kind: "git", tree: again.tree, head: again.head, base: again.base, argv: ["bun", "test", file], cwd: ".", shape: "test", env: {}, outputs: [], chrome: false }));
  const nonce = randomBytes(32).toString("hex");
  // Standard input stays open as a client's does: end of file means the
  // client is gone, and serve.ts then stops the run.
  const session = spawn(process.execPath, [path.join(dir, "serve.ts"), "run", dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { HOME: h.runnerHome, PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, LLV_GATE_RUNNER_NODE_MODULES: fs.realpathSync(path.join(h.fixture, "node_modules")) } as unknown as NodeJS.ProcessEnv,
  });
  let stderr = "";
  session.stderr!.on("data", chunk => { stderr += chunk; });
  session.stdout!.resume();
  session.stdin!.write(`${nonce} -\n`);
  await new Promise(resolve => session.on("close", resolve));
  const run = { stderr };
  expect(run.stderr).toContain(`${nonce} started`);
  expect(run.stderr).toContain(`${nonce} end 0 ${again.tree}`);
  expect(shipment.tree).not.toBe(again.tree);

  // An export: one commit, its message "gate-run", on main's merge base.
  const exportRoot = path.join(h.root, "export"), checkout = path.join(exportRoot, "checkout");
  fs.mkdirSync(checkout, { recursive: true });
  spawnSync("bash", ["-c", `git -C ${h.fixture} archive ${h.head} | tar -x -C ${checkout}`], { env: cleanGitEnv() });
  fs.appendFileSync(path.join(checkout, "README.md"), "\nexport edit\n");
  const exportScratch = path.join(h.root, "ship-export"); fs.mkdirSync(exportScratch);
  const exported = ship({ kind: "export", root: checkout, record: { version: 1, checkout, head: h.head, repository: path.join(h.fixture, ".git") } }, exportScratch, h.base);
  const shipGit = (...args: string[]) => git(exportScratch, "--git-dir", path.join(exportScratch, "ship.git"), ...args);
  expect(exported.parent).toBe(h.base);
  expect(shipGit("rev-list", "refs/gate/tree", "--not", exported.parent!).split("\n")).toEqual([exported.commit]);
  expect(shipGit("log", "-1", "--format=%s|%an|%P", exported.commit)).toBe(`gate-run|gate-run|${h.base}`);
  expect(shipGit("bundle", "list-heads", exported.bundle)).toBe(`${exported.commit} refs/gate/tree`);
  expect(exported.changed).toContain("README.md");
  expect(fs.readdirSync(exportRoot)).toEqual(["checkout"]);
}, E2E_TIMEOUT);
