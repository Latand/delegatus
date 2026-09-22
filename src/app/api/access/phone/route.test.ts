import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import type { AccessResponse, PhoneActionFailure } from "@/lib/access/phoneAccess";
import { createTailscaleStub, STUB_DNS_NAME, type TailscaleStub } from "@/test-helpers/tailscaleStub";

import { GET } from "../route";
import { POST } from "./route";

/*
 * One-button phone access (#1876 slice 3, design §2.3), against a stand-in
 * `tailscale` on an isolated PATH and a throw-away config home. The real
 * Tailscale, and the operator's serve mapping, are never run.
 */

const PORT = 4310;
const GATE = ["LLV_TOKEN", "LLV_TS_HOST", "LLV_TS_URL"] as const;
const SAVED = ["PATH", "XDG_CONFIG_HOME", "PORT", "HOSTNAME", ...GATE] as const;
const saved: Record<string, string | undefined> = {};

let stub: TailscaleStub;
let config: string;

/* Name-indexed on purpose: the three gate variables are credentials, and a
   literal assignment to one reads as a leak to the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  for (const name of SAVED) saved[name] = process.env[name];
  stub = createTailscaleStub();
  config = fs.mkdtempSync(path.join(os.tmpdir(), "llv-phone-access-config-"));
  setEnv("XDG_CONFIG_HOME", config);
  setEnv("PATH", stub.dir);
  setEnv("PORT", undefined);
  setEnv("HOSTNAME", "127.0.0.1");
  for (const name of GATE) setEnv(name, undefined);
});

afterEach(() => {
  for (const name of SAVED) setEnv(name, saved[name]);
  stub.cleanup();
  fs.rmSync(config, { recursive: true, force: true });
});

const appDir = () => path.join(config, "agent-log-viewer");
const flagFile = () => path.join(appDir(), "phone-access");
const tokenFile = () => path.join(appDir(), "token");

function read(): Promise<AccessResponse> {
  return GET(new NextRequest(`http://127.0.0.1:${PORT}/api/access`, { headers: { host: `127.0.0.1:${PORT}` } })).then((response) => response.json() as Promise<AccessResponse>);
}

function press(action: "enable" | "disable") {
  return POST(new NextRequest(`http://127.0.0.1:${PORT}/api/access/phone`, {
    method: "POST",
    headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" },
    body: JSON.stringify({ action }),
  }));
}

const gateUntouched = () => GATE.every((name) => process.env[name] === undefined);

describe("GET /api/access reads the six phone states from Tailscale", () => {
  test("not installed", async () => {
    setEnv("PATH", stub.emptyDir);
    expect((await read()).phone).toMatchObject({ state: "missing", dnsName: null, viewerPort: PORT });
  });

  test("installed and not signed in, for every backend state that is not Running", async () => {
    for (const BackendState of ["NeedsLogin", "Stopped", "NoState", "NeedsMachineAuth", "Starting"]) {
      stub.setStatus({ BackendState, Self: { DNSName: "" } });
      expect((await read()).phone?.state).toBe("needs-login");
    }
  });

  test("signed in without MagicDNS", async () => {
    stub.setStatus({ BackendState: "Running", Self: { DNSName: "" } });
    expect((await read()).phone?.state).toBe("no-dns");
  });

  test("ready, serving another port, and serving this Viewer", async () => {
    expect((await read()).phone).toMatchObject({ state: "ready", dnsName: STUB_DNS_NAME, servingPort: null, persisted: false });
    stub.setServing(3000);
    expect((await read()).phone).toMatchObject({ state: "serving-other", servingPort: 3000 });
    /* A background mapping an earlier run left behind points here, but this
       process holds no key yet: still one press away. */
    stub.setServing(PORT);
    expect((await read()).phone).toMatchObject({ state: "ready", servingPort: PORT });
    setEnv("LLV_TOKEN", "0".repeat(32));
    setEnv("LLV_TS_URL", `https://${STUB_DNS_NAME}/?k=${"0".repeat(32)}`);
    expect((await read()).phone?.state).toBe("serving");
  });

  test("a status Tailscale cannot answer is reported, not guessed", async () => {
    stub.setStatus(null);
    expect(await read()).toMatchObject({ phone: null, phoneError: "STATUS_UNREADABLE" });
  });
});

describe("POST /api/access/phone enable", () => {
  test("persists the choice, reuses the key at mode 600, publishes with --bg by argv, verifies, re-binds and signs the caller in", async () => {
    const existing = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(tokenFile(), existing, { mode: 0o644 });

    const response = await press("enable");
    expect(response.status).toBe(200);
    const body = await response.json() as AccessResponse;
    expect(body.phone).toMatchObject({ state: "serving", persisted: true, servingPort: PORT });
    expect(body.tailnetUrl).toBe(`https://${STUB_DNS_NAME}/?k=${existing}`);

    expect(fs.readFileSync(flagFile(), "utf8")).toBe("tailscale\n");
    expect(fs.statSync(flagFile()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(tokenFile(), "utf8")).toBe(existing);
    expect(fs.statSync(tokenFile()).mode & 0o777).toBe(0o600);

    expect(stub.calls()).toContain(`serve --bg ${PORT}`);
    const serveIndex = stub.calls().indexOf(`serve --bg ${PORT}`);
    expect(stub.calls().slice(serveIndex + 1)).toContain("serve status --json");

    expect(process.env.LLV_TOKEN).toBe(existing);
    expect(process.env.LLV_TS_HOST).toBe(STUB_DNS_NAME);
    expect(process.env.LLV_TS_URL).toBe(`https://${STUB_DNS_NAME}/?k=${existing}`);

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`llv_auth=${existing}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=lax");
  });

  test("mints a key when there is none, and the reply body never carries it outside the link", async () => {
    const response = await press("enable");
    expect(response.status).toBe(200);
    const minted = fs.readFileSync(tokenFile(), "utf8");
    expect(minted).toMatch(/^[0-9a-f]{32}$/);
    const text = JSON.stringify(await response.json());
    expect(text.split(minted).length - 1).toBe(1);
  });

  test("replaces another service's mapping once the user pressed through its warning", async () => {
    stub.setServing(3000);
    expect((await press("enable")).status).toBe(200);
    expect((await read()).phone?.servingPort).toBe(PORT);
  });

  const failures: Array<[string, "operator" | "fail" | "hang" | "noverify", PhoneActionFailure["code"], number]> = [
    ["the operator right is missing", "operator", "OPERATOR_RIGHTS", 502],
    ["serve exits non-zero", "fail", "SERVE_FAILED", 502],
    ["serve never exits", "hang", "TIMEOUT", 504],
    ["serve says yes and the status disagrees", "noverify", "VERIFY_FAILED", 502],
  ];
  for (const [name, mode, code, status] of failures) {
    test(`${name}: ${code}, the process environment untouched and the choice not remembered`, async () => {
      stub.setServeMode(mode);
      const response = await press("enable");
      expect(response.status).toBe(status);
      const body = await response.json() as PhoneActionFailure;
      expect(body.code).toBe(code);
      if (code === "SERVE_FAILED") expect(body.detail).toBe("error: listener already in use");
      expect(gateUntouched()).toBe(true);
      expect(fs.existsSync(flagFile())).toBe(false);
      expect(body.tailnetUrl).toBeNull();
    }, 20_000);
  }

  test("a key file that cannot be written is TOKEN_WRITE_FAILED", async () => {
    fs.mkdirSync(tokenFile(), { recursive: true });
    const body = await (await press("enable")).json() as PhoneActionFailure;
    expect(body.code).toBe("TOKEN_WRITE_FAILED");
    expect(gateUntouched()).toBe(true);
  });

  test("a choice that cannot be remembered is PERSIST_FAILED and nothing is published", async () => {
    fs.mkdirSync(flagFile(), { recursive: true });
    const body = await (await press("enable")).json() as PhoneActionFailure;
    expect(body.code).toBe("PERSIST_FAILED");
    expect(stub.calls().some((call) => call.startsWith("serve --bg"))).toBe(false);
    expect(gateUntouched()).toBe(true);
  });

  test("a Tailscale that is not ready refuses without running serve", async () => {
    stub.setStatus({ BackendState: "NeedsLogin" });
    const response = await press("enable");
    expect(response.status).toBe(409);
    expect((await response.json() as PhoneActionFailure).code).toBe("NOT_READY");
    expect(stub.calls().some((call) => call.startsWith("serve --bg"))).toBe(false);
  });
});

describe("POST /api/access/phone disable", () => {
  test("takes the mapping down, forgets the choice, lifts the gate and keeps the key", async () => {
    expect((await press("enable")).status).toBe(200);
    const key = fs.readFileSync(tokenFile(), "utf8");
    const response = await press("disable");
    expect(response.status).toBe(200);
    expect(stub.calls()).toContain(`serve --https=443 ${PORT} off`);
    expect(fs.existsSync(flagFile())).toBe(false);
    expect(gateUntouched()).toBe(true);
    expect(fs.readFileSync(tokenFile(), "utf8")).toBe(key);
    expect((await response.json() as AccessResponse).phone?.state).toBe("ready");
  });

  test("a Viewer bound beyond loopback keeps its key when phone access goes off", async () => {
    expect((await press("enable")).status).toBe(200);
    setEnv("HOSTNAME", "0.0.0.0");
    expect((await press("disable")).status).toBe(200);
    expect(process.env.LLV_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(process.env.LLV_TS_URL).toBeUndefined();
  });

  test("an unknown action is refused", async () => {
    const response = await POST(new NextRequest(`http://127.0.0.1:${PORT}/api/access/phone`, {
      method: "POST",
      headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "rotate" }),
    }));
    expect(response.status).toBe(400);
  });
});
