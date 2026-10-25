import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import type { FilesResponse } from "@/lib/types";
import type { workspaceScope } from "./workspaceAccess";
import { createWorkspaceFilesResponder } from "./workspaceFilesResponse";

function scopeFor(projects: string[], memberId = "member"): ReturnType<typeof workspaceScope> {
  const allowed = new Set(projects);
  return {
    memberId, owner: false, manager: false, projectFilter: { allowed: projects }, workspaces: [],
    role: () => "member", canAct: project => Boolean(project && allowed.has(project)),
    canReadFile: project => Boolean(project && allowed.has(project)),
    access: project => project && allowed.has(project) ? "member" : "none",
  };
}

const board: FilesResponse = {
  files: [], tasks: [], flows: [], pipelines: [], workflows: [],
  projectDisplayNames: { alpha: "a".repeat(2048), beta: "foreign" },
  systemHealth: { tmux: { status: "healthy" } },
};
const after = () => undefined;

test("scoped validators avoid decoding unchanged operator JSON and support gzip", async () => {
  let parses = 0;
  let sourceEtag = '"source-one"';
  const validators: (string | null)[] = [];
  const scope = scopeFor(["alpha"]);
  const respond = createWorkspaceFilesResponder(async request => {
    const validator = request.headers.get("if-none-match");
    validators.push(validator);
    expect(request.headers.get("x-llv-files-generation")).toBe("3");
    expect(request.headers.has("x-llv-spawn-capability")).toBe(false);
    expect(request.headers.has("x-llv-board-protocol")).toBe(false);
    expect(request.headers.has("accept-encoding")).toBe(false);
    if (validator === sourceEtag) return new Response(null, { status: 304, headers: { etag: sourceEtag } });
    const response = Response.json(board, { headers: { etag: sourceEtag } });
    const decode = response.json.bind(response);
    response.json = () => { parses++; return decode(); };
    return response;
  }, () => scope);
  const request = (etag?: string) => new Request("http://localhost/api/files?view=summary", { headers: {
    "accept-encoding": "gzip", "x-llv-files-generation": "3", "x-llv-spawn-capability": "untrusted",
    "x-llv-board-protocol": "2", ...(etag ? { "if-none-match": etag } : {}),
  } });
  const first = await respond(request(), scope, after);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-encoding")).toBe("gzip");
  const text = gunzipSync(await first.arrayBuffer()).toString();
  expect(text).not.toContain("foreign");
  expect(JSON.parse(text).projectDisplayNames.alpha).toHaveLength(2048);
  const etag = first.headers.get("etag")!;
  expect(etag).not.toBe(sourceEtag);
  const second = await respond(request(etag), scope, after);
  expect(second.status).toBe(304);
  expect(await second.text()).toBe("");
  expect(validators).toEqual([null, sourceEtag]);
  expect(parses).toBe(1);
  sourceEtag = '"source-two"';
  const third = await respond(request(etag), scope, after);
  // Changes outside this member's projection still validate as unchanged.
  expect(third.status).toBe(304);
  expect(parses).toBe(2);
});

test("a validator never crosses members, changed placement, or revocation while awaiting the source", async () => {
  let scope = scopeFor(["alpha"]);
  let onSource = () => {};
  const respond = createWorkspaceFilesResponder(async () => {
    await Promise.resolve();
    onSource();
    return Response.json(board, { headers: { etag: '"source"' } });
  }, () => scope);
  const request = (etag?: string) => new Request("http://localhost/api/files", { headers: etag ? { "if-none-match": etag } : {} });
  const first = await respond(request(), scope, after);
  const etag = first.headers.get("etag")!;
  await first.body?.cancel();
  scope = scopeFor(["beta"], "another-member");
  const other = await respond(request(etag), scope, after);
  expect(other.status).toBe(200);
  expect(other.headers.get("etag")).not.toBe(etag);
  expect((await other.json()).projectDisplayNames).toEqual({ beta: "foreign" });
  const before = scope;
  onSource = () => { scope = scopeFor([]); };
  expect((await respond(request(), before, after)).status).toBe(403);
});

test("the route cache evicts its oldest scope after sixteen entries and fails closed on source errors", async () => {
  const scope = scopeFor(["alpha"]);
  const validators: (string | null)[] = [];
  let fail = false;
  const respond = createWorkspaceFilesResponder(async request => {
    validators.push(request.headers.get("if-none-match"));
    return fail ? new Response(null, { status: 503 }) : Response.json(board, { headers: { etag: '"source"' } });
  }, () => scope);
  for (let i = 0; i < 17; i++) {
    const response = await respond(new Request(`http://localhost/api/files?project=${i}`), scope, after);
    await response.body?.cancel();
  }
  await (await respond(new Request("http://localhost/api/files?project=0"), scope, after)).body?.cancel();
  expect(validators.at(-1)).toBeNull();
  fail = true;
  expect((await respond(new Request("http://localhost/api/files?project=0"), scope, after)).status).toBe(503);
});


test("overlapping refresh and eviction retain the byte bound", async () => {
  const scope = scopeFor(["alpha"]);
  const large = { ...board, projectDisplayNames: { alpha: "x".repeat(17 * 1024 * 1024) } };
  let entered!: () => void;
  let release!: (response: Response) => void;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const validators: (string | null)[] = [];
  let aReads = 0;
  const respond = createWorkspaceFilesResponder(async request => {
    const slot = new URL(request.url).searchParams.get("slot");
    if (slot === "a" && ++aReads === 2) { entered(); return pending; }
    if (slot === "b") validators.push(request.headers.get("if-none-match"));
    return Response.json(large, { headers: { etag: `"${slot}"` } });
  }, () => scope);
  const a = new Request("http://localhost/api/files?slot=a");
  const b = new Request("http://localhost/api/files?slot=b");
  await (await respond(a, scope, after)).body?.cancel();
  const refresh = respond(a, scope, after);
  await started;
  try {
    // B evicts the A entry captured by the pending refresh.
    await (await respond(b, scope, after)).body?.cancel();
  } finally {
    release(Response.json(large, { headers: { etag: '"a-new"' } }));
    await (await refresh).body?.cancel();
  }
  // Completing A evicts B: the two bodies together exceed 32 MiB.
  await (await respond(b, scope, after)).body?.cancel();
  expect(validators).toEqual([null, null]);
});
