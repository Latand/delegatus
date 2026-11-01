import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { persistProjectAliases, projectAliasResolver } from "./aliases";
import { createProjectByName, type CreateByNameOptions } from "./createByName";
import { createManualProject, projectCurationSnapshot } from "./curation";
import { directoryProjectId } from "./identity";
import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";
import { defaultProjectsParent, suggestionRoots } from "./suggestionRoots";

/* Red on main: `createProjectByName` and `defaultProjectsParent` are new, and the
   route answered INVALID_REQUEST to a request with no root. */

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "llv-create-by-name-")));
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const ORIGINAL_HOME = process.env.HOME;
let HOME = "";
let nextCase = 0;

beforeEach(() => {
  const base = path.join(SANDBOX, `case-${nextCase++}`);
  HOME = path.join(base, "home");
  fs.mkdirSync(HOME, { recursive: true });
  process.env.HOME = HOME;
  process.env.LLV_STATE_DIR = path.join(base, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR);
  resetProjectDirectoryCacheForTests();
});

afterEach(() => {
  resetProjectDirectoryCacheForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function create(name: string, overrides: Partial<CreateByNameOptions> = {}) {
  return createProjectByName(name, {
    parent: defaultProjectsParent(),
    allowedRoots: suggestionRoots(),
    existing: new Set(),
    visible: [],
    ...overrides,
  });
}

function createdRoot(result: ReturnType<typeof create>): string {
  if (!result.ok) throw new Error(`expected a project, got ${result.code}: ${result.message}`);
  return result.entry.root;
}

const projects = () => path.join(HOME, "Projects");

describe("the default parent", () => {
  test("$HOME/Projects is created on first use and the folder lands inside it", () => {
    expect(fs.existsSync(projects())).toBe(false);
    const result = create("PR GRAM");
    expect(createdRoot(result)).toBe(path.join(projects(), "pr-gram"));
    expect(fs.statSync(path.join(projects(), "pr-gram")).isDirectory()).toBe(true);
    expect(projectCurationSnapshot().manualProjects).toMatchObject([
      { displayName: "PR GRAM", root: path.join(projects(), "pr-gram") },
    ]);
  });

  test("an existing $HOME/projects is used when $HOME/Projects is absent", () => {
    fs.mkdirSync(path.join(HOME, "projects"));
    expect(defaultProjectsParent()).toBe(path.join(HOME, "projects"));
    expect(createdRoot(create("Notes"))).toBe(path.join(HOME, "projects", "notes"));
    expect(fs.existsSync(projects())).toBe(false);
  });

  test("$HOME/Projects wins when both exist", () => {
    fs.mkdirSync(projects());
    fs.mkdirSync(path.join(HOME, "projects"));
    expect(defaultProjectsParent()).toBe(projects());
  });

  test("a plain file at $HOME/projects is no parent", () => {
    fs.writeFileSync(path.join(HOME, "projects"), "");
    expect(defaultProjectsParent()).toBe(projects());
  });

  test("a parent that symlinks outside $HOME passes the bound and the folder lands at the link's target", () => {
    const target = path.join(path.dirname(HOME), "elsewhere");
    fs.mkdirSync(target);
    fs.symlinkSync(target, projects());
    expect(createdRoot(create("Linked"))).toBe(path.join(target, "linked"));
    expect(fs.statSync(path.join(target, "linked")).isDirectory()).toBe(true);
  });

  test("a parent outside the given roots is refused and nothing is created", () => {
    const beyond = path.join(path.dirname(HOME), "beyond");
    const result = create("Escape", { parent: path.join(beyond, "Projects"), allowedRoots: [HOME] });
    expect(result).toMatchObject({ ok: false, code: "OUTSIDE_ROOTS" });
    expect(fs.existsSync(beyond)).toBe(false);
  });

  test("a parent that cannot be made answers MKDIR_FAILED", () => {
    fs.writeFileSync(projects(), "");
    expect(create("Blocked")).toMatchObject({ ok: false, code: "MKDIR_FAILED" });
    expect(fs.readFileSync(projects(), "utf8")).toBe("");
    fs.rmSync(projects());
    fs.symlinkSync(path.join(HOME, "gone"), projects());
    expect(create("Dangling")).toMatchObject({ ok: false, code: "MKDIR_FAILED" });
    expect(projectCurationSnapshot().manualProjects).toEqual([]);
  });

  test("a parent inside a Git checkout is refused and nothing is created", () => {
    fs.mkdirSync(path.join(HOME, ".git"));
    fs.writeFileSync(path.join(HOME, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect(create("Inside")).toMatchObject({ ok: false, code: "PARENT_IN_REPOSITORY", parent: projects() });
    expect(fs.existsSync(projects())).toBe(false);
    expect(projectCurationSnapshot().manualProjects).toEqual([]);
  });

  test("hostile names stay one segment below the parent", () => {
    for (const name of ["../../etc", "..", "/absolute/path", "a/../../b", "~/.ssh"]) {
      const root = createdRoot(create(name));
      expect(path.dirname(root)).toBe(projects());
    }
    expect(fs.readdirSync(path.dirname(HOME)).sort()).toEqual(["home", "state"]);
  });
});

describe("collisions", () => {
  test("an existing directory, file or symlink with the slug gives -2, and the symlink is not followed", () => {
    fs.mkdirSync(projects());
    const outside = path.join(path.dirname(HOME), "link-target");
    fs.mkdirSync(outside);
    const taken: Array<[string, () => void]> = [
      ["dir-taken", () => fs.mkdirSync(path.join(projects(), "dir-taken"))],
      ["file-taken", () => fs.writeFileSync(path.join(projects(), "file-taken"), "kept")],
      ["link-taken", () => fs.symlinkSync(outside, path.join(projects(), "link-taken"))],
      ["dangling-taken", () => fs.symlinkSync(path.join(HOME, "nothing"), path.join(projects(), "dangling-taken"))],
    ];
    for (const [slug, occupy] of taken) {
      occupy();
      expect(createdRoot(create(slug))).toBe(path.join(projects(), `${slug}-2`));
    }
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readFileSync(path.join(projects(), "file-taken"), "utf8")).toBe("kept");
    expect(fs.readlinkSync(path.join(projects(), "dangling-taken"))).toBe(path.join(HOME, "nothing"));
    expect(fs.existsSync(path.join(HOME, "nothing"))).toBe(false);
  });

  test("an empty existing folder is never reused", () => {
    fs.mkdirSync(path.join(projects(), "pr-gram"), { recursive: true });
    expect(createdRoot(create("PR GRAM"))).toBe(path.join(projects(), "pr-gram-2"));
  });

  test("-2 through -99 all taken answers NO_FREE_FOLDER and makes no new folder", () => {
    fs.mkdirSync(path.join(projects(), "full"), { recursive: true });
    for (let suffix = 2; suffix <= 99; suffix += 1) fs.mkdirSync(path.join(projects(), `full-${suffix}`));
    const before = fs.readdirSync(projects()).sort();
    expect(create("Full")).toMatchObject({ ok: false, code: "NO_FREE_FOLDER" });
    expect(fs.readdirSync(projects()).sort()).toEqual(before);
  });

  test("the last free suffix is used", () => {
    fs.mkdirSync(path.join(projects(), "edge"), { recursive: true });
    for (let suffix = 2; suffix <= 98; suffix += 1) fs.mkdirSync(path.join(projects(), `edge-${suffix}`));
    expect(createdRoot(create("Edge"))).toBe(path.join(projects(), "edge-99"));
  });

  test.each([
    ["case", "pr gram"],
    ["NFKC form", "ＰＲ ＧＲＡＭ"],
    ["spacing", "  PR   GRAM  "],
    ["invisible characters", "PR\u200b GRAM"],
  ])("the same name in another %s answers DUPLICATE_NAME and makes no folder", (_label, name) => {
    const twin = { project: "repo-twin", displayName: "PR GRAM", root: "/fixture/twin" };
    expect(create(name, { visible: [twin] })).toEqual({
      ok: false,
      code: "DUPLICATE_NAME",
      message: expect.any(String),
      project: "repo-twin",
      displayName: "PR GRAM",
      root: "/fixture/twin",
    });
    expect(fs.existsSync(projects())).toBe(false);
  });

  test("a name only outside the caller's visible list creates a new project", () => {
    fs.mkdirSync(path.join(projects(), "secret"), { recursive: true });
    const result = create("Secret", { visible: [{ project: "repo-other", displayName: "Another", root: null }] });
    expect(createdRoot(result)).toBe(path.join(projects(), "secret-2"));
  });

  test("a key the catalog still holds for a deleted folder costs a suffix", () => {
    const existing = new Set([directoryProjectId(path.join(projects(), "old"))]);
    const result = create("Old", { existing });
    expect(createdRoot(result)).toBe(path.join(projects(), "old-2"));
    expect(fs.existsSync(path.join(projects(), "old"))).toBe(false);
  });

  test("a key an alias already joins to another project costs a suffix", () => {
    const stale = directoryProjectId(path.join(projects(), "moved"));
    expect(persistProjectAliases([{ source: stale, target: "repo-joined", displayName: "Joined" }])).toBe(true);
    expect(createdRoot(create("Moved", { resolve: projectAliasResolver() }))).toBe(path.join(projects(), "moved-2"));
    expect(fs.existsSync(path.join(projects(), "moved"))).toBe(false);
  });

  test("a manual row left by a deleted folder costs a suffix and leaves no empty folder", () => {
    const gone = path.join(projects(), "gone");
    fs.mkdirSync(gone, { recursive: true });
    expect(createManualProject("Gone before", gone).ok).toBe(true);
    fs.rmdirSync(gone);
    expect(createdRoot(create("Gone"))).toBe(path.join(projects(), "gone-2"));
    expect(fs.existsSync(gone)).toBe(false);
  });
});

describe("failure leaves nothing behind", () => {
  /* The store's writes do not wait on a lock, so a peer holding SQLite's write
     lock is a real store failure. */
  function whileStoreIsLocked<T>(run: () => T): T {
    expect(createdRoot(create("Seed"))).toBe(path.join(projects(), "seed"));
    const database = new Database(path.join(process.env.LLV_STATE_DIR!, "state.sqlite"));
    try {
      database.exec("BEGIN IMMEDIATE");
      return run();
    } finally {
      database.exec("ROLLBACK");
      database.close();
    }
  }

  test("a store failure removes only the folder this request made", () => {
    fs.mkdirSync(path.join(projects(), "store-fail"), { recursive: true });
    fs.writeFileSync(path.join(projects(), "store-fail", "kept"), "kept");
    fs.mkdirSync(path.join(projects(), "sibling"));
    expect(whileStoreIsLocked(() => create("Store Fail"))).toMatchObject({ ok: false, code: "STORE_ERROR" });
    expect(fs.readdirSync(projects()).sort()).toEqual(["seed", "sibling", "store-fail"]);
    expect(fs.readFileSync(path.join(projects(), "store-fail", "kept"), "utf8")).toBe("kept");
    expect(projectCurationSnapshot().manualProjects.map((entry) => entry.displayName)).toEqual(["Seed"]);
  });

  test("a folder a peer wrote into during the failed bind is left in place", () => {
    const peer = path.join(projects(), "peer");
    const original = fs.mkdirSync.bind(fs);
    const writing = spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      const made = original(target, options);
      if (String(target) === peer) fs.writeFileSync(path.join(peer, "written"), "peer");
      return made;
    }) as typeof fs.mkdirSync);
    try {
      expect(whileStoreIsLocked(() => create("Peer"))).toMatchObject({ ok: false, code: "STORE_ERROR" });
    } finally {
      writing.mockRestore();
    }
    expect(fs.readFileSync(path.join(peer, "written"), "utf8")).toBe("peer");
  });

  test("a mkdir failure other than a lost claim answers MKDIR_FAILED", () => {
    fs.mkdirSync(projects());
    const original = fs.mkdirSync.bind(fs);
    const refused = spyOn(fs, "mkdirSync").mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(target).endsWith("denied")) throw Object.assign(new Error("denied fixture"), { code: "EACCES" });
      return original(target, options);
    }) as typeof fs.mkdirSync);
    try {
      expect(create("Denied")).toMatchObject({ ok: false, code: "MKDIR_FAILED", message: "denied fixture" });
    } finally {
      refused.mockRestore();
    }
  });

  test.each([
    ["empty", "   "],
    ["over 80 characters", "n".repeat(81)],
    ["only invisible characters", "\u200b\u2060"],
  ])("a name that is %s answers INVALID_NAME and creates nothing", (_label, name) => {
    expect(create(name)).toMatchObject({ ok: false, code: "INVALID_NAME" });
    expect(fs.existsSync(projects())).toBe(false);
  });
});

describe("concurrent creates", () => {
  test("two processes creating one name never share a folder", async () => {
    fs.mkdirSync(projects());
    /* Opens the store here first: the first-boot import is not what this races. */
    expect(createdRoot(create("Seed"))).toBe(path.join(projects(), "seed"));
    const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "createByName.ts");
    const script = path.join(path.dirname(HOME), "create-child.ts");
    fs.writeFileSync(script, [
      `import { createProjectByName } from ${JSON.stringify(source)};`,
      `process.stdout.write("ready\\n");`,
      `await Bun.stdin.text();`,
      `const result = createProjectByName("PR GRAM", { parent: ${JSON.stringify(projects())}, allowedRoots: [${JSON.stringify(HOME)}], existing: new Set(), visible: [] });`,
      `process.stdout.write(JSON.stringify(result) + "\\n");`,
    ].join("\n"));
    const children = [0, 1].map(() => Bun.spawn([process.execPath, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME, LLV_STATE_DIR: process.env.LLV_STATE_DIR! },
    }));
    const readers = children.map((child) => child.stdout.getReader());
    const decoder = new TextDecoder();
    /* Both have finished importing before either may start. */
    await Promise.all(readers.map(async (reader) => expect(decoder.decode((await reader.read()).value)).toBe("ready\n")));
    for (const child of children) child.stdin.end();
    const answers = await Promise.all(readers.map(async (reader) => {
      let text = "";
      for (let part = await reader.read(); !part.done; part = await reader.read()) text += decoder.decode(part.value);
      return JSON.parse(text) as { ok: boolean; code?: string; entry?: { root: string } };
    }));
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([0, 0]);
    /* The store's writes do not wait, so a process that meets the other's write
       lock answers STORE_ERROR and takes its own folder away again. */
    const roots = answers.flatMap((answer) => answer.entry ? [answer.entry.root] : []).sort();
    expect(roots.length).toBeGreaterThan(0);
    expect(new Set(roots).size).toBe(roots.length);
    for (const answer of answers) if (!answer.ok) expect(answer.code).toBe("STORE_ERROR");
    expect(fs.readdirSync(projects()).sort()).toEqual([...roots.map((root) => path.basename(root)), "seed"].sort());
    expect(projectCurationSnapshot().manualProjects.map((entry) => entry.root).sort()).toEqual([...roots, path.join(projects(), "seed")].sort());
  }, 60_000);
});
