import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { KEEP_PNG, legacyReportPictureFixture, localFileKeepFixture } from "@/lib/artifact/localFile.fixture";

import { FRAME_SCOPE_TTL_MS, mintFrameScope } from "@/lib/artifact/frameScope";
import { EVIDENCE_FRAME_SANDBOX, FRAME_SANDBOX } from "@/components/preview/DocumentPanes";
import { resolveLink } from "@/lib/artifact/linkTarget";
import { claimInstall, signOutSession } from "@/lib/team/members";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { createWorkspace } from "@/lib/team/workspaces";
import { conversationCatalogSnapshot, replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { resetProjectCatalogStoreForTests } from "@/lib/scanner/projectCatalogStore";
import { resetStateReadonlyReaderForTests } from "@/lib/state/sqliteStateStore";

import { readEvidenceHtml } from "./readEvidenceHtml";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-artifact-frame-"));
const { GET: serve } = await import("./route");
const responses: Response[] = [];
async function GET(...args: Parameters<typeof serve>) {
  const response = await serve(...args); responses.push(response); return response;
}
const { GET: GET_ARTIFACT } = await import("../../route");

const savedHome = process.env.HOME;
const savedState = process.env.LLV_STATE_DIR;
const savedCache = process.env.XDG_CACHE_HOME;
let home = "";

beforeEach(() => {
  resetTeamStoreForTests();
  home = fs.realpathSync(fs.mkdtempSync(path.join(sandbox, "home-")));
  process.env.HOME = path.dirname(home);
  process.env.XDG_CACHE_HOME = path.join(home, "cache");
  process.env.LLV_STATE_DIR = path.join(home, "state");
  fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR, "project-catalog.json"), JSON.stringify({ files: { fixture: { cwd: home, projectRoot: home } } }));
});
afterEach(async () => {
  resetTeamStoreForTests();
  for (const response of responses.splice(0)) if (response.body && !response.body.locked) await response.body.cancel();
  resetProjectCatalogStoreForTests();
  resetStateReadonlyReaderForTests();
  if (savedState === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = savedState;
  process.env.HOME = savedHome;
  if (savedCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = savedCache;
});
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/* What the report frame's own requests look like: an opaque origin, so the
   browser marks them cross-site and sends `Origin: null` on CORS requests. */
const FRAME_REQUEST_HEADERS = { host: "127.0.0.1:8898", "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" };

function frameRequest(urlPath: string, headers: Record<string, string> = FRAME_REQUEST_HEADERS): NextRequest {
  return new NextRequest(new URL(urlPath, "http://127.0.0.1:8898"), { headers });
}

function reportDir(): string {
  const dir = path.join(home, "checkout/reports/round-2");
  write("checkout/reports/round-2/index.html", '<link rel="stylesheet" href="style.css"><h2 id="decision-graph">Graph</h2><img src="assets/g.png"><form action="/save"><button>Save</button></form><dialog open>Modal</dialog><a href="https://outside.invalid" target="_blank">open</a>');
  write("checkout/reports/round-2/style.css", "h2 { color: teal }");
  write("checkout/reports/round-2/assets/app.js", "document.title = 'ok';");
  write("checkout/secrets.md", "outside the report");
  return dir;
}

test("the meta read of an HTML report mints a frame URL scoped to its directory", async () => {
  const dir = reportDir();
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", path.join(dir, "index.html"));
  url.searchParams.set("mode", "meta");
  const res = await GET_ARTIFACT(new NextRequest(url, { headers: { host: "127.0.0.1:8898" } }));
  expect(res.status).toBe(200);
  const meta = (await res.json()) as { frame?: string };
  expect(meta.frame).toMatch(/^\/api\/artifact\/frame\/[^/]+\/index\.html$/);

  const page = await GET(frameRequest(meta.frame!));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const document = await page.text();
  expect(document).toContain('id="decision-graph"');
  expect(document).toContain("<form action=\"/save\">");
  expect(document).toContain("<dialog open>Modal</dialog>");
  expect(document).toContain("target=\"_blank\"");
  expect(document).toContain("https://outside.invalid");
  expect(page.headers.get("content-security-policy")).toBe(`sandbox ${FRAME_SANDBOX}`);
});

test("evidence frame serves HTML and local rasters with the report sandbox", async () => {
  const folder = "state/evidence/agents/fixture";
  const html = '<h1>Fixture disk report</h1><img src="chart.png">';
  const report = write(`${folder}/index.html`, html);
  write(`${folder}/script-only.html`, '<script>location.href="https://outside.invalid"</script>');
  const directory = path.dirname(report);
  fs.writeFileSync(path.join(directory, "chart.png"), KEEP_PNG);
  write(`${folder}/style.css`, "h1 { color: teal }");
  write(`${folder}/data.json`, '{"fixture":true}');
  write(`${folder}/drawing.svg`, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", report);
  url.searchParams.set("mode", "meta");
  const meta = await GET_ARTIFACT(new NextRequest(url, { headers: { host: "127.0.0.1:8898" } }));
  expect(meta.status).toBe(200);
  const { frame } = await meta.json() as { frame: string };
  expect((await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(directory)}/index.html`))).status).toBe(403);
  const asset = (name: string) => GET(frameRequest(frame.replace(/index\.html$/, name)));
  const page = await asset("index.html");
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const csp = page.headers.get("content-security-policy")!;
  expect(csp).toContain(`sandbox ${EVIDENCE_FRAME_SANDBOX}`);
  expect(csp).toContain(`/api/artifact/frame/${new URL(frame, "http://127.0.0.1").pathname.split("/")[4]}/`);
  expect(csp).toContain("base-uri http://127.0.0.1:8898/api/artifact/frame/");
  expect(csp).toContain("form-action 'none'");
  expect(csp).toContain("script-src 'none'");
  expect(csp).toContain("frame-src 'none'");
  expect(csp).not.toContain("allow-popups");
  expect(csp).not.toContain("allow-forms");
  const deliveredHtml = await page.text();
  expect(deliveredHtml).toContain(html.slice(0, 32));
  expect(deliveredHtml).not.toContain("https://outside.invalid");
  expect(deliveredHtml).not.toContain("location.href");
  const scriptOnly = await asset("script-only.html");
  expect(scriptOnly.status).toBe(200);
  expect(await scriptOnly.text()).not.toContain("location.href");
  const chart = await asset("chart.png");
  expect(chart.status).toBe(200);
  expect(Buffer.from(await chart.arrayBuffer())).toEqual(KEEP_PNG);
  for (const name of ["style.css", "data.json", "drawing.svg"]) {
    expect((await asset(name)).status).toBe(403);
  }

  const sibling = write("state/evidence/agents/sibling/index.html", "<p>Other report</p>");
  fs.writeFileSync(path.join(path.dirname(sibling), "chart.png"), KEEP_PNG);
  fs.symlinkSync(sibling, path.join(directory, "linked.html"));
  fs.symlinkSync(path.join(path.dirname(sibling), "chart.png"), path.join(directory, "linked.png"));
  for (const name of ["../sibling/index.html", "..%2Fsibling%2Findex.html", "linked.html", "linked.png"]) {
    const response = await asset(name);
    expect([403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain("Other report");
  }

  fs.renameSync(directory, `${directory}-retained`);
  fs.symlinkSync(path.dirname(sibling), directory, "dir");
  expect((await asset("index.html")).status).toBe(403);
  expect((await asset("chart.png")).status).toBe(403);
});

test("IPv6 evidence frames keep scoped assets on the verified serving authority", async () => {
  const report = write("state/evidence/agents/ipv6/index.html", '<!doctype html><img src="chart.png"><h1>IPv6 report</h1>');
  fs.writeFileSync(path.join(path.dirname(report), "chart.png"), KEEP_PNG);
  const metaUrl = new URL("http://[::1]:8898/api/artifact");
  metaUrl.searchParams.set("path", report);
  metaUrl.searchParams.set("mode", "meta");
  const meta = await GET_ARTIFACT(new NextRequest(metaUrl, { headers: { host: "[::1]:8898" } }));
  expect(meta.status).toBe(200);
  const { frame } = await meta.json() as { frame: string };
  const url = new URL(frame, "http://[::1]:8898");
  const page = await GET(new NextRequest(url, { headers: { ...FRAME_REQUEST_HEADERS, host: "[::1]:8898" } }));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("img-src data:");
  expect(page.headers.get("content-security-policy")).not.toContain("localhost");
  expect(page.headers.get("permissions-policy")).toContain("autoplay=()");
  const html = await page.text();
  expect(html).not.toContain("<base");
  expect(html).toContain('src="data:image/png;base64,');
  const chart = await GET(new NextRequest(new URL(frame.replace("index.html", "chart.png"), url), {
    headers: { ...FRAME_REQUEST_HEADERS, host: "[::1]:8898" },
  }));
  expect(chart.status).toBe(200);
  expect(Buffer.from(await chart.arrayBuffer())).toEqual(KEEP_PNG);
});

test("IPv6 fallback skips HTML image references before opening their descriptors", async () => {
  const dir = path.dirname(write("state/evidence/agents/ipv6-cycle/index.html", '<img src="other.html"><img src="chart.png"><h1>Local chart</h1>'));
  fs.writeFileSync(path.join(dir, "other.html"), '<img src="other.html"><p>must not be opened</p>');
  fs.writeFileSync(path.join(dir, "chart.png"), KEEP_PNG);
  const root = path.join(home, "state/evidence");
  const scope = mintFrameScope(dir, Date.now(), null, "evidence", null, root, root);
  const url = new URL(`/api/artifact/frame/${scope}/index.html`, "http://[::1]:8898");
  const response = await GET(new NextRequest(url, { headers: { ...FRAME_REQUEST_HEADERS, host: "[::1]:8898" } }));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Local chart");
  expect(html).toContain("src=\"data:image/png;base64,");
  expect(html).not.toContain("must not be opened");
});

test("evidence HTML parsing returns 408 after its response deadline", async () => {
  const report = write("state/evidence/agents/deadline/index.html", `<table>${"<tr><td>bounded report</td></tr>".repeat(20_000)}</table>`);
  const scope = mintFrameScope(path.dirname(report), Date.now(), null, "evidence", null,
    path.join(home, "state/evidence"), path.join(home, "state/evidence"));
  const prior = process.env.LLV_ARTIFACT_TIME_BUDGET_MS;
  process.env.LLV_ARTIFACT_TIME_BUDGET_MS = "1";
  try {
    const response = await GET(frameRequest(`/api/artifact/frame/${scope}/index.html`));
    expect(response.status).toBe(408);
    expect(await response.text()).toContain("time budget exceeded");
  } finally {
    if (prior === undefined) delete process.env.LLV_ARTIFACT_TIME_BUDGET_MS;
    else process.env.LLV_ARTIFACT_TIME_BUDGET_MS = prior;
  }
});

test("held HTML and IPv6 raster reads close with zero further reads after deadline or abort", async () => {
  const report = write("state/evidence/agents/held-read/index.html", '<h1>Held read fixture</h1><img src="chart.png">');
  fs.writeFileSync(path.join(path.dirname(report), "chart.png"), Buffer.concat([KEEP_PNG, Buffer.alloc(3 * 64 * 1024)]));
  const script = String.raw`
    import fs from "node:fs/promises";
    import path from "node:path";
    import { NextRequest } from "next/server";
    import { mintFrameScope } from "./src/lib/artifact/frameScope.ts";
    import { GET } from "./src/app/api/artifact/frame/[...rest]/route.ts";
    const filename = process.env.LLV_HELD_REPORT;
    const state = process.env.LLV_STATE_DIR;
    const raster = process.env.LLV_HELD_RASTER === "1";
    const probe = await fs.open(filename, "r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const originalRead = prototype.read;
    const originalClose = prototype.close;
    const reads = new WeakMap();
    let heldHandle;
    let closed;
    const closure = new Promise(resolve => { closed = resolve; });
    let release;
    const held = new Promise(resolve => { release = resolve; });
    prototype.read = function (...args) {
      const count = (reads.get(this) ?? 0) + 1;
      reads.set(this, count);
      // Only the fixture raster has a 64 KiB first body chunk.
      if (count !== 2 || (raster && args[2] !== 64 * 1024)) return originalRead.apply(this, args);
      heldHandle = this;
      process.stdout.write("HELD\n");
      return held.then(async () => {
        const result = await originalRead.apply(this, args);
        process.stdout.write("RELEASED\n");
        return result;
      });
    };
    prototype.close = async function (...args) {
      const result = await originalClose.apply(this, args);
      if (this === heldHandle) {
        process.stdout.write("CLOSED\n");
        closed();
      }
      return result;
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", value => {
      if (value.includes("RELEASE")) release();
      if (value.includes("ABORT")) controller.abort();
    });
    process.stdin.resume();
    const root = path.join(state, "evidence");
    const scope = mintFrameScope(path.dirname(filename), Date.now(), null, "evidence", null, root, root);
    const controller = new AbortController();
    const host = raster ? "[::1]:8898" : "127.0.0.1:8898";
    const request = new NextRequest("http://" + host + "/api/artifact/frame/" + scope + "/index.html", {
      headers: { host, "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" }, signal: controller.signal,
    });
    const response = await GET(request);
    process.stdout.write("RESULT " + response.status + "\n");
    await closure;
    process.stdout.write("READS " + reads.get(heldHandle) + "\n");
    process.stdin.pause();
  `;
  const run = async (kind: "deadline" | "abort", raster: boolean) => {
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(), stdin: "pipe", stdout: "pipe", stderr: "inherit",
      env: {
        ...process.env,
        LLV_HELD_REPORT: report,
        LLV_HELD_RASTER: raster ? "1" : "0",
        // Leave time for filesystem admission and worker startup on Win32
        // before the native response timer expires while the read is held.
        LLV_ARTIFACT_TIME_BUDGET_MS: "5000",
      },
    });
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const readLine = async () => {
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, "");
          buffered = buffered.slice(newline + 1);
          return line;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("child probe did not respond within ten seconds")), 10_000);
          }),
        ]).finally(() => clearTimeout(timer));
        if (next.done) throw new Error(`child exited before a complete line: ${buffered}`);
        buffered += decoder.decode(next.value, { stream: true });
      }
    };
    try {
      expect(await readLine()).toBe("HELD");
      if (kind === "abort") {
        child.stdin.write("ABORT\n");
        await child.stdin.flush();
      }
      expect(await readLine()).toBe(`RESULT ${kind === "deadline" ? 408 : 499}`);
      child.stdin.write("RELEASE\n");
      await child.stdin.flush();
      expect(await readLine()).toBe("RELEASED");
      expect(await readLine()).toBe("CLOSED");
      expect(await readLine()).toBe("READS 2");
      await child.stdin.end();
      expect(await child.exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      reader.releaseLock();
    }
  };
  for (const raster of [false, true]) {
    await run("deadline", raster);
    await run("abort", raster);
  }
}, 60_000);

test("an initially oversized evidence report is rejected before HTML parsing", async () => {
  const report = write("state/evidence/agents/oversized/index.html", "0123456789");
  const scope = mintFrameScope(path.dirname(report), Date.now(), null, "evidence", null,
    path.join(home, "state/evidence"), path.join(home, "state/evidence"));
  const prior = process.env.LLV_ARTIFACT_MAX_BYTES;
  process.env.LLV_ARTIFACT_MAX_BYTES = "4";
  try {
    expect((await GET(frameRequest(`/api/artifact/frame/${scope}/index.html`))).status).toBe(413);
  } finally {
    if (prior === undefined) delete process.env.LLV_ARTIFACT_MAX_BYTES;
    else process.env.LLV_ARTIFACT_MAX_BYTES = prior;
  }
});

test("workspace authorization checks the project owning each evidence target", async () => {
  const store = teamStore();
  const owner = claimInstall(store, "Fixture owner", { surface: "desktop", browser: "chrome" });
  const member = {
    id: "m_target_access", name: "Fixture member", role: "member", status: "active", color: "teal",
    telegram: null, createdAt: new Date().toISOString(), createdBy: "claim", revokedAt: null,
  } as const;
  store.insertMember(member);
  const { mintSession } = await import("@/lib/team/sessions");
  const signedIn = mintSession(store, member.id, "approval", { surface: "desktop", browser: "chrome" });
  const priorCatalog = conversationCatalogSnapshot();
  const evidence = path.join(home, "state/evidence/agents/target-access");
  const firstDir = path.join(evidence, "first-project");
  const secondDir = path.join(firstDir, "second-project");
  fs.mkdirSync(secondDir, { recursive: true });
  fs.writeFileSync(path.join(firstDir, "index.html"), "<h1>Allowed report</h1>");
  fs.writeFileSync(path.join(firstDir, "chart.png"), KEEP_PNG);
  fs.writeFileSync(path.join(secondDir, "chart.png"), KEEP_PNG);
  fs.writeFileSync(path.join(home, "state/project-catalog.json"), JSON.stringify({ files: {
    first: { cwd: firstDir, projectRoot: firstDir },
    second: { cwd: secondDir, projectRoot: secondDir },
  } }));
  const { projectForCwd } = await import("@/lib/scanner/describe");
  const firstProject = projectForCwd(firstDir)!;
  const secondProject = projectForCwd(secondDir)!;
  replaceConversationCatalog([...priorCatalog,
    { path: "first-session.jsonl", root: "codex-sessions", name: "first", project: firstProject, title: "first", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: 0, size: 0 },
    { path: "second-session.jsonl", root: "codex-sessions", name: "second", project: secondProject, title: "second", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: 0, size: 0 },
  ]);
  const workspaceId = `w_${"d".repeat(32)}`;
  createWorkspace(store, owner.member, { id: workspaceId, name: "First project", projects: [firstProject] });
  store.putWorkspaceMember(workspaceId, member.id, "member", owner.member.id, new Date().toISOString());
  const scope = mintFrameScope(firstDir, Date.now(), signedIn.session.id, "evidence", firstProject,
    path.join(home, "state/evidence"), path.join(home, "state/evidence"));
  const target = (name: string) => `/api/artifact/frame/${scope}/${name}`;
  try {
    expect((await GET(frameRequest(target("index.html")))).status).toBe(200);
    expect((await GET(frameRequest(target("chart.png")))).status).toBe(200);
    expect((await GET(frameRequest(target("second-project/chart.png")))).status).toBe(403);
  } finally {
    replaceConversationCatalog([...priorCatalog]);
  }
});

test.skipIf(process.platform !== "win32")("a native drive-letter evidence link opens its HTML frame", async () => {
  const report = write("state/evidence/agents/native-windows/index.html", "<h1>Native Windows report</h1>");
  expect(resolveLink(report)).toMatchObject({ kind: "file", path: report });
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", report);
  url.searchParams.set("mode", "meta");
  const metaResponse = await GET_ARTIFACT(new NextRequest(url, { headers: { host: "127.0.0.1:8898" } }));
  expect(metaResponse.status).toBe(200);
  const { frame } = await metaResponse.json() as { frame: string };
  const page = await GET(frameRequest(frame));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Native Windows report");
});

test("workspace removal revokes a live session's evidence document and raster grant", async () => {
  const store = teamStore();
  const owner = claimInstall(store, "Fixture owner", { surface: "desktop", browser: "chrome" });
  const member = {
    id: "m_evidence_member", name: "Fixture member", role: "member", status: "active", color: "teal",
    telegram: null, createdAt: new Date().toISOString(), createdBy: "claim", revokedAt: null,
  } as const;
  store.insertMember(member);
  const { mintSession } = await import("@/lib/team/sessions");
  const signedIn = mintSession(store, member.id, "approval", { surface: "desktop", browser: "chrome" });
  const dir = path.join(home, "state/evidence/agents/workspace-fixture");
  write("state/evidence/agents/workspace-fixture/index.html", "<h1>Workspace report</h1>");
  fs.writeFileSync(path.join(home, "state/evidence/agents/workspace-fixture/chart.png"), KEEP_PNG);
  const { projectForCwd } = await import("@/lib/scanner/describe");
  const reportProject = projectForCwd(dir)!;
  const priorCatalog = conversationCatalogSnapshot();
  replaceConversationCatalog([...priorCatalog, {
    path: "evidence-workspace.jsonl", root: "codex-sessions", name: "fixture", project: reportProject,
    title: "fixture", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", mtime: 0, size: 0,
  }]);
  const workspaceId = `w_${"c".repeat(32)}`;
  createWorkspace(store, owner.member, { id: workspaceId, name: "Evidence workspace", projects: [reportProject] });
  store.putWorkspaceMember(workspaceId, member.id, "member", owner.member.id, new Date().toISOString());
  const evidenceRoot = path.join(home, "state/evidence");
  const scope = mintFrameScope(dir, Date.now(), signedIn.session.id, "evidence", reportProject, evidenceRoot, evidenceRoot);
  const target = (name: string) => `/api/artifact/frame/${scope}/${name}`;
  try {
    expect((await GET(frameRequest(target("index.html")))).status).toBe(200);
    expect((await GET(frameRequest(target("chart.png")))).status).toBe(200);
    store.removeWorkspaceMember(workspaceId, member.id);
    expect((await GET(frameRequest(target("index.html")))).status).toBe(403);
    expect((await GET(frameRequest(target("chart.png")))).status).toBe(403);
  } finally {
    replaceConversationCatalog([...priorCatalog]);
  }
});

test("an evidence grant cannot acquire a project's non-raster asset permissions", async () => {
  // This configured evidence root contains a recorded project.
  const root = path.dirname(home);
  const previous = process.env.LLV_EVIDENCE_ROOTS;
  process.env.LLV_EVIDENCE_ROOTS = root;
  try {
    write("chart.css", "h1 { color: teal }");
    const asset = `${path.basename(home)}/chart.css`;
    const project = await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(root)}/${asset}`));
    expect(project.status).toBe(200);
    expect(await project.text()).toBe("h1 { color: teal }");
    const evidence = await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(root, Date.now(), null, "evidence", null, root, root)}/${asset}`));
    expect(evidence.status).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.LLV_EVIDENCE_ROOTS;
    else process.env.LLV_EVIDENCE_ROOTS = previous;
  }
});

test("the real metadata route binds a frame to its browser session, whose sign-out refuses the document and assets", async () => {
  const dir = reportDir();
  const store = teamStore();
  const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" });
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", path.join(dir, "index.html"));
  url.searchParams.set("mode", "meta");
  const metaResponse = await GET_ARTIFACT(new NextRequest(url, { headers: { host: "127.0.0.1:8898", cookie: `llv_member=${owner.cookie}` } }));
  expect(metaResponse.status).toBe(200);
  const { frame } = await metaResponse.json() as { frame: string };
  expect((await GET(frameRequest(frame))).status).toBe(200);
  signOutSession(store, owner.member, owner.session);
  expect((await GET(frameRequest(frame))).status).toBe(403);
  expect((await GET(frameRequest(frame.replace("index.html", "style.css")))).status).toBe(403);
});

test("relative assets load with their real types, from the same scope", async () => {
  const scope = mintFrameScope(reportDir());
  const css = await GET(frameRequest(`/api/artifact/frame/${scope}/style.css`));
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  const js = await GET(frameRequest(`/api/artifact/frame/${scope}/assets/app.js`));
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
});

test("every response runs in an origin-less sandbox: scripts yes, the viewer's origin no", async () => {
  const scope = mintFrameScope(reportDir());
  for (const res of [
    await GET(frameRequest(`/api/artifact/frame/${scope}/index.html`)),
    await GET(frameRequest(`/api/artifact/frame/${scope}/missing.html`)),
    await GET(frameRequest(`/api/artifact/frame/forged/index.html`)),
  ]) {
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp.startsWith("sandbox ")).toBe(true);
    expect(csp).toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
  /* The iframe attribute carries the same promise. */
  expect(FRAME_SANDBOX).toContain("allow-scripts");
  expect(FRAME_SANDBOX).not.toContain("allow-same-origin");
});

test("the frame cannot read the viewer: its requests to the viewer's API are refused", async () => {
  const dir = reportDir();
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", path.join(dir, "../../secrets.md"));
  for (const headers of <Record<string, string>[]>[
    /* fetch() from the sandboxed page */
    { host: "127.0.0.1:8898", origin: "null", "sec-fetch-site": "cross-site" },
    /* a no-cors subresource from the sandboxed page */
    { host: "127.0.0.1:8898", "sec-fetch-site": "cross-site" },
  ]) {
    const res = await GET_ARTIFACT(new NextRequest(url, { headers }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("outside the report");
  }
});

test("a scope reaches nothing outside its report directory", async () => {
  const scope = mintFrameScope(reportDir());
  for (const escape of ["../../secrets.md", "..%2F..%2Fsecrets.md", "%2E%2E/%2E%2E/secrets.md", "assets/..%2F..%2F..%2Fsecrets.md"]) {
    const res = await GET(frameRequest(`/api/artifact/frame/${scope}/${escape}`));
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("outside the report");
  }
});

test("a symlink inside the report that points out of it is refused", async () => {
  const dir = reportDir();
  fs.symlinkSync(path.join(home, "checkout/secrets.md"), path.join(dir, "linked.md"));
  const res = await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(dir)}/linked.md`));
  expect(res.status).toBe(403);
});

test("valid evidence grants verify before each signed field is independently tampered", async () => {
  const dir = path.join(home, "state/evidence/agents/signatures");
  write("state/evidence/agents/signatures/index.html", "<p>signature control</p>");
  const root = path.join(home, "state/evidence");
  const scope = mintFrameScope(dir, Date.now(), null, "evidence", "project-a", root, root);
  const fields = scope.split(".");
  expect(fields).toHaveLength(8);
  expect((await GET(frameRequest(`/api/artifact/frame/${scope}/index.html`))).status).toBe(200);
  const changes: Array<[number, string]> = [
    [0, Buffer.from(path.join(home, "checkout"), "utf8").toString("base64url")],
    [1, (Date.now() + 10 * FRAME_SCOPE_TTL_MS).toString(36)],
    [2, "different-session"],
    [3, "project"],
    [4, Buffer.from("project-b", "utf8").toString("base64url")],
    [5, Buffer.from(path.join(home, "other-evidence"), "utf8").toString("base64url")],
    [6, Buffer.from(path.join(home, "other-root"), "utf8").toString("base64url")],
    [7, `${fields[7]!.slice(0, -1)}${fields[7]!.endsWith("A") ? "B" : "A"}`],
  ];
  for (const [index, value] of changes) {
    const altered = [...fields];
    altered[index] = value;
    expect(altered).toHaveLength(8);
    const res = await GET(frameRequest(`/api/artifact/frame/${altered.join(".")}/index.html`));
    expect(res.status).toBe(403);
  }
  expect((await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(dir, Date.now() - 2 * FRAME_SCOPE_TTL_MS)}/index.html`))).status).toBe(403);
});

test("evidence HTML reads reject actual growth beyond the bound and honor cancellation and deadline", async () => {
  const report = write("state/evidence/agents/growing/index.html", "four");
  const handle = await fs.promises.open(report, "r");
  try {
    expect((await handle.stat()).size).toBe(4);
    fs.appendFileSync(report, "more");
    await expect(readEvidenceHtml(handle, 6, new AbortController().signal, Date.now() + 5_000)).rejects.toThrow("byte bound");
  } finally { await handle.close(); }

  const initiallyLarge = write("state/evidence/agents/large/index.html", "12345678");
  const largeHandle = await fs.promises.open(initiallyLarge, "r");
  try {
    await expect(readEvidenceHtml(largeHandle, 4, new AbortController().signal, Date.now() + 5_000)).rejects.toThrow("byte bound");
  } finally { await largeHandle.close(); }

  const cancelled = new AbortController();
  cancelled.abort();
  const cancelledHandle = await fs.promises.open(report, "r");
  try { await expect(readEvidenceHtml(cancelledHandle, 64, cancelled.signal, Date.now() + 5_000)).rejects.toThrow("client aborted"); }
  finally { await cancelledHandle.close(); }
  const deadlineHandle = await fs.promises.open(report, "r");
  try { await expect(readEvidenceHtml(deadlineHandle, 64, new AbortController().signal, Date.now())).rejects.toThrow("time budget"); }
  finally { await deadlineHandle.close(); }
});

test("a scope for a directory outside home serves nothing", async () => {
  const outside = fs.mkdtempSync(path.join(sandbox, "outside-"));
  fs.writeFileSync(path.join(outside, "index.html"), "<p>outside</p>");
  const res = await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(outside)}/index.html`));
  expect(res.status).toBe(403);
});

test("types the preview does not serve stay unserved", async () => {
  const dir = reportDir();
  write("checkout/reports/round-2/session.jsonl", "{}\n");
  write("checkout/reports/round-2/.env", "X=1\n");
  const scope = mintFrameScope(dir);
  expect((await GET(frameRequest(`/api/artifact/frame/${scope}/session.jsonl`))).status).toBe(415);
  expect((await GET(frameRequest(`/api/artifact/frame/${scope}/.env`))).status).toBe(403);
});

for (const spelling of ["alias.txt", ".meta/notes.txt", ".meta/visible.txt", "chain.txt"]) {
  test(`hidden path policy refuses frame ${spelling}`, async () => {
    const dir = reportDir();
    fs.writeFileSync(path.join(dir, ".env.local"), "fixture private text\n");
    fs.symlinkSync(path.join(dir, ".env.local"), path.join(dir, "alias.txt"));
    fs.symlinkSync(path.join(dir, "alias.txt"), path.join(dir, "chain.txt"));
    fs.mkdirSync(path.join(dir, ".meta"));
    fs.writeFileSync(path.join(dir, ".meta/notes.txt"), "fixture private text\n");
    fs.writeFileSync(path.join(dir, "visible.txt"), "fixture private text\n");
    fs.symlinkSync(path.join(dir, "visible.txt"), path.join(dir, ".meta/visible.txt"));
    const res = await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(dir)}/${spelling}`));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("fixture private text");
  });
}

test("hidden path policy mints no frame scope for a hidden report folder", async () => {
  const file = write(".meta/r2/index.html", "<p>fixture private text</p>");
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", file);
  url.searchParams.set("mode", "meta");
  const res = await GET_ARTIFACT(new NextRequest(url, { headers: { host: "127.0.0.1" } }));
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.frame).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("fixture private text");
});

test("keep path policy serves a nested worktree report frame and stylesheet", async () => {
  const fixture = localFileKeepFixture(home);
  process.env.HOME = fixture.home;
  process.env.LLV_STATE_DIR = fixture.state;
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", path.join(fixture.frameDirectory, "index.html"));
  url.searchParams.set("mode", "meta");
  const meta = await GET_ARTIFACT(new NextRequest(url, { headers: { host: "127.0.0.1" } }));
  expect(meta.status).toBe(200);
  const { frame } = await meta.json() as { frame: string };
  for (const [name, bytes] of [["index.html", "<h1>Fixture report</h1>"], ["style.css", "h1 { color: teal }"]]) {
    const res = await GET(frameRequest(frame.replace("index.html", name!)));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(bytes!);
  }
});

test("a foreign Host header is refused before the scope is read", async () => {
  const scope = mintFrameScope(reportDir());
  const res = await GET(frameRequest(`/api/artifact/frame/${scope}/index.html`, { host: "attacker.example" }));
  expect(res.status).toBe(403);
});

test("the frame refuses every file /api/artifact refuses for its content", async () => {
  const dir = reportDir();
  const meta = new URL("http://127.0.0.1:8898/api/artifact");
  meta.searchParams.set("path", path.join(dir, "index.html"));
  meta.searchParams.set("mode", "meta");
  const { frame } = (await (await GET_ARTIFACT(new NextRequest(meta, { headers: { host: "127.0.0.1:8898" } }))).json()) as { frame: string };
  fs.writeFileSync(path.join(dir, "binary.txt"), Buffer.from([65, 0, 66]));
  fs.writeFileSync(path.join(dir, "fake.png"), "not a png at all");
  fs.writeFileSync(path.join(dir, "fake.svg"), "plain words, no markup");
  for (const name of ["binary.txt", "fake.png", "fake.svg"]) {
    const direct = new URL("http://127.0.0.1:8898/api/artifact");
    direct.searchParams.set("path", path.join(dir, name));
    expect((await GET_ARTIFACT(new NextRequest(direct, { headers: { host: "127.0.0.1:8898" } }))).status).toBe(415);
    const framed = await GET(frameRequest(frame.replace(/index\.html$/, name)));
    expect(framed.status).toBe(415);
    expect(Buffer.from(await framed.arrayBuffer()).includes(0)).toBe(false);
  }
});

test("the report's opaque origin may read its own assets by CORS, without credentials", async () => {
  const scope = mintFrameScope(reportDir());
  const moduleRequest = { ...FRAME_REQUEST_HEADERS, origin: "null", "sec-fetch-dest": "script", "sec-fetch-mode": "cors" };
  const js = await GET(frameRequest(`/api/artifact/frame/${scope}/assets/app.js`, moduleRequest));
  expect(js.status).toBe(200);
  expect(js.headers.get("access-control-allow-origin")).toBe("null");
  expect(js.headers.get("access-control-allow-credentials")).toBeNull();
  /* Only the opaque origin, and only on an authorized response. */
  const foreign = await GET(frameRequest(`/api/artifact/frame/${scope}/assets/app.js`, { ...moduleRequest, origin: "https://attacker.example" }));
  expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
  const forged = await GET(frameRequest(`/api/artifact/frame/forged/assets/app.js`, moduleRequest));
  expect(forged.status).toBe(403);
  expect(forged.headers.get("access-control-allow-origin")).toBeNull();
});

test("hidden path policy refuses legacy store bytes through a frame asset alias", async () => {
  const legacy = legacyReportPictureFixture(path.join(home, "legacy-checkout"));
  const dir = reportDir();
  fs.symlinkSync(legacy.copy, path.join(dir, "legacy.png"));
  const scope = mintFrameScope(dir);
  const res = await GET(frameRequest(`/api/artifact/frame/${scope}/legacy.png`));
  expect(res.status).toBe(403);
  expect(await res.text()).not.toContain(legacy.source);
});
