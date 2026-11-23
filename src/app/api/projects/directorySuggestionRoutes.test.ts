import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { resetProjectCurationForTests } from "@/lib/projects/curation";
import type { ConversationCatalogEntry } from "@/lib/scanner/conversationCatalog";
import { resetProjectDirectoryCacheForTests } from "@/lib/scanner/projectDirectories";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-projects-routes-"));
let STATE = path.join(SANDBOX, "state");
let nextCase = 0;
const ANCHOR = path.join(SANDBOX, "anchor");
const CHECKOUT = path.join(ANCHOR, "checkout");
const SIBLING = path.join(ANCHOR, "sibling-idea");
const BEYOND = path.join(SANDBOX, "beyond", "unknown-area");
/* A link that is spelled inside the anchor and lands outside it — the one
   shape where suggestion and creation could disagree (issue #1223). */
const LINK = path.join(ANCHOR, "linked-projects");
/* $HOME is one of the roots this route suggests from, so it is pointed at the
   sandbox: left ambient, a bare-word query would read the operator's real home
   and let its contents decide these assertions. */
const HOME = path.join(SANDBOX, "home");
const HOME_IDEA = path.join(HOME, "home-side-idea");
const ORIGINAL_STATE = process.env.LLV_STATE_DIR;
const ORIGINAL_HOME = process.env.HOME;

fs.mkdirSync(HOME_IDEA, { recursive: true });
fs.mkdirSync(path.join(CHECKOUT, ".git"), { recursive: true });
fs.writeFileSync(path.join(CHECKOUT, ".git", "HEAD"), "ref: refs/heads/main\n");
fs.writeFileSync(path.join(CHECKOUT, ".git", "config"), [
  '[remote "origin"]',
  "\turl = ssh://git@example.invalid/team/repository.git",
  "",
].join("\n"));
fs.mkdirSync(SIBLING, { recursive: true });
fs.mkdirSync(BEYOND, { recursive: true });
fs.symlinkSync(path.join(SANDBOX, "beyond"), LINK);
fs.mkdirSync(STATE, { recursive: true });
fs.writeFileSync(path.join(STATE, "project-catalog.json"), JSON.stringify({
  version: 2,
  resolutionVersion: 4,
  files: { fixture: { cwd: CHECKOUT, projectRoot: CHECKOUT } },
}));

process.env.LLV_STATE_DIR = STATE;
process.env.HOME = HOME;
const { GET } = await import("./directories/route");
const { POST } = await import("./create/route");

beforeEach(() => {
  STATE = path.join(SANDBOX, `state-${nextCase++}`);
  fs.mkdirSync(STATE);
  fs.writeFileSync(path.join(STATE, "project-catalog.json"), JSON.stringify({ files: { fixture: { cwd: CHECKOUT, projectRoot: CHECKOUT } } }));
  process.env.LLV_STATE_DIR = STATE;
  process.env.HOME = HOME;
  resetProjectCurationForTests();
  resetProjectDirectoryCacheForTests();
});

afterAll(() => {
  if (ORIGINAL_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = ORIGINAL_STATE;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  resetProjectCurationForTests();
  resetProjectDirectoryCacheForTests();
});

async function suggest(query: string): Promise<string[]> {
  const response = await GET(new NextRequest("http://127.0.0.1/api/projects/directories?q=" + encodeURIComponent(query)));
  const payload = await response.json() as { dirs: string[] };
  return payload.dirs;
}

async function create(body: unknown): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await POST(new NextRequest("http://127.0.0.1/api/projects/create", {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1:8898", cookie: `llv_operator=${soloBrowserSession()}` },
    body: JSON.stringify(body),
  }));
  return { status: response.status, payload: await response.json() as Record<string, unknown> };
}

test("/api/projects/directories completes inside the area a known project lives in", async () => {
  /* The anchor is the parent of the known checkout, so the directory beside it
     is a suggestion for a project that does not exist yet. The link that leads
     out of the anchor is not one: it is spelled inside the bound and lands
     outside it, which is precisely what create refuses. */
  expect(await suggest(ANCHOR + "/")).toEqual([CHECKOUT, SIBLING]);
  expect(await suggest(path.join(ANCHOR, "sib"))).toEqual([SIBLING]);
});

test("/api/projects/create accepts every directory /api/projects/directories offers", async () => {
  /* The refusal the operator cannot act on: a row picked out of the list, then
     rejected as outside the list's own roots (issue #1223). The two routes read
     one bound, so the answer to "choose one from the list" is always a path
     create takes. */
  expect(await suggest(LINK + "/")).toEqual([]);
  const suggestions = [...await suggest(""), ...await suggest(ANCHOR + "/")];
  expect(suggestions).not.toContain(LINK);
  expect(suggestions.length).toBeGreaterThan(0);
  for (const dir of suggestions) {
    const outcome = await create({ name: path.basename(dir), root: dir });
    expect(outcome.payload.error).not.toBe("OUTSIDE_ROOTS");
  }
});

test("/api/projects/directories never answers with a path outside the known roots", async () => {
  expect(await suggest(path.join(SANDBOX, "beyond") + "/")).toEqual([]);
  /* A bare word is a filter over what the roots hold, so a directory of that
     name outside them is not found — and no query reaches out of the sandbox
     at all, $HOME being a root of this route and pointed inside it. */
  expect(await suggest("unknown-area")).toEqual([]);
  for (const query of ["", ANCHOR + "/", "idea", "unknown-area"]) {
    for (const dir of await suggest(query)) expect(dir.startsWith(SANDBOX + path.sep)).toBe(true);
  }
});

test("/api/projects/directories falls back to the home directory the viewer is running under", async () => {
  /* The machine with no projects yet still gets a list, and it comes from the
     running viewer's $HOME rather than from whatever home the process was
     started in — which is what keeps an isolated runtime isolated. */
  expect(await suggest("home-side")).toEqual([HOME_IDEA]);
  expect(await suggest("")).toContain(HOME_IDEA);
});

test("/api/projects/create refuses a root outside the suggested roots and creates one inside them", async () => {
  const refused = await create({ name: "Beyond", root: BEYOND });
  expect(refused.status).toBe(400);
  expect(refused.payload.error).toBe("OUTSIDE_ROOTS");

  const relative = await create({ name: "Bare", root: "sibling-idea" });
  expect(relative.status).toBe(400);
  expect(relative.payload.error).toBe("RELATIVE_ROOT");

  /* Through the link the browse already refuses, with a `..` behind it so the
     spelling reads as `<ANCHOR>/…` while the kernel lands outside (issue
     #1223). The bound is measured on where mkdir would actually land. */
  const behindTheLink = LINK + "/../slipped-past";
  const slipped = await create({ name: "Slipped", root: behindTheLink, createRoot: true });
  expect(slipped.status).toBe(400);
  expect(slipped.payload.error).toBe("OUTSIDE_ROOTS");
  expect(fs.existsSync(path.join(SANDBOX, "slipped-past"))).toBe(false);
  expect(fs.existsSync(path.join(ANCHOR, "slipped-past"))).toBe(false);

  const accepted = await create({ name: "Sibling Idea", root: SIBLING });
  expect(accepted.status).toBe(200);
  expect(accepted.payload.root).toBe(SIBLING);
});


test("a cookie-free create cannot widen artifact roots to private home folders", async () => {
  const { GET: artifact } = await import("../artifact/route");
  const privateRoot = path.join(HOME, ".config");
  const privateFile = path.join(privateRoot, "gh", "hosts.yml");
  fs.mkdirSync(path.dirname(privateFile), { recursive: true });
  fs.writeFileSync(privateFile, "private fixture content");
  const read = () => artifact(new NextRequest(`http://127.0.0.1/api/artifact?path=${encodeURIComponent(privateFile)}`, { headers: { host: "127.0.0.1" } }));
  expect((await read()).status).toBe(403);
  const untrustedHeaders: Record<string, string>[] = [{}, { "sec-fetch-site": "same-origin" }, { "x-llv-internal-service": "mcp.invalid" }];
  for (const extra of untrustedHeaders) {
    const response = await POST(new NextRequest("http://127.0.0.1/api/projects/create", {
      method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", ...extra },
      body: JSON.stringify({ name: "Private directory", root: privateRoot }),
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("verified session") });
    expect((await read()).status).toBe(403);
  }
  const accepted = await create({ name: "Browser project", root: HOME_IDEA });
  expect(accepted.status).toBe(200);
});


test("verified MCP dispatch retains project creation authority", async () => {
  const response = await POST(new NextRequest("http://127.0.0.1/api/projects/create", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", ...internalServiceHeaders("mcp") },
    body: JSON.stringify({ name: "MCP project", root: HOME_IDEA }),
  }));
  expect(response.status).toBe(200);
});


test("project creation rechecks a session after reading the body", async () => {
  const previous = process.env.LLV_TOKEN;
  const request = new NextRequest("http://127.0.0.1/api/projects/create", {
    method: "POST", headers: { host: "127.0.0.1", "content-type": "application/json", cookie: `llv_operator=${soloBrowserSession()}` },
    body: JSON.stringify({ name: "Rotated session", root: HOME_IDEA }),
  });
  const readBody = request.json.bind(request);
  request.json = async () => {
    const body = await readBody();
    process.env.LLV_TOKEN = "rotated-fixture-generation";
    return body;
  };
  try {
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("verified session") });
    const { projectCurationSnapshot } = await import("@/lib/projects/curation");
    expect(projectCurationSnapshot().manualProjects).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LLV_TOKEN; else process.env.LLV_TOKEN = previous;
  }
});


/* Red on main: a request with no root answered 400 INVALID_REQUEST. */
describe("a project made from a name alone", () => {
  const PARENT = path.join(HOME, "Projects");
  beforeEach(() => fs.rmSync(PARENT, { recursive: true, force: true }));
  afterAll(() => fs.rmSync(PARENT, { recursive: true, force: true }));
  const manual = async () => (await import("@/lib/projects/curation")).projectCurationSnapshot().manualProjects;

  test("POST with only a name creates the folder under $HOME/Projects and binds it", async () => {
    const answer = await create({ name: "PR GRAM" });
    expect(answer.status).toBe(200);
    expect(answer.payload).toMatchObject({ ok: true, displayName: "PR GRAM", root: path.join(PARENT, "pr-gram"), workspaceId: null });
    expect(fs.statSync(path.join(PARENT, "pr-gram")).isDirectory()).toBe(true);
    expect(await manual()).toMatchObject([{ project: answer.payload.project, displayName: "PR GRAM" }]);
  });

  test("createRoot means nothing without a root, and a blank root is no root", async () => {
    expect((await create({ name: "Blank", root: "   ", createRoot: true })).payload.root).toBe(path.join(PARENT, "blank"));
    expect((await create({ name: "Null", root: null })).payload.root).toBe(path.join(PARENT, "null"));
  });

  test("the same visible name answers 409 with the existing project and makes no folder", async () => {
    const first = await create({ name: "PR GRAM" });
    const second = await create({ name: "pr  gram" });
    expect(second.status).toBe(409);
    expect(second.payload).toEqual({
      error: "DUPLICATE_NAME",
      message: expect.any(String),
      project: first.payload.project,
      displayName: "PR GRAM",
      root: path.join(PARENT, "pr-gram"),
    });
    expect(fs.readdirSync(PARENT)).toEqual(["pr-gram"]);
  });

  test("a scanned project's name collides too, with its known folder", async () => {
    const { replaceConversationCatalog } = await import("@/lib/scanner/conversationCatalog");
    const { projectForCwd } = await import("@/lib/scanner/describe");
    const project = projectForCwd(CHECKOUT)!;
    const scanned: ConversationCatalogEntry = {
      path: "/transcripts/scanned.jsonl", root: "claude-projects", name: "scanned", project, projectName: "Scanned Board",
      title: "t", firstPrompt: "p", engine: "claude", kind: "session", fmt: "claude", mtime: 100, size: 1,
    };
    replaceConversationCatalog([scanned]);
    try {
      const answer = await create({ name: "scanned board" });
      expect(answer.status).toBe(409);
      expect(answer.payload).toMatchObject({ error: "DUPLICATE_NAME", project, root: CHECKOUT });
      expect(fs.existsSync(PARENT)).toBe(false);
    } finally {
      replaceConversationCatalog([]);
    }
  });

  test("a folder that already exists answers with the suffixed root", async () => {
    fs.mkdirSync(path.join(PARENT, "taken"), { recursive: true });
    expect((await create({ name: "Taken" })).payload.root).toBe(path.join(PARENT, "taken-2"));
  });

  test.each([
    ["no name", { root: HOME_IDEA }],
    ["a blank name", { name: "   " }],
    ["an oversized name", { name: "n".repeat(257) }],
    ["an oversized root", { name: "Long", root: `/${"r".repeat(4096)}` }],
    ["a root that is not a string", { name: "Number", root: 5 }],
    ["a body that is not an object", ["PR GRAM"]],
  ])("%s answers INVALID_REQUEST and creates nothing", async (_label, body) => {
    const answer = await create(body);
    expect(answer.status).toBe(400);
    expect(answer.payload.error).toBe("INVALID_REQUEST");
    expect(fs.existsSync(PARENT)).toBe(false);
    expect(await manual()).toEqual([]);
  });

  test("a name too long for the rail answers INVALID_NAME before any folder exists", async () => {
    const answer = await create({ name: "n".repeat(81) });
    expect(answer.status).toBe(400);
    expect(answer.payload.error).toBe("INVALID_NAME");
    expect(fs.existsSync(PARENT)).toBe(false);
  });

  test("the rest of the refusals keep their status", async () => {
    fs.writeFileSync(PARENT, "");
    const blocked = await create({ name: "Blocked" });
    expect(blocked.status).toBe(500);
    expect(blocked.payload.error).toBe("MKDIR_FAILED");
    fs.rmSync(PARENT);
    fs.mkdirSync(path.join(PARENT, "full"), { recursive: true });
    for (let suffix = 2; suffix <= 99; suffix += 1) fs.mkdirSync(path.join(PARENT, `full-${suffix}`));
    const full = await create({ name: "Full" });
    expect(full.status).toBe(409);
    expect(full.payload.error).toBe("NO_FREE_FOLDER");
  });

  test("a parent inside a Git checkout answers 409 naming it and creates nothing", async () => {
    const previous = process.env.HOME;
    const nested = path.join(CHECKOUT, "nested-home");
    fs.mkdirSync(nested);
    process.env.HOME = nested;
    try {
      const answer = await create({ name: "Inside" });
      expect(answer.status).toBe(409);
      expect(answer.payload).toMatchObject({ error: "PARENT_IN_REPOSITORY", parent: path.join(nested, "Projects") });
      expect(fs.readdirSync(nested)).toEqual([]);
    } finally {
      process.env.HOME = previous;
      fs.rmdirSync(nested);
    }
  });

  test("a solo install has no workspace to name, so naming one creates nothing", async () => {
    const answer = await create({ name: "Solo", workspaceId: `w_${"a".repeat(32)}` });
    expect(answer.status).toBe(403);
    expect(answer.payload.code).toBe("workspace_forbidden");
    expect(fs.existsSync(PARENT)).toBe(false);
  });

  test("an agent stays refused on the default flow", async () => {
    const { setCallerConversationResolverForTests } = await import("@/lib/agent/operatorAuthority");
    setCallerConversationResolverForTests(() => "conversation_agent");
    try {
      const response = await POST(new NextRequest("http://127.0.0.1/api/projects/create", {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json", [VIEWER_SPAWN_CAPABILITY_HEADER]: "R".repeat(43), cookie: `llv_operator=${soloBrowserSession()}` },
        body: JSON.stringify({ name: "Agent project" }),
      }));
      expect(response.status).toBe(403);
      expect(fs.existsSync(PARENT)).toBe(false);
    } finally {
      setCallerConversationResolverForTests(null);
    }
  });

  test("a cookie-free request stays refused on the default flow", async () => {
    const response = await POST(new NextRequest("http://127.0.0.1/api/projects/create", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ name: "Nobody" }),
    }));
    expect(response.status).toBe(403);
    expect(fs.existsSync(PARENT)).toBe(false);
  });
});
