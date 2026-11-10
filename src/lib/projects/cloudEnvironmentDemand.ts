/** Requests to look at one project/account pair again, raised where a real
 * need appears: a pipeline stage that asked for the pair's environment, or an
 * operator's choice. The controller serves them ahead of its own walk. The
 * store lives on `globalThis` so every bundle of this module shares it. */
type Demand = { project: string; accountId: string };
const store = globalThis as typeof globalThis & {
  __llvCloudEnvironmentDemands?: { pending: Map<string, Demand>; wake?: () => void };
};
type Demands = NonNullable<typeof store.__llvCloudEnvironmentDemands>;
const demands = (): Demands => store.__llvCloudEnvironmentDemands ??= { pending: new Map() };
const DEMAND_CAP = 256;

export function demandCloudEnvironment(project: string, accountId: string): void {
  const state = demands();
  if (state.pending.size >= DEMAND_CAP && !state.pending.has(`${project}\0${accountId}`)) return;
  state.pending.set(`${project}\0${accountId}`, { project, accountId });
  state.wake?.();
}
export function takeCloudEnvironmentDemand(): Demand | undefined {
  const state = demands();
  for (const [key, demand] of state.pending) { state.pending.delete(key); return demand; }
  return undefined;
}
/** One listener: the running controller. It is called on every new demand. */
export function onCloudEnvironmentDemand(wake: (() => void) | undefined): void { demands().wake = wake; }
export function clearCloudEnvironmentDemands(): void { demands().pending.clear(); }
