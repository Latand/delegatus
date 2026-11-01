import { createVerify, generateKeyPairSync } from "node:crypto";
import { appConnect, FORGE_APP_PERMISSIONS } from "../../../bin/forge-app-token.mjs";
import type { AppConnectDiscovery, AppPermissions } from "./appConnectTypes";

/** Invented GitHub identities; the key is generated per fixture. */
export const CONNECT_SOURCE = "example-owner/example-repo";
export const CONNECT_TARGET = "other-owner/other-repo";
export const CONNECT_NOW = Date.parse("2030-01-01T00:00:00Z");
export function fakeAppConnection(targetRepository = CONNECT_TARGET) {
  const targetOwner = targetRepository.split("/")[0]!;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const appId = 1, sourceAccount = 2, targetAccount = 3, sourceInstallation = 4, targetInstallation = 5;
  const items = new Map([[CONNECT_SOURCE, JSON.stringify({ id: appId, pem, installation_id: sourceInstallation })]]);
  let permissions: AppPermissions = { ...FORGE_APP_PERMISSIONS };
  let registrationPermissions: AppPermissions = { ...permissions };
  let installed = false, covered = false, privateApp = false, pending = false, broadToken = false, unreachable = false, storeRefused = false;
  let suspended = false;
  const calls: Array<{ method: string; target: string; body?: unknown }> = [];
  const audit: unknown[] = [];
  const installation = (source: boolean) => ({ id: source ? sourceInstallation : targetInstallation, app_id: appId,
    account: { id: source ? sourceAccount : targetAccount, login: source ? "example-owner" : targetOwner },
    suspended_at: suspended ? "2030-01-01T00:00:00Z" : null,
    html_url: `https://github.com/settings/installations/${source ? sourceInstallation : targetInstallation}`, permissions });
  let tokenRepository = targetRepository;
  const ports = {
    now: () => CONNECT_NOW,
    readCredential: async (repository: string) => items.get(repository) ?? null,
    storeCredential: async (repository: string, value: string) => { if (storeRefused) throw new Error("credential_store_refused"); items.set(repository, value); },
    audit: async (record: unknown) => { audit.push(record); },
    stderr: () => {},
    request: async (method: string, target: string, options: { token?: string; body?: { permissions?: AppPermissions; repositories?: string[] } } = {}) => {
      calls.push({ method, target, ...(options.body ? { body: options.body } : {}) });
      if (unreachable) return { status: 503, body: { message: pem } };
      if (options.token?.includes(".")) {
        const [head, payload, signature] = options.token.split(".");
        const verify = createVerify("RSA-SHA256");
        verify.update(`${head}.${payload}`);
        if (!verify.verify(publicKey, signature!, "base64url") || JSON.parse(Buffer.from(payload!, "base64url").toString()).iss !== String(appId)) throw new Error("invalid JWT");
      }
      if (target === "app") return { status: 200, body: { id: appId, slug: "example-app", owner: { id: sourceAccount, login: "example-owner", type: "User" }, permissions: registrationPermissions } };
      if (target.startsWith("users/") && !target.endsWith("/installation")) return { status: 200, body: { id: target === `users/${targetOwner}` ? targetAccount : sourceAccount, login: target.slice(6), type: "User" } };
      if (target === "apps/example-app") return { status: privateApp ? 404 : 200, body: {} };
      if (target === `repos/${CONNECT_SOURCE}/installation`) return { status: 200, body: installation(true) };
      if (target === `repos/${targetRepository}/installation`) return { status: covered ? 200 : 404, body: covered ? installation(false) : null };
      if (target === `users/${targetOwner}/installation`) return { status: installed ? 200 : 404, body: installed ? installation(false) : null };
      if (target.startsWith("app/installation-requests?")) return { status: 200, body: pending ? [{ account: { id: targetAccount } }] : [] };
      if (method === "POST" && target.endsWith("/access_tokens")) {
        tokenRepository = target.includes(`/${sourceInstallation}/`) ? CONNECT_SOURCE : targetRepository;
        return { status: 201, body: { "token": "fixture-issued", expires_at: "2030-01-01T01:00:00Z", permissions: options.body?.permissions } };
      }
      if (target.startsWith("installation/repositories?")) return { status: 200, body: { total_count: broadToken ? 2 : 1,
        repositories: broadToken ? [{ full_name: CONNECT_SOURCE }, { full_name: targetRepository }] : [{ full_name: tokenRepository }] } };
      if (method === "DELETE" && target === "installation/token") return { status: 204, body: null };
      return { status: 404, body: null };
    },
  };
  return { ports, items, calls, audit, pem, targetInstallation, sourceInstallation,
    set(value: Partial<{ installed: boolean; covered: boolean; privateApp: boolean; pending: boolean; broadToken: boolean; unreachable: boolean; storeRefused: boolean; suspended: boolean; permissions: AppPermissions; registrationPermissions: AppPermissions }>) {
      if (value.installed !== undefined) installed = value.installed;
      if (value.covered !== undefined) covered = value.covered;
      if (value.privateApp !== undefined) privateApp = value.privateApp;
      if (value.pending !== undefined) pending = value.pending;
      if (value.broadToken !== undefined) broadToken = value.broadToken;
      if (value.unreachable !== undefined) unreachable = value.unreachable;
      if (value.storeRefused !== undefined) storeRefused = value.storeRefused;
      if (value.suspended !== undefined) suspended = value.suspended;
      if (value.permissions) permissions = value.permissions;
      if (value.registrationPermissions) registrationPermissions = value.registrationPermissions;
    },
    discover: async (repository: string, options: { permissions: AppPermissions; context?: AppConnectDiscovery["context"]; store?: number }) =>
      await appConnect(repository, [CONNECT_SOURCE], ports, options) as AppConnectDiscovery,
  };
}
