import { performanceSpans, type PerformanceSite } from "@/lib/performanceSpans";
import { StateSnapshotChangedError } from "@/lib/state/sqliteStateStore";

/** Carries custody of a flow created just as its lane revision changed. */
export class StaleControllerFlowError extends StateSnapshotChangedError {
  constructor(readonly flowId: string, readonly pipelineId: string) {
    super();
    this.name = "StaleControllerFlowError";
  }
}

/** Recheck the lane before using a port and after awaited evidence returns.
    A concurrent pause, close or report withdraws this snapshot's authority
    before the controller can act on its evidence. Ports retain their own
    reservation and actuation fences across work they perform internally. */
export function controllerSnapshotPorts<T extends object>(ports: T, assertCurrent: () => void, pipelineId: string): T {
  return new Proxy(ports, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      // Provider wake coalescing keys its cache by the scheduler function.
      // Scheduling a future reconciliation carries no lane write authority.
      if (property === "scheduleTick") return value;
      return (...args: unknown[]) => {
        assertCurrent();
        if (property === "createFlow") args[3] = assertCurrent;
        const result = performanceSpans.sync("controller.port-start", () => Reflect.apply(value, target, args));
        if (result && typeof result.then === "function") {
          const name = String(property);
          const category: PerformanceSite = /git|commit|publish|reviewHead|branch/i.test(name) ? "controller.git-wait"
            : /spawn|host|runtime|kill|session/i.test(name) ? "controller.runtime-wait"
            : /save|persist|flow|task/i.test(name) ? "controller.store-wait" : "controller.other-wait";
          return performanceSpans.wait(category, () => Promise.resolve(result)).then(value => {
            try {
              assertCurrent();
            } catch (error) {
              const flowId = property === "createFlow" && value && typeof value === "object"
                ? (value as { flow?: { id?: unknown } }).flow?.id
                : undefined;
              if (typeof flowId === "string") throw new StaleControllerFlowError(flowId, pipelineId);
              throw error;
            }
            return value;
          });
        }
        return result;
      };
    },
  });
}
