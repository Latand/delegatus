import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { admittedAs, hiddenPathAllowed, lexicalAllowedRoots, descriptorPlace, openAdmitted, openedAt, realpathAdmitted, type AllowedRoots } from "./localFile";

/* Where an open file lies, asked of the platform this run is on. Linux and
   macOS each have their own mechanism, so the same cases run on both. */

const roots: string[] = [];

test("hidden component admission covers every containing root and only directory passages", () => {
  const project = path.resolve("/fixture/.private-home/project");
  const evidence = path.resolve("/fixture/.private-state/evidence");
  const allowed: AllowedRoots = { home: path.dirname(project), projects: [project], evidence: [evidence], fenced: [] };
  for (const root of [project, evidence]) {
    for (const tail of ["shot.png", ".artifacts/cap/frame.png", ".worktrees/wt/shot.png", ".claude/worktrees/wt/shot.png", "worktrees/wt/shot.png"]) {
      const candidate = path.join(root, tail);
      expect(admittedAs(candidate, allowed)).toBe(root === project ? "project" : "evidence");
      expect(realpathAdmitted(root === project ? "project" : "evidence", candidate, allowed)).toBeTrue();
    }
    for (const tail of [".hidden.png", ".meta/shot.png", ".github/shot.png", ".claude/skills/shot.png", ".artifacts", ".worktrees", ".claude/worktrees", ".artifacts/.hidden.png", ".worktrees/wt/.cache/shot.png"]) {
      const candidate = path.join(root, tail);
      expect(admittedAs(candidate, allowed)).toBeNull();
      expect(realpathAdmitted("project", candidate, allowed)).toBeFalse();
      expect(realpathAdmitted("evidence", candidate, allowed)).toBeFalse();
    }
  }
  // A more specific root cannot override a private folder below its parent.
  allowed.projects.push(path.join(project, ".meta"));
  allowed.evidence.push(path.join(evidence, ".cache"));
  expect(admittedAs(path.join(project, ".meta/shot.png"), allowed)).toBeNull();
  expect(admittedAs(path.join(evidence, ".cache/shot.png"), allowed)).toBeNull();
  // Once the original root is gone, the kept-copy check still sees the name.
  expect(hiddenPathAllowed(path.resolve("/gone/.hidden.png"), allowed)).toBeFalse();
  expect(hiddenPathAllowed(path.resolve("/gone/shot.png"), allowed)).toBeTrue();
  const temp = path.resolve("/temp/.private-root");
  expect(hiddenPathAllowed(path.join(temp, "shot.png"), allowed, [temp])).toBeTrue();
  expect(hiddenPathAllowed(path.join(temp, ".cache/shot.png"), allowed, [temp])).toBeFalse();
  const overlapping: AllowedRoots = { ...allowed, projects: [path.join(evidence, ".cache")] };
  expect(realpathAdmitted("evidence", path.join(evidence, ".cache/shot.png"), overlapping)).toBeFalse();
});
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function layout() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llv-place-")));
  roots.push(root);
  for (const name of ["inside", "outside"]) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, "shot.png"), name);
  }
  await fs.symlink(path.join(root, "outside"), path.join(root, "link"));
  return { inside: path.join(root, "inside", "shot.png"), outside: path.join(root, "outside", "shot.png"), linked: path.join(root, "link", "shot.png") };
}

/** The kernel's names for open files are gone for as long as `run` takes. */
async function withoutDescriptorNames(run: () => Promise<void>) {
  const readlink = fs.readlink.bind(fs);
  const spy = spyOn(fs, "readlink").mockImplementation((async (file: never, ...rest: never[]) => {
    if (String(file).startsWith("/proc/self/fd/")) throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    return readlink(file, ...rest);
  }) as never);
  try { await run(); } finally { spy.mockRestore(); }
}

const named = process.platform === "linux" || process.platform === "darwin";

test.skipIf(!named)("a file opened at its own place is found there, and its bytes are read", async () => {
  const { inside } = await layout();
  const handle = await openAdmitted(inside);
  try {
    expect(await openedAt(handle, inside)).toBe(true);
    expect((await handle.readFile()).toString()).toBe("inside");
  } finally { await handle.close(); }
});

test.skipIf(!named)("a file opened through a linked directory, or lying elsewhere under the same name, is not at the expected place", async () => {
  const { inside, outside, linked } = await layout();
  const through = await fs.open(linked, "r");
  const elsewhere = await fs.open(outside, "r");
  try {
    expect(await descriptorPlace(through, linked)).toBe(false);
    expect(await openedAt(through, linked)).toBe(false);
    expect(await descriptorPlace(elsewhere, inside)).toBe(false);
  } finally { await through.close(); await elsewhere.close(); }
  await expect(openAdmitted(linked)).rejects.toMatchObject({ code: "ELOOP" });
});

test.skipIf(process.platform !== "linux")("with no name from the kernel the place is unknown, and nothing is opened or published on that ground", async () => {
  const { inside } = await layout();
  await withoutDescriptorNames(async () => {
    const handle = await fs.open(inside, "r");
    try {
      expect(await descriptorPlace(handle, inside)).toBeNull();
      expect(await openedAt(handle, inside)).toBe(false);
      /* The macOS mechanism is trusted only where an open refuses a linked
         directory; this kernel ignores the flag, so it is not used. */
      expect(await descriptorPlace(handle, inside, "darwin")).toBeNull();
    } finally { await handle.close(); }
    await expect(openAdmitted(inside)).rejects.toMatchObject({ code: "ELOOP" });
    await expect(openAdmitted(inside, "darwin")).rejects.toMatchObject({ code: "ELOOP" });
  });
});

test.skipIf(process.platform !== "linux")("Windows, which has no mechanism, keeps reading an ordinary file by its path and still refuses a linked one", async () => {
  const { inside, linked } = await layout();
  await withoutDescriptorNames(async () => {
    const handle = await openAdmitted(inside, "win32");
    try { expect((await handle.readFile()).toString()).toBe("inside"); expect(await openedAt(handle, inside)).toBe(false); } finally { await handle.close(); }
    const through = await fs.open(linked, "r");
    try { expect(await descriptorPlace(through, linked, "win32")).toBeNull(); } finally { await through.close(); }
    await expect(openAdmitted(linked, "win32")).rejects.toMatchObject({ code: "ELOOP" });
  });
});

test("a catalog entry for the home directory never reopens unrelated personal files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-file-roots-")); roots.push(root);
  const previous = { home: process.env.HOME, state: process.env.LLV_STATE_DIR };
  const home = path.join(root, "home"); const state = path.join(root, "state");
  try {
    await fs.mkdir(home); await fs.mkdir(state);
    process.env.HOME = home; process.env.LLV_STATE_DIR = state;
    await fs.writeFile(path.join(state, "project-catalog.json"), JSON.stringify({ files: { fixture: { cwd: home, projectRoot: home } } }));
    expect(admittedAs(path.join(home, "personal", "notes.json"), lexicalAllowedRoots())).toBeNull();
  } finally {
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    if (previous.state === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous.state;
  }
});
