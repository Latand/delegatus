import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { readViewerGatewayConfig, VIEWER_GATEWAY_FILE } from "@/runtime-host/deploymentProxy";

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
 *
 * A managed Docker install (#2024) differs in three places. Its Viewer runs
 * `next start` in a release container on a per-deploy candidate port behind
 * the runtime host, so the tailnet is pointed at the runtime host's stable
 * entry, which outlives every deploy. Its key may come from `service.env`,
 * which the runtime host's trusted local entry and the MCP clients vouch
 * with, so the press reuses a key the container already holds. And nothing
 * like the launcher runs before it, so `restorePhoneAccessGate` puts the gate
 * back at boot when the choice is remembered.
 */

/* `exposed`: a background mapping points at this Viewer's port while this
   process does not gate on the key. The mapping belongs to tailscaled and
   survives this process, so the tailnet can reach an ungated Viewer until one
   press re-binds it (or Turn off takes the mapping down). */
export type PhoneState = "missing" | "needs-login" | "no-dns" | "ready" | "serving-other" | "serving" | "exposed";

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
  | "TRUSTED_ENTRY"
  | "DISABLE_FAILED";

export type PhoneRead = { phone: PhoneAccess | null; error: "STATUS_UNREADABLE" | null };

export type PhoneOutcome =
  | { ok: true; token: string | null; read: PhoneRead }
  | { ok: false; code: PhoneFailureCode; detail: string; keyKept: boolean; read: PhoneRead };

/** `GET /api/access`, and the body of every phone-action reply. */
export interface AccessResponse {
  /** Tailnet URL with the `?k=` access token, or null while phone access is off. */
  tailnetUrl: string | null;
  /** What the setup guide's phone step shows; null with `phoneError`. */
  phone: PhoneAccess | null;
  phoneError: "STATUS_UNREADABLE" | null;
}

export type PhoneActionFailure = AccessResponse & { error: string; code: PhoneFailureCode; detail: string; /** The failed press left the access key on, because something may still be published. */ keyKept: boolean };

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

/** Tailscale's last stderr line, fitted to sit inside a sentence: its own
    "error:" prefix and closing period dropped, since the sentence has both. */
function lastLine(text: string): string {
  const lines = text.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? "").replace(/^error:\s*/i, "").replace(/\.+$/, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A managed Docker install: the compose file sets this for every Viewer
    container, and the host CLIs (Tailscale's among them) are nsenter shims. */
function dockerManaged(): boolean {
  return process.env.LLV_DOCKER_NSENTER_SHIMS === "1";
}

const STABLE_VIEWER_PORT = 8898;

/**
 * Where the tailnet is pointed on a Docker install, read the way the runtime
 * host reads it (`src/runtime-host/main.ts`): the gateway's remote entry when
 * one is configured, else the stable port. The candidate port in `PORT`
 * changes with every deploy and would leave the mapping behind on a retired
 * release. `publishable` is false when the stable port is a TRUSTED local
 * entry with no remote entry beside it: that listener vouches for
 * loopback-addressed requests with the release's key, and the press never
 * points the tailnet at it.
 */
function dockerTailnetEntry(): { port: number; publishable: boolean } {
  const configured = Number(process.env.LLV_VIEWER_PORT);
  const stable = Number.isInteger(configured) && configured > 0 ? configured : STABLE_VIEWER_PORT;
  const gateway = readViewerGatewayConfig(statePath(VIEWER_GATEWAY_FILE), stable);
  /* A file the runtime host cannot read leaves the stable port the plain pipe. */
  if (gateway.problem) return { port: stable, publishable: true };
  if (gateway.config.remoteEntryPort !== null) return { port: gateway.config.remoteEntryPort, publishable: true };
  return { port: stable, publishable: gateway.config.localEntry !== "trusted" };
}

/** The port the tailnet reaches this Viewer on: on a Docker install the
    runtime host's entry, otherwise the launcher's `PORT`, else the port the
    request arrived on. */
export function viewerPortFor(requestUrl: string): number {
  if (dockerManaged()) return dockerTailnetEntry().port;
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

/** The boot's reading of the choice: a flag that exists and cannot be read
    counts as set, because the mapping it stands for may be live. */
function flagMayBeSet(): boolean {
  try {
    return fs.readFileSync(phoneAccessFlagPath(), "utf8").trim() === "tailscale";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function tailnetLink(dnsName: string, token: string): string {
  return `https://${dnsName}/?k=${encodeURIComponent(token)}`;
}

/** The launcher hands the Viewer its bind as `HOSTNAME`; anything but a
    loopback name counts as a wider bind. */
function loopbackBind(): boolean {
  const host = process.env.HOSTNAME;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Whether this process asks every connection for the key. The link is a
    separate fact: a local fallback start and a non-loopback bind gate without
    one, and a gated Viewer is not an exposed one. */
function processGates(): boolean {
  return Boolean(process.env.LLV_TOKEN);
}

/** Whether this process gates AND holds the tailnet link to hand out. */
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
  /* A mapping points here. With the link, this is the serving state. Gating
     without the link (the launcher's local fallback, a non-loopback bind) is
     `ready`: the press has a re-bind to do, and nothing about it is open.
     Only an ungated process is `exposed`. */
  if (processServesTailnet()) return { phone: { ...withDns, state: "serving" }, error: null };
  return { phone: { ...withDns, state: processGates() ? "ready" : "exposed" }, error: null };
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
  const fail = async (code: PhoneFailureCode, detail: string, keyKept = false): Promise<PhoneOutcome> => ({ ok: false, code, detail, keyKept, read: await readPhoneAccess(viewerPort) });
  if (before.error || !before.phone) return { ok: false, code: "STATUS_UNREADABLE", detail: "", keyKept: false, read: before };
  const { phone } = before;
  if (phone.state === "missing" || phone.state === "needs-login" || phone.state === "no-dns" || !phone.dnsName) {
    return { ok: false, code: "NOT_READY", detail: phone.state, keyKept: false, read: before };
  }
  if (dockerManaged() && !dockerTailnetEntry().publishable) {
    return { ok: false, code: "TRUSTED_ENTRY", detail: "", keyKept: false, read: before };
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

  /* A Docker container that already gates keeps its key: `service.env` set
     it, and the runtime host's trusted local entry and the MCP clients vouch
     with that same key, so swapping it would lock them out until the next
     deploy put the old one back. */
  const configuredToken = dockerManaged() ? process.env.LLV_TOKEN : undefined;
  let token: string;
  try {
    token = configuredToken || (await getToken()).token;
  } catch (error) {
    await rollbackFlag();
    return fail("TOKEN_WRITE_FAILED", errorText(error));
  }

  /* The gate goes on BEFORE the publish, never after it. `serve --bg` hands
     the mapping to tailscaled, which can have applied it before the command
     answers — and after a timeout it answers nothing at all. A gate written
     only on the happy path leaves exactly that window, and the whole failure
     of it, open to the tailnet. */
  const priorToken = process.env.LLV_TOKEN;
  setEnv("LLV_TOKEN", token);
  /* After a publish that may have taken: take the mapping down again, and lift
     the gate only once nothing answers on this port. A status that cannot be
     read keeps the gate, because an unknown mapping is a published one. */
  const settle = async (): Promise<boolean> => {
    await serveOff(binary, viewerPort, { timeoutMs: remaining(SERVE_BOUND_MS) }).catch(() => {});
    let after: { published: boolean; port: number | null };
    try {
      after = await serveStatus(binary, { timeoutMs: remaining(STATUS_BOUND_MS) });
    } catch {
      return true;
    }
    const stillPublished = after.published && after.port === viewerPort;
    if (!stillPublished) setEnv("LLV_TOKEN", priorToken);
    return stillPublished;
  };

  /* The flag is the gate for the NEXT start, so it follows the same rule as
     this process's own: it is taken back only once nothing is published to
     this port. A mapping that outlived a failed press would otherwise meet a
     launcher that starts on loopback with no key at all. */
  const giveUp = async (code: PhoneFailureCode, detail: string): Promise<PhoneOutcome> => {
    const kept = await settle();
    if (!kept) await rollbackFlag();
    return fail(code, detail, kept);
  };

  const published = await serveBackground(binary, viewerPort, { timeoutMs: remaining(SERVE_BOUND_MS) });
  if (published.timedOut) return giveUp("TIMEOUT", "");
  if (published.code !== 0) {
    if (OPERATOR_PATTERN.test(published.stderr)) return giveUp("OPERATOR_RIGHTS", lastLine(published.stderr));
    return giveUp("SERVE_FAILED", lastLine(published.stderr) || `exit ${published.code ?? "?"}`);
  }

  let verified: { published: boolean; port: number | null };
  try {
    verified = await serveStatus(binary, { timeoutMs: remaining(STATUS_BOUND_MS) });
  } catch (error) {
    return giveUp("VERIFY_FAILED", errorText(error));
  }
  if (!verified.published || verified.port !== viewerPort) {
    return giveUp("VERIFY_FAILED", verified.published ? `published port ${verified.port ?? "?"}` : "nothing published");
  }


  setEnv("LLV_TS_HOST", phone.dnsName);
  setEnv("LLV_TS_URL", tailnetLink(phone.dnsName, token));
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
        return { ok: false, code: "DISABLE_FAILED", detail: off.timedOut ? "timeout" : lastLine(off.stderr) || `exit ${off.code ?? "?"}`, keyKept: true, read: await readPhoneAccess(viewerPort) };
      }
      /* The exit code is what `off` says; the status is what tailscaled has.
         The gate below is lifted only once nothing answers on this port —
         the same rule a failed enable follows. */
      let after: { published: boolean; port: number | null };
      try {
        after = await serveStatus(binary, { timeoutMs: STATUS_BOUND_MS });
      } catch (error) {
        return { ok: false, code: "DISABLE_FAILED", detail: errorText(error), keyKept: true, read: await readPhoneAccess(viewerPort) };
      }
      if (after.published && after.port === viewerPort) {
        return { ok: false, code: "DISABLE_FAILED", detail: `still published on ${viewerPort}`, keyKept: true, read: await readPhoneAccess(viewerPort) };
      }
    }
  }
  try {
    await clearPhoneAccessFlag();
  } catch (error) {
    return { ok: false, code: "DISABLE_FAILED", detail: errorText(error), keyKept: true, read: await readPhoneAccess(viewerPort) };
  }
  /* A Viewer bound beyond loopback keeps its key: the launcher set it for
     that bind, and lifting it would open the server to the network. A Docker
     container keeps its key too: `service.env` may have set it for every
     connection, and one the press set is gone at the container's next start. */
  if (loopbackBind() && !dockerManaged()) setEnv("LLV_TOKEN", undefined);
  setEnv("LLV_TS_HOST", undefined);
  setEnv("LLV_TS_URL", undefined);
  return { ok: true, token: null, read: await readPhoneAccess(viewerPort) };
}

/** The remembered choice is set and the key cannot be put in place: the
    Viewer must not start, because the mapping may be live. */
export class PhoneGateRefusal extends Error {}

/** The port a booting Viewer is reached on from the tailnet, when it knows. */
function bootTailnetPort(): number | null {
  if (dockerManaged()) return dockerTailnetEntry().port;
  const fromEnv = Number(process.env.PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

/**
 * Viewer boot, before the first request (#2024): with the phone-access choice
 * remembered, this process gates on the key, whoever started it. The launcher
 * already hands the key over; a Docker release container, a container
 * restart and every deploy start `next start` with no launcher at all, while
 * the `serve --bg` mapping stays live in tailscaled the whole time.
 *
 * The gate comes first and does not depend on Tailscale answering: a key the
 * environment set is kept, otherwise the key file is read (or minted). A key
 * that cannot be put in place throws `PhoneGateRefusal`, and the caller stops
 * the process rather than serve the tailnet ungated. The link comes second,
 * best effort: it is set only when Tailscale runs and the mapping points at
 * this Viewer, so nothing advertises an address this start does not serve.
 */
export async function restorePhoneAccessGate(): Promise<"off" | "gated" | "linked"> {
  if (!flagMayBeSet()) return "off";
  if (!processGates()) {
    try {
      setEnv("LLV_TOKEN", (await getToken()).token);
    } catch (error) {
      throw new PhoneGateRefusal(errorText(error));
    }
  }
  if (currentTailnetUrl()) return "linked";
  const port = bootTailnetPort();
  const binary = port === null ? null : await resolveBinary();
  if (!binary) return "gated";
  try {
    const status = await readTailscaleState(binary, { timeoutMs: STATUS_BOUND_MS });
    if (status.backendState !== "Running" || !status.dnsName) return "gated";
    const served = await serveStatus(binary, { timeoutMs: STATUS_BOUND_MS });
    if (!served.published || served.port !== port) return "gated";
    setEnv("LLV_TS_HOST", status.dnsName);
    setEnv("LLV_TS_URL", tailnetLink(status.dnsName, process.env.LLV_TOKEN ?? ""));
    return "linked";
  } catch {
    return "gated";
  }
}
