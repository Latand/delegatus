import path from "node:path";
import { AGENT_NAME, SERVICE_NAME, launchdDisabled, serviceCommand } from "./service-manager.mjs";

/** Read only manager state; raw output and paths never enter the report.
 * @param {import('../src/lib/doctor/contracts').DoctorHost} host
 * @param {AbortSignal} signal
 * @param {typeof serviceCommand} [run]
 * @returns {Promise<[import('../src/lib/doctor/contracts').CapabilityState, import('../src/lib/doctor/contracts').ReasonCode]>}
 */
export async function inspectLoginService(host, signal, run = serviceCommand) {
  const unavailable = () => /** @type {const} */ (["unknown", "SERVICE_UNAVAILABLE"]);
  if (!["linux", "darwin"].includes(host.platform) || host.env.LLV_DOCKER_NSENTER_SHIMS === "1") return [...unavailable()];
  for (const file of ["/.dockerenv", "/run/.containerenv"]) {
    if (await host.inspect(file, "file", signal) !== "absent") return [...unavailable()];
    signal.throwIfAborted();
  }
  const call = async (command, args) => {
    signal.throwIfAborted();
    try { return await run(command, args, { env: host.env, signal }); }
    catch (error) { if (signal.aborted) throw signal.reason; if (error.code === "ENOENT") return null; throw error; }
  };
  if (host.platform === "linux") {
    const result = await call("systemctl", ["--user", "show", SERVICE_NAME, "--property=LoadState,UnitFileState,ActiveState,SubState,NRestarts"]);
    if (!result) return [...unavailable()];
    const fields = Object.fromEntries(result.stdout.trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
    if (fields.LoadState === "not-found") return ["degraded", "SERVICE_NOT_INSTALLED"];
    if (result.code !== 0) return [...unavailable()];
    if (fields.LoadState !== "loaded") return [...unavailable()];
    if (fields.ActiveState === "failed") return ["degraded", "SERVICE_FAILED"];
    if (fields.SubState === "auto-restart" || fields.ActiveState === "activating") return ["degraded", "SERVICE_RESTARTING"];
    if (fields.UnitFileState !== "enabled") return ["degraded", "SERVICE_DISABLED"];
    if (fields.ActiveState === "active") return ["available", "SERVICE_RUNNING"];
    if (fields.ActiveState === "inactive" || fields.ActiveState === "deactivating") return ["degraded", "SERVICE_NOT_RUNNING"];
    return [...unavailable()];
  }
  const file = path.join(host.home, "Library", "LaunchAgents", `${AGENT_NAME}.plist`);
  const present = await host.inspect(file, "credential", signal);
  signal.throwIfAborted();
  if (present === "absent") return ["degraded", "SERVICE_NOT_INSTALLED"];
  if (present !== "present") return [...unavailable()];
  const domain = `gui/${process.getuid?.() ?? -1}`;
  const overrides = await call("launchctl", ["print-disabled", domain]);
  if (!overrides || overrides.code !== 0) return [...unavailable()];
  const disabled = launchdDisabled(overrides.stdout);
  if (disabled === null) return [...unavailable()];
  if (disabled) return ["degraded", "SERVICE_DISABLED"];
  const shown = await call("launchctl", ["print", `${domain}/${AGENT_NAME}`]);
  if (!shown) return [...unavailable()];
  if (shown.code !== 0) return ["degraded", "SERVICE_NOT_RUNNING"];
  const listed = await call("launchctl", ["list", AGENT_NAME]);
  if (!listed || listed.code !== 0) return [...unavailable()];
  const pid = listed.stdout.match(/"PID"\s*=\s*(\d+)\s*;/);
  const exit = listed.stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)\s*;/);
  if (pid && Number(pid[1]) > 0) return ["available", "SERVICE_RUNNING"];
  if (exit) return ["degraded", Number(exit[1]) === 0 ? "SERVICE_NOT_RUNNING" : "SERVICE_RESTARTING"];
  return [...unavailable()];
}
