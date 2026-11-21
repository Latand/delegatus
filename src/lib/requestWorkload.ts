import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

import { WORKSPACE_ROUTES } from "./team/workspaceRoutes";
import type { ViewerOperation } from "./viewerLoopMonitor";
import type { McpToolName } from "./mcp/server";

export type RegistryReadSite = "registry.keyed" | "registry.snapshot";

type Bucket = {
  minute: number;
  renders: Map<string, number>;
  tools: Map<string, number>;
  callers: Map<string, number>;
  registryReads: Map<string, number>;
  registrySamples: Map<string, number>;
  lastRegistrySample: Partial<Record<RegistryReadSite, number>>;
  omitted: number;
};

const retainedMinutes = 150;
const callerLimit = 128;
const dynamicRoutes = Object.keys(WORKSPACE_ROUTES).filter(route => route.includes("[")).map(route => ({
  route,
  parts: route.split("/"),
}));

/** Return only a route from the product catalog. A dynamic segment, unknown
    resource, query or header is never a diagnostic label. */
export function workloadRoute(input: unknown): string {
  if (input === "/") return "/";
  if (typeof input !== "string" || input.length > 2048 || !input.startsWith("/api/")) return "other";
  const pathname = input.split("?", 1)[0]!;
  if (Object.hasOwn(WORKSPACE_ROUTES, pathname)) return pathname;
  const parts = pathname.split("/");
  return dynamicRoutes.find(shape => shape.parts.every((part, i) => part.startsWith("[...")
    ? i < parts.length : part.startsWith("[") ? Boolean(parts[i]) : part === parts[i])
    && (shape.parts.length === parts.length || shape.parts.at(-1)?.startsWith("[...")))?.route ?? "other";
}

function workloadConversation(value: unknown): string | null {
  if (typeof value !== "string" || !/^conversation_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function createRequestWorkload(uptime = process.uptime.bind(process)) {
  const context = new AsyncLocalStorage<{ name: string; active: boolean }>();
  const buckets = new Map<number, Bucket>();
  let current: Bucket | undefined;
  function bucket() {
    const minute = Math.floor(uptime() / 60);
    if (current?.minute !== minute) {
      current = { minute, renders: new Map(), tools: new Map(), callers: new Map(), registryReads: new Map(), registrySamples: new Map(), lastRegistrySample: {}, omitted: 0 };
      buckets.set(minute, current);
      for (const old of buckets.keys()) {
        if (old > minute - retainedMinutes) break;
        buckets.delete(old);
      }
    }
    return current;
  }
  const increment = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  // A job spawned by a request can outlive its response. Its later slices
  // must stop charging the finished caller even if it inherited this store.
  function during<T>(name: string, run: () => T): T {
    const scope = { name, active: true };
    try {
      const result = context.run(scope, run);
      if (result && typeof (result as unknown as PromiseLike<unknown>).then === "function") {
        const close = () => { scope.active = false; };
        void Promise.resolve(result).then(close, close);
      } else {
        scope.active = false;
      }
      return result;
    } catch (error) {
      scope.active = false;
      throw error;
    }
  }
  return {
    label() {
      const scope = context.getStore();
      return scope?.active ? scope.name : undefined;
    },
    withRoute<T>(path: unknown, run: () => T): T {
      return during("http:" + workloadRoute(path), run);
    },
    withTool<T>(tool: McpToolName, run: () => T): T {
      return during("mcp:" + tool, run);
    },
    registryRead(site: RegistryReadSite, operation: ViewerOperation | undefined) {
      const held = bucket();
      const scope = context.getStore();
      const owner = scope?.active ? scope.name : operation ?? "unscoped";
      const key = site + "|" + owner;
      increment(held.registryReads, key);
      // Only fixed bundle coordinates enter diagnostics. Keep at most one
      // illustrative synchronous stack per site and five-second interval.
      const slot = Math.floor(uptime() / 5);
      if (held.lastRegistrySample[site] === slot) return;
      held.lastRegistrySample[site] = slot;
      const stack = new Error().stack ?? "";
      const frames = Array.from(stack.matchAll(/[\\/]\.next[\\/]server[\\/]chunks[\\/](\d+\.js:\d+:\d+)/g), match => match[1]).slice(0, 8);
      if (frames.length) increment(held.registrySamples, key + "|" + frames.join(","));
    },
    completedRender(routeClass: string | undefined) {
      increment(bucket().renders, routeClass?.startsWith("http:") ? routeClass.slice(5) : "other");
    },
    receivedTool(tool: McpToolName, peer: { pid: number; startIdentity?: string | null } | null | undefined, callerId: string | null, target: unknown) {
      const held = bucket();
      increment(held.tools, tool);
      // Peer PID comes from the verified local connection. The operator can
      // join it to host ancestry on this machine. Never retain a capability.
      const ticks = peer?.startIdentity?.split(":").at(-1);
      const caller = peer && ticks && /^\d+$/.test(ticks) ? `pid:${peer.pid}:${ticks}` : workloadConversation(callerId) ?? "unknown";
      const conversation = workloadConversation(target);
      const key = `${tool}|${caller}|${conversation ?? ""}`;
      if (held.callers.has(key) || held.callers.size < callerLimit) increment(held.callers, key);
      else held.omitted++;
    },
    snapshot(firstMinute: number, lastMinute: number) {
      const latest = Math.floor(uptime() / 60);
      const start = Math.max(0, latest - retainedMinutes + 1, firstMinute);
      const end = Math.min(latest, lastMinute, start + 15);
      const minutes = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
        const minute = start + index, value = buckets.get(minute);
        return { minute, complete: minute < latest, renders: Object.fromEntries(value?.renders ?? []),
          tools: Object.fromEntries(value?.tools ?? []),
          registryReads: Object.fromEntries(value?.registryReads ?? []), registrySamples: Object.fromEntries(value?.registrySamples ?? []),
          callerTargets: Object.fromEntries(value?.callers ?? []),
          omittedCallerTargets: value?.omitted ?? 0 };
      });
      return { version: 1, pid: process.pid, latest, minutes };
    },
  };
}

const shared = process as typeof process & { __delegatusRequestWorkload?: ReturnType<typeof createRequestWorkload> };
export const requestWorkload = shared.__delegatusRequestWorkload ??= createRequestWorkload();
