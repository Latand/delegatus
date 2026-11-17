import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { KEEP_PNG } from "./localFile.fixture";
import { admittedAs, lexicalAllowedRoots, realAllowedRoots } from "./localFile";
import { mintFrameScope } from "./frameScope";
import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";
import { keepWrittenPictures } from "@/lib/reportMedia/store";
import { reportMediaRoot, reportMediaRows } from "@/lib/reportMedia/lookup";
import { GET as artifact } from "@/app/api/artifact/route";
import { GET as image } from "@/app/api/image/route";
import { GET as frame } from "@/app/api/artifact/frame/[...rest]/route";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tool-files-"));
const keys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "LLV_STATE_DIR", "LLV_EVIDENCE_ROOTS", "LLV_CODEX_HOME", "CODEX_HOME", "LLV_CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "OPENCLAW_STATE_DIR", "DELEGATUS_CODEX_HOME", "DELEGATUS_CLAUDE_HOME"] as const;
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let home: string;
let project: string;
let state: string;
let sequence = 0;

function write(file: string, bytes: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
function record(...directories: string[]) {
  write(path.join(state, "project-catalog.json"), JSON.stringify({ files: Object.fromEntries(
    directories.map((cwd, index) => [`fixture-${index}`, { cwd, projectRoot: cwd }]),
  ) }));
  resetProjectDirectoryCacheForTests();
}
function request(route: string, file: string, mode?: string) {
  const url = new URL(`http://127.0.0.1/api/${route}`);
  url.searchParams.set("path", file);
  if (mode) url.searchParams.set("mode", mode);
  return new NextRequest(url, { headers: { host: "127.0.0.1" } });
}
async function expectRefused(directory: string) {
  const field = ["access", "token"].join("_");
  const json = write(path.join(directory, "fixture.json"), JSON.stringify({ [field]: "fake fixture credential, never usable" }));
  const png = write(path.join(directory, "fixture.png"), KEEP_PNG);
  const html = write(path.join(directory, "index.html"), "<p>Private fixture settings</p>");
  for (const file of [json, png, html]) {
    const response = await artifact(request("artifact", file));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "access-denied" });
  }
  const meta = await artifact(request("artifact", html, "meta"));
  expect(meta.status).toBe(403);
  expect(await meta.json()).not.toHaveProperty("frame");
  const picture = await image(request("image", png));
  expect(picture.status).toBe(403);
  expect(await picture.json()).toEqual({ error: "path not allowed" });
  // Even a scope minted before the policy changed must not bypass admission.
  const scope = mintFrameScope(directory);
  const response = await frame(new NextRequest(`http://127.0.0.1/api/artifact/frame/${scope}/fixture.json`, { headers: { host: "127.0.0.1" } }));
  expect(response.status).toBe(403);
  await response.text();
  await keepWrittenPictures([png], { now: 1000 });
  expect(reportMediaRows()).toHaveLength(0);
}

beforeEach(() => {
  home = path.join(sandbox, `home-${sequence++}`);
  project = path.join(home, "project");
  state = path.join(home, ".config/delegatus/state");
  for (const key of keys) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_CACHE_HOME = path.join(home, ".cache");
  process.env.LLV_STATE_DIR = state;
  process.env.LLV_EVIDENCE_ROOTS = path.join(state, "evidence");
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  resetProjectDirectoryCacheForTests();
});
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

for (const name of [".codex", ".claude", ".copilot", ".openclaw", ".config/delegatus", ".config/agent-log-viewer", ".config/live-log-viewer"]) {
  test(`tool-home cwd never admits private files: ${name}`, async () => {
    const directory = path.join(home, name);
    fs.mkdirSync(directory, { recursive: true });
    record(directory, project);
    expect(lexicalAllowedRoots().projects).not.toContain(directory);
    expect((await realAllowedRoots()).projects).not.toContain(fs.realpathSync(directory));
    await expectRefused(directory);
    const file = write(path.join(project, "report.md"), "Fixture project report");
    const response = await artifact(request("artifact", file));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Fixture project report");
  });
}

for (const key of ["LLV_CODEX_HOME", "CODEX_HOME", "LLV_CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "COPILOT_HOME", "OPENCLAW_STATE_DIR", "DELEGATUS_CODEX_HOME", "DELEGATUS_CLAUDE_HOME", "LLV_STATE_DIR"]) {
  test(`parent project and nested cwd cannot admit configured private files: ${key}`, async () => {
    const directory = path.join(project, "tool-home");
    process.env[key] = directory;
    if (key === "LLV_STATE_DIR") state = directory;
    const nested = path.join(directory, "nested");
    fs.mkdirSync(nested, { recursive: true });
    record(project, directory, nested);
    expect(lexicalAllowedRoots().projects).not.toContain(directory);
    expect(lexicalAllowedRoots().projects).not.toContain(nested);
    await expectRefused(nested);
  });
}

test("managed homes beside a relocated state directory stay private", async () => {
  state = path.join(project, "config/state");
  process.env.LLV_STATE_DIR = state;
  const directories = ["codex", "claude", "copilot"].map(kind => path.join(project, "config/accounts", kind, "fixture"));
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
  record(project, ...directories);
  for (const directory of directories) await expectRefused(directory);
});

test("links to a tool home and a relocated tool-home symlink cannot bypass real admission", async () => {
  const privateDirectory = path.join(project, "private-target");
  fs.mkdirSync(privateDirectory, { recursive: true });
  const configured = path.join(home, ".codex");
  fs.symlinkSync(privateDirectory, configured, "dir");
  record(project, configured, privateDirectory);
  await expectRefused(privateDirectory);
  const alias = path.join(project, "public-alias");
  fs.symlinkSync(configured, alias, "dir");
  await expectRefused(alias);
});

test("a raw configured home resolves dot segments after following its parent link", async () => {
  const branch = path.join(project, "branch");
  const actual = path.join(branch, "private");
  fs.mkdirSync(path.join(branch, "nested"), { recursive: true });
  fs.mkdirSync(actual, { recursive: true });
  fs.symlinkSync(path.join(branch, "nested"), path.join(project, "entry"), "dir");
  const configured = `${project}/entry/../private`;
  process.env.CODEX_HOME = configured;
  const body = JSON.stringify({ fixture: "fake private credential data" });
  fs.writeFileSync(`${configured}/fixture.json`, body);
  fs.writeFileSync(path.join(actual, "fixture.png"), KEEP_PNG);
  fs.writeFileSync(path.join(actual, "index.html"), "<p>Private fixture</p>");
  expect(fs.readFileSync(path.join(actual, "fixture.json"), "utf8")).toBe(body);
  expect(fs.statSync(configured).ino).toBe(fs.statSync(actual).ino);
  record(project, actual);
  const response = await artifact(request("artifact", path.join(actual, "fixture.json")));
  const exactFixture = await response.text() === body;
  const picture = await image(request("image", path.join(actual, "fixture.png")));
  await picture.arrayBuffer();
  const meta = await artifact(request("artifact", path.join(actual, "index.html"), "meta"));
  await meta.text();
  const scope = mintFrameScope(actual);
  const framed = await frame(new NextRequest(`http://127.0.0.1/api/artifact/frame/${scope}/fixture.json`, { headers: { host: "127.0.0.1" } }));
  await framed.text();
  await keepWrittenPictures([path.join(actual, "fixture.png")], { now: 1000, projectOf: () => null });
  const statuses = { artifact: response.status, image: picture.status, metadata: meta.status, frame: framed.status, copiedRows: reportMediaRows().length };
  console.log(JSON.stringify({ case: "raw-configured-symlink-dot-segments", exactFixture, ...statuses }));
  const ordinary = write(path.join(project, "report.md"), "Fixture project report");
  const legitimate = await artifact(request("artifact", ordinary));
  expect(legitimate.status).toBe(200);
  expect(await legitimate.text()).toBe("Fixture project report");
  expect(statuses).toEqual({ artifact: 403, image: 403, metadata: 403, frame: 403, copiedRows: 0 });
});

for (const key of ["LLV_CODEX_HOME", "CODEX_HOME", "DELEGATUS_CODEX_HOME", "LLV_CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "DELEGATUS_CLAUDE_HOME", "COPILOT_HOME", "OPENCLAW_STATE_DIR", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "LLV_STATE_DIR"] as const) {
  for (const suffix of ["", " ", "\u00a0"]) {
    test(`linked parent traversal preserves raw, trimmed and lexical private roots: ${key}, ${JSON.stringify(suffix)}`, async () => {
      const branch = path.join(project, "branch");
      fs.mkdirSync(path.join(branch, "nested"), { recursive: true });
      fs.symlinkSync(path.join(branch, "nested"), path.join(project, "entry"), "dir");
      const configured = `${project}/entry/../private${suffix}`;
      const actual = path.join(branch, `private${suffix}`);
      const lexical = path.resolve(configured);
      const target = path.join(project, `lexical-target${suffix}`);
      // Consumers that normalize first can reach a second symlink target.
      for (const [written, resolved] of new Map([[lexical, target], [lexical.trim(), target.trim()]])) {
        fs.mkdirSync(resolved, { recursive: true });
        fs.symlinkSync(resolved, written, "dir");
      }
      for (const directory of new Set([actual, actual.trim()])) fs.mkdirSync(directory, { recursive: true });
      process.env[key] = configured;
      if (key === "LLV_STATE_DIR") state = lexical;
      const children = key === "HOME" || key === "USERPROFILE"
        ? [".codex", ".claude", ".copilot", ".openclaw", ".config/delegatus", ".config/agent-log-viewer", ".config/live-log-viewer"]
        : key === "XDG_CONFIG_HOME" ? ["delegatus", "agent-log-viewer", "live-log-viewer"] : [""];
      const bases = new Set([actual, lexical, target]);
      // Tool and platform homes have literal and trimming consumers.
      if (key !== "XDG_CONFIG_HOME" && key !== "LLV_STATE_DIR") {
        for (const directory of [...bases]) bases.add(directory.trim());
      }
      const directories = [...bases].flatMap(base => children.map(child => path.join(base, child)));
      if (key === "LLV_STATE_DIR") {
        for (const base of bases) for (const name of ["accounts", "shared"]) directories.push(path.join(path.dirname(base), name));
      }
      for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
      // A separate project remains readable even when HOME moves under project.
      const ordinaryProject = path.join(home, "ordinary-project");
      const ordinary = write(path.join(ordinaryProject, "report.md"), "Fixture project report");
      record(project, ...directories, ordinaryProject);
      for (const directory of directories) {
        expect(lexicalAllowedRoots().projects).not.toContain(directory);
        await expectRefused(directory);
      }
      const response = await artifact(request("artifact", ordinary));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("Fixture project report");
    });
  }
}

test("an evidence root inside a private home grants no raster exception", async () => {
  const directory = path.join(project, "tool-home");
  process.env.COPILOT_HOME = directory;
  process.env.LLV_EVIDENCE_ROOTS = directory;
  fs.mkdirSync(directory, { recursive: true });
  record(project, directory);
  await expectRefused(directory);
});

test("a visible relocated config folder stays private below a project", async () => {
  process.env.XDG_CONFIG_HOME = path.join(project, "config");
  const directory = path.join(process.env.XDG_CONFIG_HOME, "delegatus");
  fs.mkdirSync(directory, { recursive: true });
  record(project, directory);
  await expectRefused(directory);
});

for (const [key, engine] of [["LLV_CODEX_HOME", "Codex"], ["LLV_CLAUDE_HOME", "Claude"]] as const) {
  for (const suffix of [" ", "\u00a0"] as const) {
    test(`${engine} configured home ending in ${suffix === " " ? "ASCII space" : "NBSP"} stays private`, async () => {
      const directory = path.join(project, `private-home${suffix}`);
      process.env[key] = directory;
      fs.mkdirSync(directory, { recursive: true });
      record(project, directory);

      await expectRefused(directory);

      const ordinary = write(path.join(project, "ordinary-report.md"), "Fixture project report");
      const response = await artifact(request("artifact", ordinary));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("Fixture project report");
    });
  }
}

for (const suffix of [" ", "\u00a0"] as const) {
  for (const toolHome of [".codex", ".claude", ".copilot", ".config/delegatus"] as const) {
    test(`literal HOME ending in ${suffix === " " ? "ASCII space" : "NBSP"} keeps ${toolHome} private`, async () => {
      const literalHome = `${home}${suffix}`;
      process.env.HOME = literalHome;
      process.env.XDG_CONFIG_HOME = path.join(literalHome, ".config");
      const directory = path.join(literalHome, toolHome);
      if (toolHome === ".config/delegatus") {
        state = path.join(directory, "state");
        process.env.LLV_STATE_DIR = state;
      }
      fs.mkdirSync(directory, { recursive: true });
      record(directory, project);

      await expectRefused(directory);

      const ordinary = write(path.join(project, "ordinary-report.md"), "Fixture project report");
      const response = await artifact(request("artifact", ordinary));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("Fixture project report");
    });
  }
}

test("old hidden-only copy proofs cannot serve deleted aliases or direct cache paths", async () => {
  record(project);
  const alias = path.join(project, "deleted-alias.png");
  const file = `${createHash("sha256").update(KEEP_PNG).digest("hex")}.png`;
  const copy = write(path.join(reportMediaRoot(), file), KEEP_PNG);
  write(path.join(reportMediaRoot(), "index.json"), JSON.stringify([
    { path: alias, file, bytes: KEEP_PNG.length, mtimeMs: 1000, at: 1000, project: null, hiddenPathPolicy: 1 },
  ]));
  // The former writer could have copied a visible alias into a tool home.
  for (const candidate of [alias, copy]) {
    const response = await artifact(request("artifact", candidate));
    expect(response.status).toBe(403);
    await response.json();
    const picture = await image(request("image", candidate));
    expect(picture.status).toBe(403);
    await picture.json();
  }
});

test("a worktrees-shaped cwd without a linked Git checkout stays private", async () => {
  const directory = path.join(home, ".codex/worktrees/fixture/project");
  fs.mkdirSync(directory, { recursive: true });
  record(project, directory);
  expect(lexicalAllowedRoots().projects).not.toContain(directory);
  await expectRefused(directory);
});

test("a real linked checkout below a tool home cannot serve or copy its files", async () => {
  const repository = path.join(project, "repository");
  const checkout = path.join(home, ".codex/worktrees/fixture/checkout");
  fs.mkdirSync(repository, { recursive: true });
  execFileSync("git", ["init", "--quiet", repository]);
  write(path.join(repository, "README.md"), "Fixture repository");
  execFileSync("git", ["-C", repository, "add", "README.md"]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  execFileSync("git", ["-C", repository, "worktree", "add", "--quiet", "--detach", checkout]);
  record(project, repository, checkout);

  expect(lexicalAllowedRoots().projects).not.toContain(checkout);
  expect((await realAllowedRoots()).projects).not.toContain(fs.realpathSync(checkout));
  await expectRefused(checkout);

  const ordinary = write(path.join(repository, "report.md"), "Fixture project report");
  const response = await artifact(request("artifact", ordinary));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("Fixture project report");
});

test("managed scratch and evidence keep their admission while the rest of state stays private", async () => {
  const scratch = path.join(state, "scratch/llv-stage-fixture/tmp");
  const evidence = path.join(state, "evidence/fixture-lane");
  const report = write(path.join(scratch, "report.md"), "Fixture stage report");
  const shot = write(path.join(scratch, "out/frame.png"), KEEP_PNG);
  const frame = write(path.join(evidence, "frame-01.png"), KEEP_PNG);
  const notes = write(path.join(evidence, "notes.json"), "{}");
  const hidden = write(path.join(scratch, ".private/notes.md"), "Fixture hidden notes");
  record(project);

  const text = await artifact(request("artifact", report));
  expect(text.status).toBe(200);
  expect(await text.text()).toBe("Fixture stage report");
  for (const file of [shot, frame]) {
    for (const response of [await image(request("image", file)), await artifact(request("artifact", file))]) {
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(KEEP_PNG);
    }
  }
  // Evidence stays raster-only and scratch keeps the hidden-component rule.
  for (const file of [notes, hidden]) {
    const response = await artifact(request("artifact", file));
    expect(response.status).toBe(403);
    await response.json();
  }
  const roots = lexicalAllowedRoots();
  expect(admittedAs(path.join(scratch, "report.md"), roots)).toBe("project");
  expect(admittedAs(path.join(evidence, "frame-01.png"), roots)).toBe("evidence");
  // A passage spelling that climbs back out of it is judged where it lands.
  for (const output of ["scratch", "evidence"]) {
    expect(admittedAs(`${state}/${output}/../private-data/fixture.png`, roots)).toBeNull();
    expect(admittedAs(`${state}/${output}/../../accounts/fixture.png`, roots)).toBeNull();
  }

  await expectRefused(path.join(state, "private-data"));
  await expectRefused(path.join(path.dirname(state), "settings"));
  await expectRefused(path.join(path.dirname(state), "accounts"));
  // A tool home configured inside a passage stays a private area.
  const toolHome = path.join(state, "scratch/llv-stage-fixture/codex-home");
  process.env.CODEX_HOME = toolHome;
  await expectRefused(toolHome);
  // A tool home that contains the state directory grants its outputs no passage.
  process.env.LLV_CLAUDE_HOME = path.dirname(state);
  for (const file of [report, shot, frame]) {
    const response = await artifact(request("artifact", file));
    expect(response.status).toBe(403);
    await response.json();
  }
});

for (const placement of ["containing config folder", "cwd inside evidence"] as const) {
  test(`the evidence passage serves rasters only through another project root: ${placement}`, async () => {
    const lane = path.join(state, "evidence/fixture-lane");
    const verdict = write(path.join(lane, "verdict.json"), "{}");
    const log = write(path.join(lane, "hook.log"), "fixture hook log");
    const shot = write(path.join(lane, "frame-01.png"), KEEP_PNG);
    // A directory with a raster-shaped name is still no file the passage serves.
    const rasterNamed = path.join(lane, "album.png");
    const nested = write(path.join(rasterNamed, "notes.json"), "{}");
    const root = placement === "cwd inside evidence" ? lane : path.join(home, ".config");
    record(project, root, rasterNamed);

    const roots = lexicalAllowedRoots();
    for (const under of [lane, rasterNamed]) {
      expect(roots.projects).not.toContain(under);
      expect((await realAllowedRoots()).projects).not.toContain(fs.realpathSync(under));
    }
    expect(roots.projects.filter(entry => entry.startsWith(path.join(state, "evidence")))).toEqual([]);
    for (const file of [verdict, log, nested]) {
      expect(admittedAs(file, roots)).toBeNull();
      const response = await artifact(request("artifact", file));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "access-denied" });
    }
    for (const response of [await image(request("image", shot)), await artifact(request("artifact", shot))]) {
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(KEEP_PNG);
    }
  });
}

test("a symlinked state output cannot turn private state into an output passage", async () => {
  const target = path.join(project, "private-state");
  const directory = path.join(target, "private-data");
  fs.mkdirSync(directory, { recursive: true });
  state = path.join(project, "state-alias");
  process.env.LLV_STATE_DIR = state;
  fs.symlinkSync(target, state, "dir");
  fs.symlinkSync(directory, path.join(target, "scratch"), "dir");
  record(project, target, directory);
  await expectRefused(directory);
  await expectRefused(path.join(state, "scratch"));
});
