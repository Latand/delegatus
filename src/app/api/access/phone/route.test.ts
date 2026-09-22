import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { PhoneGateRefusal, restorePhoneAccessGate, type AccessResponse, type PhoneActionFailure } from "@/lib/access/phoneAccess";
import { statePath } from "@/lib/configDir";
import { gatePhoneAccessBeforeServing } from "@/lib/viewerInstrumentation";
import { proxy } from "@/proxy";
import { VIEWER_GATEWAY_FILE } from "@/runtime-host/deploymentProxy";
import { createTailscaleStub, STUB_DNS_NAME, type TailscaleStub } from "@/test-helpers/tailscaleStub";

import { detectTailscale } from "../../../../../bin/tailscale.mjs";

import { GET } from "../route";
import { POST } from "./route";

/*
 * One-button phone access (#1876 slice 3, design §2.3), against a stand-in
 * `tailscale` on an isolated PATH and a throw-away config home. The real
 * Tailscale, and the operator's serve mapping, are never run.
 */

const PORT = 4310;
const GATE = ["LLV_TOKEN", "LLV_TS_HOST", "LLV_TS_URL"] as const;
const SAVED = ["PATH", "XDG_CONFIG_HOME", "PORT", "HOSTNAME", "LLV_DOCKER_NSENTER_SHIMS", "LLV_VIEWER_PORT", ...GATE] as const;
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
  setEnv("LLV_DOCKER_NSENTER_SHIMS", undefined);
  setEnv("LLV_VIEWER_PORT", undefined);
  for (const name of GATE) setEnv(name, undefined);
});

afterEach(() => {
  for (const name of SAVED) setEnv(name, saved[name]);
  stub.cleanup();
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(gatewayFile(), { force: true });
});

const gatewayFile = () => statePath(VIEWER_GATEWAY_FILE);

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

describe("GET /api/access reads the seven phone states from Tailscale", () => {
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
    /* A background mapping an earlier run left behind points here while this
       process holds no key: the tailnet reaches an ungated Viewer, which is
       its own state, and one press re-binds it. */
    stub.setServing(PORT);
    expect((await read()).phone).toMatchObject({ state: "exposed", servingPort: PORT });
    /* A start that gates without a link of its own — the launcher's local
       fallback, or a non-loopback bind — asks every connection for the key,
       so the mapping does not reach an ungated Viewer and the step must not
       say it does. */
    setEnv("LLV_TOKEN", "0".repeat(32));
    expect((await read()).phone?.state).toBe("ready");
    setEnv("LLV_TS_URL", `https://${STUB_DNS_NAME}/?k=${"0".repeat(32)}`);
    expect((await read()).phone?.state).toBe("serving");
  });

  test("a foreground serve session is read as published, so a --tailscale start shows its link", async () => {
    /* `tailscale serve <port>` (no --bg) keeps its map under Foreground[<session>]
       and leaves the top-level Web empty; the explicit --tailscale start uses it. */
    stub.setServingForeground(PORT);
    expect((await read()).phone).toMatchObject({ state: "exposed", servingPort: PORT });
    setEnv("LLV_TOKEN", "0".repeat(32));
    setEnv("LLV_TS_URL", `https://${STUB_DNS_NAME}/?k=${"0".repeat(32)}`);
    expect((await read()).phone).toMatchObject({ state: "serving", servingPort: PORT });
    stub.setServingForeground(3000);
    expect((await read()).phone).toMatchObject({ state: "serving-other", servingPort: 3000 });
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
      /* The sentence reads "…could not publish the Viewer: listener already in use.", not "…: error: …". */
      if (code === "SERVE_FAILED") expect(body.detail).toBe("listener already in use");
      /* A press that may have left a mapping behind takes it down again, so
         the tailnet never reaches a Viewer this press stopped gating. */
      if (mode === "hang" || mode === "noverify") {
        expect(stub.calls()).toContain(`serve --https=443 ${PORT} off`);
      }
      /* Nothing is published here: the stub's `off` clears the mapping, so
         the gate and the remembered choice both go back to what they were. */
      expect(body.keyKept).toBe(false);
      expect(gateUntouched()).toBe(true);
      expect(fs.existsSync(flagFile())).toBe(false);
      expect(body.tailnetUrl).toBeNull();
    }, 20_000);
  }

  test("a mapping the press cannot take down keeps the key and the remembered choice", async () => {
    /* `serve --bg` published this port, every `serve … off` is refused and the
       status can no longer be read: the press cannot tell that the mapping is
       gone, so lifting the gate or forgetting the choice would risk leaving
       the next start open to the tailnet. */
    stub.setServeMode("blind");
    const response = await press("enable");
    const body = await response.json() as PhoneActionFailure;
    expect(body.code).toBe("VERIFY_FAILED");
    expect(body.keyKept).toBe(true);
    expect(process.env.LLV_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.existsSync(flagFile())).toBe(true);
  }, 20_000);

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

  test("a mapping that will not go down keeps the gate on, and says the press failed", async () => {
    expect((await press("enable")).status).toBe(200);
    stub.setServeMode("offfails");
    const response = await press("disable");
    expect(response.status).toBe(502);
    expect((await response.json() as PhoneActionFailure).code).toBe("DISABLE_FAILED");
    expect(process.env.LLV_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  }, 20_000);

  test("an off that exits 0 while the mapping stays does not lift the gate", async () => {
    expect((await press("enable")).status).toBe(200);
    stub.setServeMode("offlies");
    const response = await press("disable");
    expect(response.status).toBe(502);
    expect((await response.json() as PhoneActionFailure).code).toBe("DISABLE_FAILED");
    /* The gate is lifted only once nothing answers on this port, the rule the
       enable press follows on its own failure paths. */
    expect(process.env.LLV_TOKEN).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.existsSync(flagFile())).toBe(true);
  }, 20_000);

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

/*
 * A managed Docker install (#2024). The Viewer runs `next start` in a release
 * container on a per-deploy candidate port behind the runtime host, reaches
 * the host's Tailscale through the nsenter shim, and is started with no
 * launcher in front of it.
 */
const CANDIDATE_PORT = 18_965;
const STABLE_PORT = 8898;

function dockerInstall(): void {
  setEnv("LLV_DOCKER_NSENTER_SHIMS", "1");
  setEnv("PORT", String(CANDIDATE_PORT));
}

function writeGateway(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(gatewayFile()), { recursive: true });
  fs.writeFileSync(gatewayFile(), JSON.stringify(config));
}

function rememberChoice(key: string): void {
  fs.mkdirSync(appDir(), { recursive: true });
  fs.writeFileSync(flagFile(), "tailscale\n", { mode: 0o600 });
  fs.writeFileSync(tokenFile(), key, { mode: 0o600 });
}

describe("on a Docker install the phone step drives the host's Tailscale (#2024)", () => {
  test("the Tailscale CLI resolves to the nsenter shim", async () => {
    const shim = path.join(stub.dir, "tailscale");
    setEnv("PATH", stub.emptyDir);
    await expect(detectTailscale({ dockerShim: shim })).rejects.toThrow();
    setEnv("LLV_DOCKER_NSENTER_SHIMS", "1");
    expect(await detectTailscale({ dockerShim: shim })).toBe(shim);
  });

  test("it points the tailnet at the runtime host's stable port, never the release's candidate port", async () => {
    dockerInstall();
    expect((await read()).phone).toMatchObject({ state: "ready", viewerPort: STABLE_PORT });
    expect((await press("enable")).status).toBe(200);
    expect(stub.calls()).toContain(`serve --bg ${STABLE_PORT}`);
    expect(stub.calls().some((call) => call.includes(String(CANDIDATE_PORT)))).toBe(false);
    expect((await read()).phone).toMatchObject({ state: "serving", servingPort: STABLE_PORT });
    expect((await press("disable")).status).toBe(200);
    expect(stub.calls()).toContain(`serve --https=443 ${STABLE_PORT} off`);
  });

  test("the port the runtime host was configured with wins over the default", async () => {
    dockerInstall();
    setEnv("LLV_VIEWER_PORT", "8899");
    expect((await read()).phone?.viewerPort).toBe(8899);
  });

  test("a gateway's remote entry is the one the tailnet reaches", async () => {
    dockerInstall();
    writeGateway({ remoteEntryPort: 8897, localEntry: "trusted" });
    expect((await press("enable")).status).toBe(200);
    expect(stub.calls()).toContain("serve --bg 8897");
    expect((await read()).phone).toMatchObject({ state: "serving", servingPort: 8897 });
  });

  test("a trusted local entry with no remote entry is never published", async () => {
    dockerInstall();
    writeGateway({ localEntry: "trusted" });
    const response = await press("enable");
    expect(response.status).toBe(409);
    expect((await response.json() as PhoneActionFailure).code).toBe("TRUSTED_ENTRY");
    expect(stub.calls().some((call) => call.startsWith("serve --bg"))).toBe(false);
    expect(fs.existsSync(flagFile())).toBe(false);
    expect(gateUntouched()).toBe(true);
  });

  test("a key the container already holds is reused, and turning off keeps it", async () => {
    /* service.env set this key; the runtime host's trusted local entry and the
       MCP clients vouch with it, so the press must not swap it for another. */
    dockerInstall();
    const configured = "c".repeat(32);
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(tokenFile(), "d".repeat(32), { mode: 0o600 });
    setEnv("LLV_TOKEN", configured);

    const response = await press("enable");
    expect(response.status).toBe(200);
    expect((await response.json() as AccessResponse).tailnetUrl).toBe(`https://${STUB_DNS_NAME}/?k=${configured}`);
    expect(process.env.LLV_TOKEN).toBe(configured);
    expect(response.headers.get("set-cookie") ?? "").toContain(`llv_auth=${configured}`);

    expect((await press("disable")).status).toBe(200);
    expect(process.env.LLV_TOKEN).toBe(configured);
    expect(process.env.LLV_TS_URL).toBeUndefined();
    expect(process.env.LLV_TS_HOST).toBeUndefined();
  });
});

describe("a Viewer booting with phone access remembered comes up gated (#2024)", () => {
  const key = "e".repeat(32);
  const unauthenticated = () => proxy(new NextRequest(`http://127.0.0.1:${STABLE_PORT}/`, { headers: { host: `${STUB_DNS_NAME}` } }));

  test("a container restarted under a live mapping gates on the same key file and restores the link", async () => {
    dockerInstall();
    rememberChoice(key);
    stub.setServing(STABLE_PORT);
    /* This is the window the boot closes: a fresh process with no key while
       tailscaled still proxies the tailnet into it. */
    expect((await read()).phone?.state).toBe("exposed");
    expect(unauthenticated().status).toBe(200);

    expect(await restorePhoneAccessGate()).toBe("linked");
    expect(process.env.LLV_TOKEN).toBe(key);
    expect(process.env.LLV_TS_HOST).toBe(STUB_DNS_NAME);
    expect(process.env.LLV_TS_URL).toBe(`https://${STUB_DNS_NAME}/?k=${key}`);
    expect(fs.readFileSync(tokenFile(), "utf8")).toBe(key);
    expect((await read()).phone).toMatchObject({ state: "serving", persisted: true });
    expect(unauthenticated().status).toBe(403);
    expect(proxy(new NextRequest(`http://127.0.0.1:${STABLE_PORT}/?k=${key}`)).status).toBe(307);
    /* The boot only reads Tailscale; it never publishes or takes anything down. */
    expect(stub.calls().some((call) => call.startsWith("serve --") || call.endsWith(" off"))).toBe(false);
  });

  test("the gate goes on even when Tailscale cannot be read, and no link is advertised", async () => {
    dockerInstall();
    rememberChoice(key);
    stub.setStatus(null);
    expect(await restorePhoneAccessGate()).toBe("gated");
    expect(process.env.LLV_TOKEN).toBe(key);
    expect(process.env.LLV_TS_URL).toBeUndefined();
    expect(unauthenticated().status).toBe(403);
  });

  test("a mapping to another port gates without claiming the link", async () => {
    dockerInstall();
    rememberChoice(key);
    stub.setServing(3000);
    expect(await restorePhoneAccessGate()).toBe("gated");
    expect(process.env.LLV_TOKEN).toBe(key);
    expect(process.env.LLV_TS_URL).toBeUndefined();
  });

  test("a key the environment set is kept and carried into the link", async () => {
    dockerInstall();
    rememberChoice(key);
    stub.setServing(STABLE_PORT);
    const configured = "c".repeat(32);
    setEnv("LLV_TOKEN", configured);
    expect(await restorePhoneAccessGate()).toBe("linked");
    expect(process.env.LLV_TOKEN).toBe(configured);
    expect(process.env.LLV_TS_URL).toBe(`https://${STUB_DNS_NAME}/?k=${configured}`);
  });

  test("a key that cannot be put in place refuses the boot, and the step says exposed", async () => {
    dockerInstall();
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(flagFile(), "tailscale\n", { mode: 0o600 });
    fs.mkdirSync(tokenFile(), { recursive: true });
    stub.setServing(STABLE_PORT);
    await expect(restorePhoneAccessGate()).rejects.toBeInstanceOf(PhoneGateRefusal);
    expect(gateUntouched()).toBe(true);
    expect((await read()).phone?.state).toBe("exposed");

    const exits: number[] = [];
    const lines: string[] = [];
    await gatePhoneAccessBeforeServing(((code: number) => { exits.push(code); return undefined as never; }), (line) => { lines.push(line); });
    expect(exits).toEqual([78]);
    expect(lines.join("\n")).toContain("refusing to serve the tailnet ungated");
  });

  test("a flag that exists and cannot be read counts as set", async () => {
    dockerInstall();
    fs.mkdirSync(flagFile(), { recursive: true });
    expect(await restorePhoneAccessGate()).not.toBe("off");
    expect(process.env.LLV_TOKEN).toMatch(/^[0-9a-f]{32}$/);
  });

  test("with nothing remembered the boot touches neither the gate nor Tailscale", async () => {
    dockerInstall();
    stub.setServing(STABLE_PORT);
    expect(await restorePhoneAccessGate()).toBe("off");
    expect(gateUntouched()).toBe(true);
    expect(stub.calls()).toEqual([]);
  });

  test("a plain checkout's launcher start keeps the launcher's gate and link", async () => {
    setEnv("PORT", String(PORT));
    rememberChoice(key);
    setEnv("LLV_TOKEN", key);
    setEnv("LLV_TS_URL", `https://${STUB_DNS_NAME}/?k=${key}`);
    expect(await restorePhoneAccessGate()).toBe("linked");
    expect(stub.calls()).toEqual([]);
  });
});
