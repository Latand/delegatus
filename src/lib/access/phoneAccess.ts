import fs from "node:fs";

import {
  clearPhoneAccessFlag,
  detectTailscale,
  getToken,
  OPERATOR_PATTERN,
  phoneAccessFlagPath,
  readTailscaleState,
  serveBackground,
  serveOff,
  serveStatus,
  writePhoneAccessFlag,
} from "../../../bin/tailscale.mjs";

/**
 * One-button phone access (#1876 slice 3, design §2.3).
 *
 * Every part of the access gate is read per request — `LLV_TOKEN` in the
 * proxy, `LLV_TS_HOST` in the same-origin check, `LLV_TS_URL` in `/api/access`
 * — so the serving Viewer turns phone access on by publishing itself with
 * Tailscale's background serve and then writing those three into its own
 * environment. Nothing restarts: a Viewer that exits ends the launcher too.
 * The choice is remembered in the `phone-access` flag file the launcher reads.
 *
 * Every Tailscale call goes through `bin/tailscale.mjs` with argv only.
 */

export type PhoneState = "missing" | "needs-login" | "no-dns" | "ready" | "serving-other" | "serving";

export type PhoneAccess = {
  state: PhoneState;
  dnsName: string | null;
  viewerPort: number;
  /** The local port the tailnet's HTTPS root proxies to, when one is published. */
  servingPort: number | null;
  /** The flag file exists: phone access comes back on the next start. */
  persisted: boolean;
};

export type PhoneFailureCode =
  | "OPERATOR_RIGHTS"
  | "SERVE_FAILED"
  | "VERIFY_FAILED"
  | "TIMEOUT"
  | "TOKEN_WRITE_FAILED"
  | "PERSIST_FAILED"
  | "STATUS_UNREADABLE"
  | "NOT_READY"
  | "DISABLE_FAILED";

export type PhoneRead = { phone: PhoneAccess | null; error: "STATUS_UNREADABLE" | null };

export type PhoneOutcome =
  | { ok: true; token: string | null; read: PhoneRead }
  | { ok: false; code: PhoneFailureCode; detail: string; read: PhoneRead };

/** `GET /api/access`, and the body of every phone-action reply. */
export interface AccessResponse {
  /** Tailnet URL with the `?k=` access token, or null while phone access is off. */
  tailnetUrl: string | null;
  /** What the setup guide's phone step shows; null with `phoneError`. */
  phone: PhoneAccess | null;
  phoneError: "STATUS_UNREADABLE" | null;
}

export type PhoneActionFailure = AccessResponse & { error: string; code: PhoneFailureCode; detail: string };

export function currentTailnetUrl(): string | null {
  const tailnetUrl = process.env.LLV_TS_URL;
  return tailnetUrl && tailnetUrl.length > 0 ? tailnetUrl : null;
}

const STATUS_BOUND_MS = 3_000;
const SERVE_BOUND_MS = 10_000;
const PRESS_BOUND_MS = 15_000;

/* Named through a helper: the three are credentials, and the process
   environment is the one place they are meant to live. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function lastLine(text: string): string {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The port the serving Viewer answers on: the launcher's `PORT`, else the
    port the request arrived on. */
export function viewerPortFor(requestUrl: string): number {
  const fromEnv = Number(process.env.PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  try {
    const url = new URL(requestUrl);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 ? port : 3000;
  } catch {
    return 3000;
  }
}

function flagPresent(): boolean {
  try {
    return fs.readFileSync(phoneAccessFlagPath(), "utf8").trim() === "tailscale";
  } catch {
    return false;
  }
}

/** The launcher hands the Viewer its bind as `HOSTNAME`; anything but a
    loopback name counts as a wider bind. */
function loopbackBind(): boolean {
  const host = process.env.HOSTNAME;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Whether this process currently gates on the tailnet link. */
function processServesTailnet(): boolean {
  return Boolean(process.env.LLV_TOKEN && process.env.LLV_TS_URL);
}

async function resolveBinary(): Promise<string | null> {
  try {
    return await detectTailscale();
  } catch {
    return null;
  }
}

/** Read the state the phone step shows. Never throws. */
export async function readPhoneAccess(viewerPort: number): Promise<PhoneRead> {
  const persisted = flagPresent();
  const base = { dnsName: null, viewerPort, servingPort: null, persisted };
  const binary = await resolveBinary();
  if (!binary) return { phone: { ...base, state: "missing" }, error: null };
  let status: { backendState: string; dnsName: string };
  try {
    status = await readTailscaleState(binary, { timeoutMs: STATUS_BOUND_MS });
  } catch {
    return { phone: null, error: "STATUS_UNREADABLE" };
  }
  if (status.backendState !== "Running") return { phone: { ...base, state: "needs-login" }, error: null };
  if (!status.dnsName) return { phone: { ...base, state: "no-dns" }, error: null };
  let served: { published: boolean; port: number | null };
  try {
    served = await serveStatus(binary, { timeoutMs: STATUS_BOUND_MS });
  } catch {
    return { phone: null, error: "STATUS_UNREADABLE" };
  }
  const withDns = { ...base, dnsName: status.dnsName, servingPort: served.port };
  if (!served.published) return { phone: { ...withDns, state: "ready" }, error: null };
  if (served.port !== viewerPort) return { phone: { ...withDns, state: "serving-other" }, error: null };
  /* A background mapping an earlier run left points here, and this process
     does not gate on the key yet: one press re-binds it. */
  return { phone: { ...withDns, state: processServesTailnet() ? "serving" : "ready" }, error: null };
}

/**
 * The one press: persist, token, publish, verify, re-bind. It stops at the
 * first failure; the process environment is only written after a verified
 * publish, and a flag file this press created is taken back on failure, so a
 * failed press never changes how the next start behaves.
 */
export async function enablePhoneAccess(viewerPort: number): Promise<PhoneOutcome> {
  const deadline = Date.now() + PRESS_BOUND_MS;
  const remaining = (bound: number) => Math.max(1, Math.min(bound, deadline - Date.now()));
  const before = await readPhoneAccess(viewerPort);
  const fail = async (code: PhoneFailureCode, detail: string): Promise<PhoneOutcome> => ({ ok: false, code, detail, read: await readPhoneAccess(viewerPort) });
  if (before.error || !before.phone) return { ok: false, code: "STATUS_UNREADABLE", detail: "", read: before };
  const { phone } = before;
  if (phone.state === "missing" || phone.state === "needs-login" || phone.state === "no-dns" || !phone.dnsName) {
    return { ok: false, code: "NOT_READY", detail: phone.state, read: before };
  }
  const binary = await resolveBinary();
  if (!binary) return fail("NOT_READY", "missing");

  const flagExisted = phone.persisted;
  const rollbackFlag = async () => {
    if (!flagExisted) await clearPhoneAccessFlag().catch(() => {});
  };
  try {
    await writePhoneAccessFlag();
  } catch (error) {
    return fail("PERSIST_FAILED", errorText(error));
  }

  let token: string;
  try {
    token = (await getToken()).token;
  } catch (error) {
    await rollbackFlag();
    return fail("TOKEN_WRITE_FAILED", errorText(error));
  }

  const published = await serveBackground(binary, viewerPort, { timeoutMs: remaining(SERVE_BOUND_MS) });
  if (published.timedOut) {
    await rollbackFlag();
    return fail("TIMEOUT", "");
  }
  if (published.code !== 0) {
    await rollbackFlag();
    if (OPERATOR_PATTERN.test(published.stderr)) return fail("OPERATOR_RIGHTS", lastLine(published.stderr));
    return fail("SERVE_FAILED", lastLine(published.stderr) || `exit ${published.code ?? "?"}`);
  }

  let verified: { published: boolean; port: number | null };
  try {
    verified = await serveStatus(binary, { timeoutMs: remaining(STATUS_BOUND_MS) });
  } catch (error) {
    await rollbackFlag();
    return fail("VERIFY_FAILED", errorText(error));
  }
  if (!verified.published || verified.port !== viewerPort) {
    await rollbackFlag();
    return fail("VERIFY_FAILED", verified.published ? `published port ${verified.port ?? "?"}` : "nothing published");
  }

  setEnv("LLV_TOKEN", token);
  setEnv("LLV_TS_HOST", phone.dnsName);
  setEnv("LLV_TS_URL", `https://${phone.dnsName}/?k=${token}`);
  return { ok: true, token, read: await readPhoneAccess(viewerPort) };
}

/**
 * Turn phone access off: take the mapping down first, and only once that
 * worked forget the choice and lift the gate. The token file stays, so a
 * later enable hands out the same link.
 */
export async function disablePhoneAccess(viewerPort: number): Promise<PhoneOutcome> {
  const binary = await resolveBinary();
  if (binary) {
    let served: { published: boolean; port: number | null } | null = null;
    try {
      served = await serveStatus(binary, { timeoutMs: STATUS_BOUND_MS });
    } catch {
      served = null;
    }
    if (served === null || (served.published && served.port === viewerPort)) {
      const off = await serveOff(binary, viewerPort, { timeoutMs: SERVE_BOUND_MS });
      if (off.timedOut || off.code !== 0) {
        return { ok: false, code: "DISABLE_FAILED", detail: off.timedOut ? "timeout" : lastLine(off.stderr) || `exit ${off.code ?? "?"}`, read: await readPhoneAccess(viewerPort) };
      }
    }
  }
  try {
    await clearPhoneAccessFlag();
  } catch (error) {
    return { ok: false, code: "DISABLE_FAILED", detail: errorText(error), read: await readPhoneAccess(viewerPort) };
  }
  /* A Viewer bound beyond loopback keeps its key: the launcher set it for
     that bind, and lifting it would open the server to the network. */
  if (loopbackBind()) setEnv("LLV_TOKEN", undefined);
  setEnv("LLV_TS_HOST", undefined);
  setEnv("LLV_TS_URL", undefined);
  return { ok: true, token: null, read: await readPhoneAccess(viewerPort) };
}
