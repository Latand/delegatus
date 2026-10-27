import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each invocation imports the real store and request gate in a fresh process.
// No module reset or inherited database handle can stand in for persistence.
const child = `
  import { NextRequest } from "next/server";
  import { proxy } from "./src/proxy";
  import { claimInstall, startApproval, confirmApproval, completeApproval } from "./src/lib/team/members";
  import { MEMBER_COOKIE, requestSession, sha256Hex } from "./src/lib/team/sessions";
  import { teamStore, existingTeamStore } from "./src/lib/team/store";

  const input = await Bun.stdin.json();
  let result;
  if (input.action === "pair") {
    const store = teamStore();
    const owner = claimInstall(store, "Owner", { surface: "desktop", browser: "chrome" }).member;
    const phone = { surface: "phone", browser: "safari" };
    const { challenge } = startApproval(store, phone);
    confirmApproval(store, owner, challenge.id, true);
    const signedIn = completeApproval(store, challenge, phone);
    result = { cookie: signedIn.cookie, memberId: owner.id, sessionId: signedIn.session.id };
  } else {
    const store = existingTeamStore();
    if (input.action === "revoke") store.revokeSession(sha256Hex(input.cookie), new Date().toISOString());
    const request = new NextRequest("http://localhost/api/team/me", {
      headers: { host: "localhost", cookie: MEMBER_COOKIE + "=" + input.cookie },
    });
    const live = requestSession(request);
    const response = proxy(request);
    result = {
      memberId: live?.member.id ?? null,
      sessionId: live?.session.id ?? null,
      surface: live?.session.surface ?? null,
      status: response.status,
      admitted: response.headers.get("x-middleware-next") === "1",
      storedHash: store?.session(sha256Hex(input.cookie))?.id ?? null,
    };
  }
  console.log(JSON.stringify(result));
  // Exit without closing the store explicitly, as a stopped Viewer would.
`;

test("an approved phone session survives a new Viewer process and remains revocable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-session-restart-"));
  async function run(input: Record<string, unknown>) {
    const process = Bun.spawn([globalThis.process.execPath, "--eval", child], {
      cwd: path.resolve(import.meta.dir, "../../.."),
      env: {
        ...globalThis.process.env,
        HOME: path.join(directory, "home"),
        XDG_CONFIG_HOME: path.join(directory, "config"),
        TMPDIR: directory,
        LLV_STATE_DIR: path.join(directory, "state"),
        LLV_TOKEN: "restart-test-perimeter-key",
      },
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    return JSON.parse(stdout);
  }
  try {
    const paired = await run({ action: "pair" });
    const expected = {
      memberId: paired.memberId, sessionId: paired.sessionId, surface: "phone",
      status: 200, admitted: true, storedHash: paired.sessionId,
    };
    expect(await run({ action: "verify", cookie: paired.cookie })).toEqual(expected);
    expect(await run({ action: "verify", cookie: "A".repeat(43) })).toMatchObject({
      memberId: null, status: 401, admitted: false,
    });
    expect(await run({ action: "revoke", cookie: paired.cookie })).toMatchObject({
      memberId: null, status: 401, admitted: false,
    });
    expect(await run({ action: "verify", cookie: paired.cookie })).toMatchObject({
      memberId: null, status: 401, admitted: false,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
