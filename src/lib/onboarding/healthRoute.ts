import { engineReadiness } from "@/lib/accounts/engineConnection";

import {
  cheapestHealthRuntime,
  currentHealthRun,
  productionHealthCheckPorts,
  startHealthCheck,
  stopHealthCheck,
  type HealthCheckPorts,
  type HealthRun,
  type HealthRuntime,
} from "./healthCheck";

/** What `/api/onboarding/health` answers: the runtime a run would use (null
    when no engine is connected) and the run asked about. */
export type HealthAnswer = { runtime: HealthRuntime | null; run: HealthRun | null };

type RouteResult = { status: number; body: HealthAnswer | { error: string; code?: string } };

let portsFactory: () => Promise<HealthCheckPorts> = productionHealthCheckPorts;
let readinessOf: (engine: "claude" | "codex") => ReturnType<typeof engineReadiness> = (engine) => engineReadiness(engine, null);

export function setHealthRouteDependenciesForTests(dependencies: { ports?: () => Promise<HealthCheckPorts>; readiness?: typeof readinessOf } | null): void {
  portsFactory = dependencies?.ports ?? productionHealthCheckPorts;
  readinessOf = dependencies?.readiness ?? ((engine) => engineReadiness(engine, null));
}

function runtimeNow(): HealthRuntime | null {
  return cheapestHealthRuntime({ claude: readinessOf("claude"), codex: readinessOf("codex") });
}

export async function onboardingHealthGet(runId: string | null): Promise<RouteResult> {
  const run = currentHealthRun(runId);
  if (runId && !run) return { status: 404, body: { error: "no such health check run" } };
  return { status: 200, body: { runtime: runtimeNow(), run } };
}

export async function onboardingHealthStart(): Promise<RouteResult> {
  const run = startHealthCheck(await portsFactory());
  if (!run) return { status: 409, body: { error: "Connect an engine first: no engine can start an agent on this machine.", code: "NO_ENGINE" } };
  return { status: 202, body: { runtime: run.runtime, run } };
}

export function onboardingHealthStop(runId: string | null): RouteResult {
  if (!runId) return { status: 400, body: { error: "run is required" } };
  const run = stopHealthCheck(runId);
  if (!run) return { status: 404, body: { error: "no such health check run" } };
  return { status: 200, body: { runtime: run.runtime, run } };
}
