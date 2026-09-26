import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Viewer's internal service tag, in one place for both sides of the wire
 * (docs/design/sign-in-and-team.md §4.2). A first-party process names itself
 * with `x-llv-internal-service: <service>.<tag>`, where the tag is an HMAC of
 * the service name under the operator spawn capability kept in the state
 * directory. Only a process that can read that file can mint one, and the
 * Viewer and the identity gate check it the same way.
 *
 * Plain ESM with node builtins only, so the launcher (`bin/cli.mjs`, whose
 * self-update probe needs it) and the TypeScript sources share one
 * definition.
 */

export const INTERNAL_SERVICE_HEADER = "x-llv-internal-service";
export const OPERATOR_SPAWN_CAPABILITY_FILE = "operator-spawn-capability";
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** @param {string} key @param {string} service @returns {string} */
export function internalServiceTagFor(key, service) {
  return createHmac("sha256", key).update(`llv-internal-service-v1\0${service}`).digest("hex");
}

/**
 * The header a readiness probe carries, minted from the key already in
 * `stateDirectory`, or no header when there is no key to mint from. It never
 * creates the key: the Viewer does that at startup, and a Viewer that has not
 * made one has no team to be let past either.
 *
 * @param {string} stateDirectory
 * @returns {Record<string, string>}
 */
export function probeHeadersFrom(stateDirectory) {
  let key = "";
  try {
    key = readFileSync(join(stateDirectory, OPERATOR_SPAWN_CAPABILITY_FILE), "utf8").trim();
  } catch {
    return {};
  }
  if (!CAPABILITY_PATTERN.test(key)) return {};
  return { [INTERNAL_SERVICE_HEADER]: `probe.${internalServiceTagFor(key, "probe")}` };
}
