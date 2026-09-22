import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { ProcessView, Revision, Snapshot, Step } from "@/lib/selfUpdate/types";
import { CHECKOUT_STEPS, MANAGED_STEPS, idleCheck, idleUpdate, pendingSteps, stoppedProcess } from "@/lib/selfUpdate/types";

/*
 * #2007: the Update surface's states, rendered from Snapshots the server
 * would send. The copy under test is the accepted prototype's, carried into
 * the Viewer in en and uk; the honesty rules it carries are asserted here:
 * nothing reads as done until both processes are healthy on the build, the
 * stale notice appears only once an update is published, a failed step's log
 * wraps, and every SHA is spelled with 7 characters.
 */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
});

const { SelfUpdateView } = await import("./SelfUpdateView");
const { actionError } = await import("./selfUpdateCopy");
type ActionError = import("./selfUpdateCopy").ActionError;
const { setLocale } = await import("@/lib/i18n");

afterAll(() => { void dom.happyDOM.close(); });

const OLD = "7fb73451111111111111111111111111111111aa";
const NEW = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const NOW = new Date(2026, 8, 22, 12, 6, 0).getTime();
const AT = new Date(2026, 8, 22, 12, 4, 0).toISOString();
const NEXT = new Date(2026, 8, 22, 13, 4, 0).toISOString();

const rev = (sha: string, version: string): Revision => ({ version, sha, short: sha.slice(0, 7), date: "2026-09-22T09:00:00Z" });
const OLD_REV = rev(OLD, "1.2.2");
const NEW_REV = rev(NEW, "1.2.3");

function proc(role: "web" | "runtimeHost", overrides: Partial<ProcessView> = {}): ProcessView {
  return {
    ...stoppedProcess(),
    state: "healthy",
    pid: role === "web" ? 48213 : 48190,
    port: role === "web" ? 45123 : null,
    socket: role === "runtimeHost" ? "/var/tmp/state/runtime-host.sock" : null,
    startedAt: new Date(NOW - (2 * 3600 + 14 * 60) * 1000).toISOString(),
    lastHealthAt: new Date(2026, 8, 22, 12, 4, 31).toISOString(),
    lastHealthOk: true,
    revision: OLD.slice(0, 7),
    tail: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    mode: "checkout",
    unsupportedReason: null,
    installed: OLD_REV,
    serving: { web: OLD_REV, runtimeHost: OLD_REV },
    available: null,
    check: idleCheck(),
    update: idleUpdate(CHECKOUT_STEPS),
    processes: { web: proc("web"), runtimeHost: proc("runtimeHost") },
    busy: null,
    meta: { branch: "main", remote: "/var/tmp/remote.git", checkout: "/var/tmp/checkout", pollMinutes: 60, serverTime: new Date(NOW).toISOString() },
    ...overrides,
  };
}

const available = (): Partial<Snapshot> => ({
  available: NEW_REV,
  check: {
    ...idleCheck(),
    state: "update-available",
    at: AT,
    nextPollAt: NEXT,
    relation: "behind",
    behind: 5,
    delta: {
      commits: [
        { short: "a1b2c3d", subject: "Seat tick: one standing wake card per project" },
        { short: "b2c3d4e", subject: "Say which process serves what" },
      ],
      summary: {
        commitCount: 5,
        entryCount: 2,
        counts: [{ type: "Added", count: 1 }, { type: "Fixed", count: 1 }],
        groups: [
          { type: "Added", items: ["Board placements are stored in `state.sqlite`."], more: 0 },
          { type: "Fixed", items: ["The composer keeps a draft on reconnect."], more: 3 },
        ],
      },
    },
  },
});

function steps(states: Step["state"][], extra: Partial<Record<number, Partial<Step>>> = {}): Step[] {
  return pendingSteps(CHECKOUT_STEPS).map((step, index) => ({
    ...step,
    state: states[index] ?? "pending",
    startedAt: states[index] === "running" ? new Date(NOW - 63_000).toISOString() : null,
    durationMs: states[index] === "done" ? 1_200 : states[index] === "failed" ? 63_000 : null,
    tail: states[index] === "pending" ? [] : [`${step.name} output`],
    ...extra[index],
  }));
}

const calls: string[] = [];
const actions = {
  check: () => calls.push("check"),
  update: () => calls.push("update"),
  retry: () => calls.push("retry"),
  restartWeb: () => calls.push("restart-web"),
  armHost: () => calls.push("arm-host"),
  cancelHost: () => calls.push("cancel-host"),
  confirmHost: () => calls.push("confirm-host"),
  toggleLog: (id: string) => calls.push(`toggle:${id}`),
  reload: () => calls.push("reload"),
};

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  host?.remove();
  root = null;
  calls.length = 0;
  setLocale("en");
});

function render(s: Snapshot, state: Partial<{ armed: boolean; openLogs: Set<string>; pending: Set<string>; error: ActionError | null; waitingForWeb: boolean; reloadTo: string | null }> = {}, live: "sse" | "polling" | "connecting" = "sse"): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(
    <SelfUpdateView
      snapshot={s}
      live={live}
      actions={actions}
      state={{ now: NOW, armed: false, openLogs: new Set(), pending: new Set(), error: null, waitingForWeb: false, reloadTo: null, ...state }}
    />,
  ));
  return host;
}

const text = (element: Element | null) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();
const section = (el: HTMLElement, name: string) => el.querySelector<HTMLElement>(`[data-section="${name}"]`);
const button = (el: HTMLElement, action: string) => el.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
const click = (element: Element | null) => element!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);

describe("check", () => {
  test("not checked yet: the update section asks for a check", () => {
    const el = render(snapshot());
    expect(text(el.querySelector("[data-status]"))).toBe("Not checked yet");
    expect(text(section(el, "update"))).toContain("Run a check to see if an update is available.");
    expect(text(section(el, "header"))).toContain(`Running1.2.2 · 7fb7345`);
    click(button(el, "check"));
    expect(calls).toEqual(["check"]);
  });

  test("checking: the button waits", () => {
    const el = render(snapshot({ check: { ...idleCheck(), state: "checking" } }));
    expect(text(el.querySelector("[data-status]"))).toBe("Checking origin/main…");
    expect(button(el, "check")!.disabled).toBe(true);
  });

  test("up to date says when it looked and when it looks next", () => {
    const el = render(snapshot({ check: { ...idleCheck(), state: "up-to-date", at: AT, nextPollAt: NEXT, relation: "equal" } }));
    expect(text(el.querySelector("[data-status]"))).toBe("Up to date, checked at 12:04 · Next check at 13:04");
    expect(text(section(el, "update"))).toContain("Nothing to build: 7fb7345 is the newest revision of origin/main.");
  });

  test("ahead of the remote is up to date and says by how much", () => {
    const el = render(snapshot({ check: { ...idleCheck(), state: "up-to-date", at: AT, nextPollAt: NEXT, relation: "ahead", ahead: 2 } }));
    expect(text(el.querySelector("[data-status]"))).toContain("Ahead of origin/main by 2 commits");
  });

  test("a failed check shows git's own line and offers a retry", () => {
    const el = render(snapshot({ check: { ...idleCheck(), state: "failed", at: AT, nextPollAt: NEXT, error: "fatal: unable to access 'https://example.invalid/': Could not resolve host" } }));
    expect(text(el.querySelector("[data-status]"))).toContain("Check failed at 12:04");
    expect(text(el.querySelector('[data-error="check"]'))).toContain("Could not resolve host");
    expect(text(button(el, "check"))).toBe("Retry check");
    expect(text(section(el, "update"))).toContain("The last check failed, so there is nothing to build yet.");
  });
});

describe("update available and what changes", () => {
  test("the header, the target, the pending steps and the delta", () => {
    const el = render(snapshot(available()));
    expect(text(el.querySelector("[data-status]"))).toBe("Update available · 5 commits behind origin/main · checked 12:04");
    expect(text(section(el, "header"))).toContain("Available1.2.3 · a1b2c3d");
    const update = section(el, "update")!;
    expect(text(update.querySelector("h2"))).toBe("Update to a1b2c3d (1.2.3)");
    expect(text(update)).toContain("This builds the new version. Nothing restarts until you choose to.");
    expect([...update.querySelectorAll("[data-step]")].map(text)).toEqual(["Fetch a1b2c3d", "Check out a1b2c3d", "Install dependencies", "Build", "Ready"]);
    const changes = section(el, "changes")!;
    expect(text(changes.querySelector("[data-summary]"))).toBe("5 commits · 2 changelog entries (1 Added, 1 Fixed)");
    expect(changes.querySelector("code")?.textContent).toBe("state.sqlite");
    expect(text(changes)).toContain("+3 more");
    expect([...changes.querySelectorAll("[data-commit]")].map(text)).toEqual(["a1b2c3d", "b2c3d4e"]);
    click(button(el, "update"));
    expect(calls).toEqual(["update"]);
  });
});

describe("a running update", () => {
  test("says which step of five and ticks the running one; nothing else can start", () => {
    const el = render(snapshot({
      ...available(),
      busy: "update",
      update: { ...idleUpdate(CHECKOUT_STEPS), state: "running", target: NEW, targetShort: "a1b2c3d", targetVersion: "1.2.3", startedAt: new Date(NOW - 70_000).toISOString(), steps: steps(["done", "done", "done", "running"]) },
    }));
    const update = section(el, "update")!;
    expect(update.getAttribute("data-update")).toBe("running");
    expect(text(update)).toContain("Updating… step 4 of 5");
    expect(text(update.querySelector('[data-step="build"]'))).toContain("Build · 1 m 03 s");
    expect(update.querySelector('[data-step="build"] [data-icon="running"]')).not.toBeNull();
    expect(button(el, "check")!.disabled).toBe(true);
    expect(button(el, "check")!.title).toBe("Update in progress");
    expect(button(el, "restart-web")!.disabled).toBe(true);
    expect(button(el, "arm-host")!.disabled).toBe(true);
    /* The build is not published yet: no process is told it serves an old release. */
    expect(el.querySelector("[data-stale]")).toBeNull();
  });
});

describe("a failed update", () => {
  test("names the step, keeps the processes untouched, shows the error line and wraps the log", () => {
    const failedSteps = steps(["done", "done", "done", "failed"], { 3: { exitCode: 1, tail: ["Creating an optimized production build", "error: Type error: nope"] } });
    const el = render(snapshot({
      ...available(),
      update: { ...idleUpdate(CHECKOUT_STEPS), state: "failed", target: NEW, targetShort: "a1b2c3d", targetVersion: "1.2.3", startedAt: new Date(NOW - 70_000).toISOString(), finishedAt: new Date(NOW - 7_000).toISOString(), steps: failedSteps },
    }), { openLogs: new Set(["step-build"]) });
    const update = section(el, "update")!;
    expect(text(update.querySelector('[data-outcome="failed"]'))).toContain("Update stopped at build after 1 m 03 s. The running processes were not touched; the build happens in its own release directory.");
    expect(text(update.querySelector("[data-cause]"))).toBe("error: Type error: nope");
    expect(text(button(el, "retry"))).toBe("Retry from build");
    expect(text(update.querySelector('[data-step="build"]'))).toContain("Build · 1 m 03 s · exit 1");
    const log = update.querySelector('[data-log="step-build"]')!;
    expect(log.className).toContain("whitespace-pre-wrap");
    expect(update.querySelector('a[href="/api/self-update/steps/build/log"]')).not.toBeNull();
  });
});

describe("done: counted per process, only once healthy on the build", () => {
  const done = (web: Partial<ProcessView>, host: Partial<ProcessView>, busy: Snapshot["busy"] = null) => snapshot({
    installed: NEW_REV,
    serving: { web: web.revision === "a1b2c3d" ? NEW_REV : OLD_REV, runtimeHost: host.revision === "a1b2c3d" ? NEW_REV : OLD_REV },
    check: { ...idleCheck(), state: "up-to-date", at: AT, nextPollAt: NEXT, relation: "equal" },
    busy,
    update: { ...idleUpdate(CHECKOUT_STEPS), state: "done", target: NEW, targetShort: "a1b2c3d", targetVersion: "1.2.3", startedAt: new Date(NOW - 252_000).toISOString(), finishedAt: new Date(NOW).toISOString(), steps: steps(["done", "done", "done", "done", "done"]) },
    processes: { web: proc("web", web), runtimeHost: proc("runtimeHost", host) },
  });

  test("built and not running yet: the header stays amber and each process says it serves the old release", () => {
    const el = render(done({}, {}));
    expect(text(el.querySelector('[data-outcome="done"]'))).toBe("Built a1b2c3d in 4 m 12 s. The running processes still serve the previous release. Restart web, then the runtime host, to run it.");
    expect(text(el.querySelector("[data-status]"))).toBe("a1b2c3d is built and not running yet · restart web and the runtime host to run it · checked 12:04");
    expect(text(section(el, "header"))).toContain("Built1.2.3 · a1b2c3d");
    expect([...el.querySelectorAll("[data-stale]")].map(text)).toEqual([
      "Serves 7fb7345; a1b2c3d is built. Restart to run it.",
      "Serves 7fb7345; a1b2c3d is built. Restart to run it.",
    ]);
  });

  test("web restarted onto it: web runs it, the runtime host is next", () => {
    const el = render(done({ revision: "a1b2c3d" }, {}));
    expect(text(el.querySelector('[data-outcome="done"]'))).toContain("Web runs it; restart the runtime host to run it there too.");
    expect(text(el.querySelector("[data-status]"))).toBe("Web runs a1b2c3d; restart the runtime host to run it there too · checked 12:04");
    expect(text(section(el, "header"))).toContain("Web runs1.2.3 · a1b2c3d");
    expect(text(section(el, "header"))).toContain("Runtime host runs1.2.2 · 7fb7345");
  });

  test("a web process still starting on the build does not count yet", () => {
    const el = render(done({ revision: "a1b2c3d", state: "starting" }, {}, "restart-web"));
    expect(text(el.querySelector('[data-outcome="done"]'))).toContain("Web is restarting onto it.");
  });

  test("both on it: done, and the header is green", () => {
    const el = render(done({ revision: "a1b2c3d" }, { revision: "a1b2c3d" }));
    expect(text(el.querySelector('[data-outcome="done"]'))).toContain("Web and the runtime host now run it.");
    expect(text(el.querySelector("[data-status]"))).toBe("Up to date, checked at 12:04 · Next check at 13:04");
    expect(el.querySelector("[data-stale]")).toBeNull();
  });
});

describe("process blocks", () => {
  test("healthy: PID, port or socket, uptime and the last health read", () => {
    const el = render(snapshot());
    /* The separators are drawn between the facts (spaced by margin). */
    expect(text(section(el, "web"))).toContain("PID 48213·port 45123");
    expect(text(section(el, "web"))).toContain("up 2 h 14 m·checked 12:04:31");
    expect(text(section(el, "host"))).toContain("PID 48190·runtime-host.sock");
    expect(text(section(el, "host"))).toContain("Restarting the runtime host drops the agents it supervises. Restart web first if you only changed the Viewer.");
    expect(section(el, "web")!.querySelector("[data-badge]")!.getAttribute("data-badge")).toBe("healthy");
    click(button(el, "restart-web"));
    click(button(el, "arm-host"));
    expect(calls).toEqual(["restart-web", "arm-host"]);
  });

  test("the runtime host restart asks first, inline", () => {
    const el = render(snapshot(), { armed: true });
    const confirm = el.querySelector('[data-confirm][role="alertdialog"]')!;
    expect(text(confirm)).toContain("Restarting the runtime host stops every agent it supervises. Sessions that are mid-turn are interrupted, and not all of them will come back after the restart.");
    expect(button(el, "arm-host")).toBeNull();
    click(button(el, "confirm-host"));
    click(button(el, "cancel-host"));
    expect(calls).toEqual(["confirm-host", "cancel-host"]);
  });

  test("stopping, starting, failed and stopped each say what happens", () => {
    let el = render(snapshot({ busy: "restart-runtime-host", processes: { web: proc("web", { state: "stopping" }), runtimeHost: proc("runtimeHost", { state: "stopping" }) } }));
    expect(text(section(el, "web"))).toContain("Stopping PID 48213…");
    expect(text(section(el, "host"))).toContain("Stopping PID 48190… agents are being dropped");
    flushSync(() => root!.unmount());
    el = render(snapshot({ processes: { web: proc("web", { state: "starting" }), runtimeHost: proc("runtimeHost", { state: "starting" }) } }));
    expect(text(section(el, "web"))).toContain("Starting on port 45123… waiting for HTTP 200");
    expect(text(section(el, "host"))).toContain("Starting… waiting for the socket and the fence");
    flushSync(() => root!.unmount());
    el = render(snapshot({ processes: {
      web: proc("web", { state: "failed", error: { kind: "exit", code: 1, signal: null, afterMs: 800 } }),
      runtimeHost: proc("runtimeHost", { state: "stopped", pid: null, startedAt: null, revision: null }),
    } }));
    expect(text(section(el, "web")!.querySelector('[data-error="process"]'))).toBe("Exited with code 1 after 0.8 s");
    expect(text(section(el, "host"))).toContain("Not running");
    /* A stopped host supervises nobody: starting it asks nothing. */
    expect(text(button(el, "start-host"))).toBe("Start runtime host");
    click(button(el, "start-host"));
    expect(calls).toEqual(["confirm-host"]);
  });

  test("a release that did not start says so, and that the previous one runs again", () => {
    const el = render(snapshot({ processes: { web: proc("web", { error: { kind: "fell-back", revision: "a1b2c3d", detail: "exited before it answered (exit code 3)" } }), runtimeHost: proc("runtimeHost") } }));
    expect(text(section(el, "web")!.querySelector('[data-error="process"]'))).toBe("a1b2c3d did not start, so the previous release runs again: exited before it answered (exit code 3)");
  });
});

describe("managed install", () => {
  const managed = (overrides: Partial<Snapshot>) => snapshot({ mode: "managed", meta: { ...snapshot().meta, checkout: null }, update: idleUpdate(MANAGED_STEPS), ...overrides });

  test("an update is a deployment, and restarts come with it", () => {
    const el = render(managed(available()));
    expect(text(section(el, "update"))).toContain("This deploys the new version: the runtime host builds an image, switches web to it once it passes a health check, then hands itself over to its new generation.");
    expect([...section(el, "update")!.querySelectorAll("[data-step]")].map(text)).toEqual(["Resolve a1b2c3d", "Build image", "Start candidate", "Health check", "Switch web", "Hand over runtime host"]);
    expect(button(el, "restart-web")).toBeNull();
    expect(button(el, "arm-host")).toBeNull();
    expect(text(section(el, "host"))).toContain("A deployment ends by handing the runtime host over to its new generation.");
    expect(text(el.querySelector("footer"))).toContain("Managed install");
  });

  test("while web switches and the host hands over, each block says so", () => {
    const running = (index: number) => MANAGED_STEPS.map((name, at) => ({ ...pendingSteps(MANAGED_STEPS)[at]!, state: at < index ? "done" as const : at === index ? "running" as const : "pending" as const }));
    let el = render(managed({ busy: "update", processes: { web: proc("web", { state: "starting" }), runtimeHost: proc("runtimeHost") }, update: { ...idleUpdate(MANAGED_STEPS), state: "running", target: NEW, targetShort: "a1b2c3d", steps: running(4), startedAt: new Date(NOW - 60_000).toISOString() } }));
    expect(text(section(el, "web"))).toContain("Switching to a1b2c3d… waiting for its health check");
    flushSync(() => root!.unmount());
    el = render(managed({ busy: "update", processes: { web: proc("web"), runtimeHost: proc("runtimeHost", { state: "starting" }) }, update: { ...idleUpdate(MANAGED_STEPS), state: "running", target: NEW, targetShort: "a1b2c3d", steps: running(5), startedAt: new Date(NOW - 60_000).toISOString() } }));
    expect(text(section(el, "host"))).toContain("Handing over to a1b2c3d… waiting for the successor");
  });

  test("a rolled-back deployment says the previous release serves again, and deploys again on request", () => {
    const failedAt = MANAGED_STEPS.map((name, at) => ({ ...pendingSteps(MANAGED_STEPS)[at]!, state: at < 3 ? "done" as const : at === 3 ? "failed" as const : "pending" as const, tail: at === 3 ? ["candidate health gate failed: GET / answered 500"] : [] }));
    const el = render(managed({ ...available(), update: { ...idleUpdate(MANAGED_STEPS), state: "failed", rolledBack: true, target: NEW, targetShort: "a1b2c3d", steps: failedAt, startedAt: new Date(NOW - 90_000).toISOString(), finishedAt: new Date(NOW).toISOString() } }));
    expect(text(el.querySelector('[data-outcome="failed"]'))).toContain("Deployment stopped at health check after 1 m 30 s and was rolled back: the previous release serves again.");
    expect(text(button(el, "retry"))).toBe("Deploy again");
  });

  test("done means both processes run it", () => {
    const el = render(managed({
      installed: NEW_REV,
      serving: { web: NEW_REV, runtimeHost: NEW_REV },
      check: { ...idleCheck(), state: "up-to-date", at: AT, nextPollAt: NEXT, relation: "equal" },
      processes: { web: proc("web", { revision: "a1b2c3d" }), runtimeHost: proc("runtimeHost", { revision: "a1b2c3d" }) },
      update: { ...idleUpdate(MANAGED_STEPS), state: "done", target: NEW, targetShort: "a1b2c3d", steps: MANAGED_STEPS.map((name, at) => ({ ...pendingSteps(MANAGED_STEPS)[at]!, state: "done" as const })), startedAt: new Date(NOW - 300_000).toISOString(), finishedAt: new Date(NOW).toISOString() },
    }));
    expect(text(el.querySelector('[data-outcome="done"]'))).toBe("Deployed a1b2c3d in 5 m 00 s. Web and the runtime host now run it.");
  });
});

describe("the rest of the surface", () => {
  test("an install that cannot update itself says why and offers nothing", () => {
    const el = render(snapshot({ mode: "unsupported", unsupportedReason: "not-a-checkout" }));
    expect(text(el)).toContain("This Viewer was installed as a package.");
    expect(button(el, "check")).toBeNull();
  });

  test("after Restart web the page says it reconnects, then offers to reload onto the new server", () => {
    let el = render(snapshot(), { waitingForWeb: true });
    expect(text(el.querySelector('[data-banner="waiting"]'))).toBe("Web is restarting. This page reconnects when it answers again.");
    flushSync(() => root!.unmount());
    el = render(snapshot(), { reloadTo: "a1b2c3d" });
    expect(text(el.querySelector('[data-banner="reload"]'))).toContain("Web now runs a1b2c3d. Reload the page to use it.");
    click(button(el, "reload"));
    expect(calls).toEqual(["reload"]);
  });

  test("the footer says when live updates fell back to polling", () => {
    const el = render(snapshot(), {}, "polling");
    expect(text(el.querySelector("footer"))).toContain("Live updates unavailable, polling");
    expect(text(el.querySelector("footer"))).toContain("Checks every 60 min");
  });

  test("a refusal is worded from its code, and what the page saw itself is worded too", () => {
    let el = render(snapshot(), { error: actionError(409, { code: "busy-update", error: "Busy: update" } as never) });
    expect(text(el.querySelector('[data-error="action"]'))).toBe("An update is running.");
    flushSync(() => root!.unmount());
    el = render(snapshot(), { error: actionError(503, { code: "deployment-refused", detail: "runtime host socket is unavailable" }) });
    expect(text(el.querySelector('[data-error="action"]'))).toBe("The runtime host did not take the deployment: runtime host socket is unavailable");
    flushSync(() => root!.unmount());
    el = render(snapshot(), { error: actionError(403, { error: "this is an operator-only action" } as never) });
    expect(text(el.querySelector('[data-error="action"]'))).toBe("Only the operator can update or restart the Viewer.");
    flushSync(() => root!.unmount());
    el = render(snapshot(), { error: actionError(502, null) });
    expect(text(el.querySelector('[data-error="action"]'))).toBe("The request failed (HTTP 502).");
  });

  test("Ukrainian: a memory-guard failure and a 409 refusal carry no English sentence", () => {
    setLocale("uk");
    const failedSteps = steps(["done", "done", "failed"], { 2: { tail: [], exitCode: null, failure: { kind: "memory", availableMb: 2048, neededMb: 4096 } } });
    const el = render(snapshot({
      ...available(),
      update: { ...idleUpdate(CHECKOUT_STEPS), state: "failed", target: NEW, targetShort: "a1b2c3d", targetVersion: "1.2.3", startedAt: new Date(NOW - 5_000).toISOString(), finishedAt: new Date(NOW).toISOString(), steps: failedSteps },
    }), { error: actionError(409, { code: "no-update" }) });
    const outcome = text(el.querySelector('[data-outcome="failed"]'));
    expect(text(el.querySelector("[data-cause]"))).toBe("Замало вільної пам'яті: доступно 2048 МБ, потрібно 4096 МБ.");
    expect(text(el.querySelector('[data-error="action"]'))).toBe("Оновлення немає: спершу запустіть перевірку.");
    /* No run of three Latin words anywhere in what the failure and the refusal say. */
    const english = /[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/;
    expect(english.test(outcome)).toBe(false);
    expect(english.test(text(el.querySelector('[data-error="action"]')))).toBe(false);
    /* The memory guard failed before any command ran: there is no log to show. */
    expect(el.querySelector('[data-step="install"] [data-action="toggle-log"]')).toBeNull();
  });

  test("Ukrainian: our own check and step failures are worded, a silent host too", () => {
    setLocale("uk");
    let el = render(snapshot({ mode: "managed", check: { ...idleCheck(), state: "failed", at: AT, nextPollAt: NEXT, errorCode: "no-release-target" } }));
    expect(text(el.querySelector('[data-error="check"]'))).toBe("Не вдалося прочитати ціль релізу Viewer, тож установлена ревізія невідома.");
    flushSync(() => root!.unmount());
    el = render(snapshot({ processes: { web: proc("web"), runtimeHost: proc("runtimeHost", { state: "failed", error: { kind: "no-answer" } }) } }));
    expect(text(section(el, "host")!.querySelector('[data-error="process"]'))).toBe("Runtime host не відповів");
    flushSync(() => root!.unmount());
    const moved = steps(["failed"], { 0: { tail: ["From /var/tmp/remote", "   a1b2c3d..f7e6ce4  main -> refs/self-update/tip"], exitCode: null, failure: { kind: "remote-moved", expected: "a1b2c3d", fetched: "f7e6ce4" } } });
    el = render(snapshot({ ...available(), update: { ...idleUpdate(CHECKOUT_STEPS), state: "failed", target: NEW, targetShort: "a1b2c3d", steps: moved, startedAt: new Date(NOW - 1_000).toISOString(), finishedAt: new Date(NOW).toISOString() } }));
    expect(text(el.querySelector("[data-cause]"))).toBe("Віддалена гілка змінилася після перевірки (a1b2c3d → f7e6ce4). Перевірте знову.");
  });

  test("Ukrainian", () => {
    setLocale("uk");
    const el = render(snapshot(available()));
    expect(text(button(el, "check"))).toBe("Перевірити");
    expect(text(el.querySelector("[data-status]"))).toBe("Є оновлення · 5 комітів позаду origin/main · перевірено о 12:04");
    expect(text(section(el, "update")!.querySelector("h2"))).toBe("Оновити до a1b2c3d (1.2.3)");
    expect(text(button(el, "restart-web"))).toBe("Перезапустити веб");
  });
});
