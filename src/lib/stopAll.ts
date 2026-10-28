/* The app menu's «Stop Delegatus»: the same stop as `delegatus stop --all`
   (bin/stop-all.mjs), started from the Viewer it is about to stop.

   The stop has to outlive this process, so it starts detached, in a process
   group of its own: the launcher retires the Viewer's own group when the
   Viewer exits, and that would end the stop halfway. Its report goes to
   `stop-all.log` in the state directory, since the page that asked stops
   answering before the stop finishes.

   Operator only, as a restart is (src/lib/selfUpdate/routes.ts), and on a
   team install the owner only: it stops every member's agents. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import { stateDir, statePath } from "@/lib/configDir";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { detectMode, productionModePorts } from "@/lib/selfUpdate/mode";
import { requireOwner } from "@/lib/team/http";
import { existingTeamStore } from "@/lib/team/store";

export type StopAllRefusal = "confirm-required" | "no-launcher" | "unavailable" | "failed";

export interface StopAllPorts {
  /** The install of the launcher this Viewer runs under, or null without one. */
  launcher(): Promise<{ installRoot: string | null } | null>;
  stateDirectory: string;
  /** The Bun that runs this Viewer, or null when it runs under something else. */
  runtime: string | null;
  cwd: string;
  exists(file: string): boolean;
  openLog(): number;
  start(command: string, args: string[], log: number): { pid?: number };
}

export function productionStopAllPorts(): StopAllPorts {
  return {
    async launcher() {
      const decision = await detectMode(productionModePorts(null));
      return decision.record ? { installRoot: decision.record.installRoot ?? decision.record.checkout ?? null } : null;
    },
    stateDirectory: stateDir(),
    runtime: process.versions.bun ? process.execPath : null,
    cwd: process.cwd(),
    exists: (file) => fs.existsSync(file),
    openLog: () => fs.openSync(statePath("stop-all.log"), "w", 0o600),
    start(command, args, log) {
      const child = spawn(command, args, { detached: true, stdio: ["ignore", log, log], env: process.env });
      child.unref();
      return { pid: child.pid };
    },
  };
}

type Started = { ok: true; pid: number | null } | { ok: false; status: number; code: StopAllRefusal; error: string };

/** Starts the stop; never waits for it. */
export async function startStopAll(lang: "en" | "uk", ports: StopAllPorts): Promise<Started> {
  const launcher = await ports.launcher();
  if (!launcher) {
    return { ok: false, status: 409, code: "no-launcher", error: "This Viewer was not started by the delegatus command; stop it where it was started" };
  }
  /* The release this Viewer serves carries its own copy; an install that
     predates the command has none. */
  const script = [path.join(ports.cwd, "bin", "stop-all.mjs"), ...(launcher.installRoot ? [path.join(launcher.installRoot, "bin", "stop-all.mjs")] : [])]
    .find((candidate) => ports.exists(candidate));
  if (!script || !ports.runtime) {
    return { ok: false, status: 409, code: "unavailable", error: "This install has no stop command; run delegatus stop --all from a newer release" };
  }
  let log: number;
  try { log = ports.openLog(); }
  catch { return { ok: false, status: 500, code: "failed", error: "The stop report could not be opened" }; }
  try {
    const child = ports.start(ports.runtime, [script, "--state-dir", ports.stateDirectory, "--lang", lang], log);
    return { ok: true, pid: child.pid ?? null };
  } catch {
    return { ok: false, status: 500, code: "failed", error: "The stop could not be started" };
  } finally {
    try { fs.closeSync(log); } catch { /* the child holds its own copy */ }
  }
}

export async function postStopAll(request: NextRequest, ports: StopAllPorts = productionStopAllPorts()): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const operator = requireOperatorAuthority(request);
  if (!operator.ok) return NextResponse.json({ error: operator.error }, { status: operator.status });
  if (existingTeamStore()?.hasActiveOwner()) {
    const owner = requireOwner(request);
    if (owner instanceof NextResponse) return owner;
  }
  let input: Record<string, unknown> = {};
  try {
    const parsed = await request.json() as unknown;
    if (parsed && typeof parsed === "object") input = parsed as Record<string, unknown>;
  } catch { /* an empty body confirms nothing */ }
  if (input.confirm !== true) {
    return NextResponse.json({ error: "Stopping everything needs {\"confirm\":true}", code: "confirm-required" }, { status: 400 });
  }
  const started = await startStopAll(input.lang === "uk" ? "uk" : "en", ports);
  return started.ok
    ? NextResponse.json({ started: true, report: "stop-all.log" }, { status: 202, headers: { "cache-control": "no-store" } })
    : NextResponse.json({ error: started.error, code: started.code }, { status: started.status, headers: { "cache-control": "no-store" } });
}
