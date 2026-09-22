/* The self-update page. Renders one Snapshot into four sections; the Snapshot
   arrives over SSE, or by polling /api/state every second when SSE fails.
   Served through Bun.Transpiler, so this file is a plain script: type imports
   only, erased on the way out. */
import type { ProcessView, Revision, Snapshot, Step } from "../lib/state";

type Tone = "muted" | "accent" | "success" | "danger" | "warning";
type IconKind = "pending" | "running" | "done" | "failed" | "warning";
type Child = Node | string | null | undefined | false;

const ui = {
  snapshot: null as Snapshot | null,
  receivedAt: 0,
  clockOffset: 0,
  live: "connecting" as "connecting" | "sse" | "polling",
  openLogs: new Set<string>(),
  armed: false,
  pending: new Set<string>(),
  error: null as string | null,
};

/* ---------- DOM helpers ---------- */

function h(tag: string, attrs: Record<string, string | boolean | undefined> = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return element;
}

const SVG_NS = "http://www.w3.org/2000/svg";
function icon(kind: IconKind, extraClass = ""): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 14 14");
  svg.setAttribute("aria-hidden", "true");
  const tone: Record<IconKind, Tone> = { pending: "muted", running: "accent", done: "success", failed: "danger", warning: "warning" };
  svg.setAttribute("class", `icon tone-${tone[kind] === "warning" ? "warning-text" : tone[kind]} ${kind === "running" ? "spin" : ""} ${extraClass}`.trim());
  const shapes: Record<IconKind, string> = {
    pending: '<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    running: '<circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 1.75a5.25 5.25 0 0 1 0 10.5z" fill="currentColor"/>',
    done: '<circle cx="7" cy="7" r="6" fill="currentColor"/><path d="M4.4 7.2l1.8 1.8 3.5-3.7" fill="none" stroke="var(--surface-card)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
    failed: '<circle cx="7" cy="7" r="6" fill="currentColor"/><path d="M4.9 4.9l4.2 4.2M9.1 4.9l-4.2 4.2" stroke="var(--surface-card)" stroke-width="1.6" stroke-linecap="round"/>',
    warning: '<path d="M7 1.4l6 10.8H1z" fill="currentColor"/><path d="M7 5.4v3.2" stroke="var(--surface-card)" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="10.3" r=".85" fill="var(--surface-card)"/>',
  };
  svg.innerHTML = shapes[kind];
  /* A re-render replaces the icon; phasing the spin to the wall clock keeps it
     turning smoothly across replacements. */
  if (kind === "running") svg.setAttribute("style", `animation-delay:-${Date.now() % 1000}ms`);
  return svg;
}

function badge(state: ProcessView["state"]): HTMLElement {
  const map: Record<ProcessView["state"], [string, IconKind]> = {
    healthy: ["success", "done"],
    starting: ["accent", "running"],
    stopping: ["accent", "running"],
    failed: ["danger", "failed"],
    stopped: ["neutral", "pending"],
  };
  const [tone, kind] = map[state];
  const glyph = icon(kind);
  glyph.setAttribute("class", `icon ${kind === "running" ? "spin" : ""}`.trim());
  return h("span", { class: `badge ${tone}` }, glyph, state);
}

/* Replaces a section's content only when it changed, and puts focus back on
   the control that had it, so live updates never steal the keyboard. */
function patch(section: HTMLElement, children: Child[], className?: string): void {
  const next = h("div", {}, ...children);
  if (className !== undefined && section.className !== className) section.className = className;
  if (section.innerHTML === next.innerHTML) return;
  const focusedKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
  const scrolls = new Map<string, number>();
  section.querySelectorAll<HTMLElement>("[data-scroll]").forEach((element) => {
    const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
    scrolls.set(element.dataset.scroll!, atBottom ? -1 : element.scrollTop);
  });
  section.replaceChildren(...Array.from(next.childNodes));
  section.querySelectorAll<HTMLElement>("[data-scroll]").forEach((element) => {
    const previous = scrolls.get(element.dataset.scroll!);
    element.scrollTop = previous === undefined || previous === -1 ? element.scrollHeight : previous;
  });
  if (focusedKey) section.querySelector<HTMLElement>(`[data-key="${focusedKey}"]`)?.focus();
}

/* ---------- formatting ---------- */

function now(): number {
  return Date.now() + ui.clockOffset;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function clock(iso: string | null, seconds = false): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ""}`;
}

function day(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)} m ${pad(totalSeconds % 60)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60 * 48) return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
  return `${Math.floor(minutes / 1440)} d ${Math.floor((minutes % 1440) / 60)} h`;
}

function revisionText(revision: Revision): string {
  return [revision.version, revision.short, day(revision.date)].filter(Boolean).join(" · ");
}

const STEP_LABEL: Record<Step["name"], (short: string) => string> = {
  fetch: (short) => `Fetch ${short}`,
  checkout: (short) => `Check out ${short}`,
  install: () => "Install dependencies",
  build: () => "Build",
  ready: () => "Ready",
};

/* ---------- actions ---------- */

async function act(key: string, path: string, body?: unknown): Promise<void> {
  ui.pending.add(key);
  ui.error = null;
  render();
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { error?: string; snapshot?: Snapshot } | Snapshot | null;
    if (!response.ok) ui.error = (payload as { error?: string } | null)?.error ?? `Request failed (${response.status})`;
    const snapshot = response.ok ? payload as Snapshot : (payload as { snapshot?: Snapshot } | null)?.snapshot;
    if (snapshot) accept(snapshot);
  } catch (error) {
    ui.error = error instanceof Error ? error.message : String(error);
  } finally {
    ui.pending.delete(key);
    render();
  }
}

document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target || (target as HTMLButtonElement).disabled) return;
  const action = target.dataset.action!;
  if (action === "check") void act("check", "/api/check");
  else if (action === "update") void act("update", "/api/update");
  else if (action === "retry") void act("update", "/api/update/retry");
  else if (action === "restart-web") void act("restart-web", "/api/restart/web");
  else if (action === "arm-host") { ui.armed = true; render(); document.querySelector<HTMLElement>('[data-key="confirm-host"]')?.focus(); }
  else if (action === "cancel-host") { ui.armed = false; render(); document.querySelector<HTMLElement>('[data-key="arm-host"]')?.focus(); }
  else if (action === "confirm-host") { ui.armed = false; void act("restart-runtime-host", "/api/restart/runtime-host", { confirm: true }); }
  else if (action === "toggle-log") {
    const id = target.dataset.log!;
    if (ui.openLogs.has(id)) ui.openLogs.delete(id); else ui.openLogs.add(id);
    render();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ui.armed) { ui.armed = false; render(); }
});

/* ---------- sections ---------- */

function button(label: string, action: string, options: { tone?: string; disabled?: boolean; title?: string; key?: string } = {}): HTMLElement {
  return h("button", {
    type: "button",
    class: `btn ${options.tone ?? ""}`.trim(),
    "data-action": action,
    "data-key": options.key ?? action,
    disabled: options.disabled,
    title: options.title,
  }, label);
}

function renderHeader(s: Snapshot): Child[] {
  const branch = `origin/${s.meta.branch}`;
  const check = s.check;
  const updating = s.busy === "update";
  const checking = check.state === "checking" || ui.pending.has("check");
  const label = check.state === "failed" ? "Retry check" : "Check now";
  const checkButton = button(label, "check", {
    disabled: updating || checking,
    title: updating ? "Update in progress" : undefined,
  });

  let status: Child[];
  if (check.state === "checking") {
    status = [icon("running"), h("span", { class: "status-text" }, `Checking ${branch}…`)];
  } else if (check.state === "up-to-date") {
    status = [icon("done"), h("span", { class: "status-text" },
      `Up to date, checked at ${clock(check.at)}`,
      check.note ? ` · ${check.note}` : "",
      h("span", { class: "next" }, ` · Next check at ${clock(check.nextPollAt)}`))];
  } else if (check.state === "update-available") {
    const behind = check.note ?? `${check.behind} ${check.behind === 1 ? "commit" : "commits"} behind ${branch}`;
    status = [icon("warning"), h("span", { class: "status-text" }, `Update available · ${behind} · checked ${clock(check.at)}`)];
  } else if (check.state === "failed") {
    status = [icon("failed"), h("span", { class: "status-text" }, `Check failed at ${clock(check.at)}`,
      h("span", { class: "next" }, ` · Next check at ${clock(check.nextPollAt)}`))];
  } else {
    status = [icon("pending"), h("span", { class: "status-text" }, "Not checked yet")];
  }

  const pairs: Child[] = [
    h("span", { class: "pair" }, h("span", { class: "label" }, "Running"), h("span", { class: "value" }, revisionText(s.running))),
  ];
  if (s.available) {
    pairs.push(h("span", { class: "pair" }, h("span", { class: "label" }, "Available"), h("span", { class: "value" }, revisionText(s.available))));
  }
  return [
    h("div", { class: "row spread header-top" }, h("h1", { class: "title" }, "Agent Log Viewer · self-update"), checkButton),
    h("div", { class: "versions" }, ...pairs),
    h("div", { class: "status", role: "status" }, ...status),
    check.state === "failed" && check.error ? h("p", { class: "error-line" }, check.error) : null,
    ui.error ? h("p", { class: "error-line" }, ui.error) : null,
  ];
}

function stepDuration(step: Step): number | null {
  if (step.state === "running" && step.startedAt) return now() - Date.parse(step.startedAt);
  return step.durationMs;
}

function renderStep(step: Step, short: string): HTMLElement {
  const kind: IconKind = step.state === "pending" ? "pending" : step.state === "running" ? "running" : step.state === "done" ? "done" : "failed";
  const elapsed = stepDuration(step);
  let title = STEP_LABEL[step.name](short);
  if (elapsed !== null && step.state !== "pending") title += ` · ${duration(elapsed)}`;
  if (step.state === "failed" && step.exitCode !== null) title += ` · exit ${step.exitCode}`;
  const id = `step-${step.name}`;
  const open = ui.openLogs.has(id);
  const hasOutput = step.tail.length > 0;
  return h("li", { class: `step ${step.state}` },
    h("div", { class: "step-head" },
      icon(kind),
      h("span", { class: "step-title", title }, title),
      hasOutput ? h("div", { class: "step-side" },
        h("button", { type: "button", class: "btn link", "data-action": "toggle-log", "data-log": id, "data-key": `toggle-${id}`, "aria-expanded": open ? "true" : "false" }, open ? "Hide log ▾" : "Show log ▸"),
      ) : null),
    open && hasOutput ? h("div", { class: "disclosure" },
      h("pre", { class: "log", "data-scroll": id, tabindex: "0", "aria-label": `${STEP_LABEL[step.name](short)} log, last ${step.tail.length} lines` }, step.tail.join("\n")),
      h("div", { class: "log-foot" }, h("a", { href: `/api/steps/${step.name}/log`, target: "_blank", rel: "noopener" }, "Full log ↗")),
    ) : null,
  );
}

function renderUpdate(s: Snapshot): { children: Child[]; edge: string } {
  const update = s.update;
  const branch = `origin/${s.meta.branch}`;
  const freshTarget = s.available && s.check.state === "update-available" && s.available.sha !== update.target ? s.available : null;

  if (update.state === "idle" || (update.state === "done" && freshTarget)) {
    if (!s.available || s.check.state !== "update-available") {
      const copy = s.check.state === "up-to-date"
        ? `Nothing to build: this checkout is on the newest revision of ${branch}.`
        : "Run a check to see if an update is available.";
      return { children: [h("h2", { class: "section-title" }, "Update"), h("p", { class: "note" }, copy)], edge: "" };
    }
    const target = s.available;
    return {
      children: [
        h("div", { class: "row spread wrap" },
          h("h2", { class: "section-title" }, `Update to ${target.short} (${target.version})`),
          h("div", { class: "actions" }, button("Update", "update", { tone: "primary", disabled: s.busy !== null || ui.pending.has("update") }))),
        h("p", { class: "note" }, "This builds the new version. Nothing restarts until you choose to."),
        h("ol", { class: "steps" }, ...update.steps.map((step) => renderStep({ ...step, state: "pending", tail: [] }, target.short))),
      ],
      edge: "",
    };
  }

  const short = update.targetShort ?? "";
  const heading = `${update.state === "done" ? "Updated to" : "Update to"} ${short}${update.targetVersion ? ` (${update.targetVersion})` : ""}`;
  const elapsed = update.startedAt ? (update.finishedAt ? Date.parse(update.finishedAt) : now()) - Date.parse(update.startedAt) : 0;
  const steps = h("ol", { class: "steps" }, ...update.steps.map((step) => renderStep(step, short)));

  if (update.state === "running") {
    const index = update.steps.findIndex((step) => step.state === "running");
    const progress = h("span", { class: "progress" }, icon("running"), `Updating… step ${Math.max(1, index + 1)} of ${update.steps.length}`);
    return { children: [h("div", { class: "row spread wrap" }, h("h2", { class: "section-title" }, heading), progress), steps], edge: "card update edge-accent" };
  }
  if (update.state === "done") {
    return {
      children: [
        h("h2", { class: "section-title" }, heading),
        h("p", { class: "outcome success" }, `Built ${short} in ${duration(elapsed)}. Running processes still serve the previous version. Restart web, then the runtime host, to apply.`),
        steps,
      ],
      edge: "card update edge-success",
    };
  }
  const failed = update.steps.find((step) => step.state === "failed");
  const failedName = failed?.name ?? "the first step";
  return {
    children: [
      h("div", { class: "row spread wrap" },
        h("h2", { class: "section-title" }, heading),
        h("div", { class: "actions" }, button(`Retry from ${failedName}`, "retry", { tone: "primary", disabled: s.busy !== null || ui.pending.has("update") }))),
      h("p", { class: "outcome danger" }, `Update stopped at ${failedName} after ${duration(elapsed)}. Running processes were not touched.`),
      steps,
    ],
    edge: "card update edge-danger",
  };
}

function renderChanges(s: Snapshot): Child[] | null {
  const delta = s.check.delta;
  if (!delta || s.check.state !== "update-available") return null;
  const groups = delta.summary.groups.map((group) => h("div", {},
    h("h3", { class: "subhead" }, group.type),
    h("ul", { class: "items" }, ...group.items.map((item) => h("li", {}, item))),
    group.more > 0 ? h("p", { class: "more" }, `+${group.more} more`) : null,
  ));
  const shown = delta.commits.slice(0, 20);
  return [
    h("div", {},
      h("h2", { class: "section-title" }, "What changes"),
      h("p", { class: "meta" }, delta.summary.line)),
    groups.length > 0 ? h("div", { class: "groups" }, ...groups) : null,
    h("div", {},
      h("h3", { class: "subhead" }, "Commits"),
      h("ul", { class: "commits" }, ...shown.map((commit) => h("li", { class: "commit" },
        h("span", { class: "sha" }, commit.short),
        h("span", { class: "subject", title: commit.subject }, commit.subject)))),
      delta.commits.length > shown.length ? h("p", { class: "more" }, `+${delta.commits.length - shown.length} more`) : null),
  ];
}

function facts(parts: (string | HTMLElement)[]): HTMLElement {
  const children: Child[] = [];
  parts.forEach((part, index) => {
    if (index > 0) children.push(h("span", { class: "sep", "aria-hidden": "true" }, "·"));
    children.push(typeof part === "string" ? h("span", { class: "nowrap" }, part) : part);
  });
  return h("p", { class: "facts" }, ...children);
}

function renderProcess(s: Snapshot, role: "web" | "runtimeHost"): { children: Child[]; className: string } {
  const status = s.processes[role];
  const isHost = role === "runtimeHost";
  const name = isHost ? "Runtime host" : "Web";
  const busyKey = isHost ? "restart-runtime-host" : "restart-web";
  const acting = s.busy === busyKey || ui.pending.has(busyKey);
  const blocked = s.busy !== null || ui.pending.has(busyKey);
  const children: Child[] = [
    h("div", { class: "row spread" }, h("h2", { class: "section-title" }, name), badge(status.state)),
  ];
  if (isHost) {
    children.push(h("p", { class: "warning-line" }, icon("warning"),
      h("span", {}, "Restarting the runtime host drops the agents it supervises. Restart web first if you only changed the Viewer.")));
  }

  const pid = status.pid !== null ? h("span", { class: "nowrap" }, "PID ", h("span", { class: "mono" }, String(status.pid))) : null;
  const where = isHost
    ? h("span", { class: "nowrap mono" }, (status.socket ?? "").split("/").pop() || "runtime-host.sock")
    : h("span", { class: "nowrap" }, `port ${status.port ?? s.meta.webPort}`);
  const up = status.startedAt ? `up ${duration(now() - Date.parse(status.startedAt))}` : null;
  const checked = status.lastHealthAt ? `checked ${clock(status.lastHealthAt, true)}` : null;

  if (status.state === "healthy") {
    children.push(facts([pid!, where, up!, ...(checked ? [checked] : [])].filter(Boolean) as (string | HTMLElement)[]));
  } else if (status.state === "stopping") {
    children.push(h("p", { class: "value" }, `Stopping PID ${status.pid ?? "…"}…${isHost ? " agents are being dropped" : ""}`));
  } else if (status.state === "starting") {
    children.push(h("p", { class: "value" }, isHost
      ? "Starting… waiting for the socket and the fence"
      : `Starting on port ${status.port ?? s.meta.webPort}… waiting for HTTP 200`));
    if (pid) children.push(facts([pid, where]));
  } else if (status.state === "failed") {
    children.push(h("p", { class: "error-line" }, status.error ?? "Failed"));
    if (pid) children.push(facts([pid, where, ...(checked ? [checked] : [])]));
  } else {
    children.push(h("p", { class: "value" }, "Not running"));
  }

  /* After an update the checkout moves ahead of what a process serves. */
  if (status.revision && status.pid !== null && s.running.short && status.revision !== s.running.short && status.state !== "stopping") {
    children.push(h("p", { class: "stale" }, `Serves ${status.revision}; the checkout is at ${s.running.short}. Restart to apply.`));
  }

  const tailId = `tail-${role}`;
  if ((status.state === "failed" || status.state === "starting") && status.tail.length > 0) {
    const open = ui.openLogs.has(tailId);
    children.push(h("div", { class: "disclosure" },
      h("button", { type: "button", class: "btn link", "data-action": "toggle-log", "data-log": tailId, "data-key": `toggle-${tailId}`, "aria-expanded": open ? "true" : "false", style: "align-self:flex-start" },
        open ? "Hide last output ▾" : "Show last output ▸"),
      open ? h("pre", { class: "log", "data-scroll": tailId, tabindex: "0" }, status.tail.join("\n")) : null));
  }

  const running = status.state !== "stopped" && status.state !== "failed";
  const label = running ? (isHost ? "Restart runtime host" : "Restart web") : (isHost ? "Start runtime host" : "Start web");
  if (isHost && ui.armed && !acting) {
    children.push(h("div", { class: "confirm", role: "alertdialog", "aria-label": "Confirm runtime host restart" },
      h("p", {}, "Restarting the runtime host stops every agent it supervises. Sessions that are mid-turn are interrupted, and not all of them will come back after the restart."),
      h("div", { class: "actions" },
        button("Stop and restart runtime host", "confirm-host", { tone: "warning-primary", disabled: blocked }),
        button("Cancel", "cancel-host"))));
  } else {
    const disabled = blocked || status.state === "stopping" || status.state === "starting";
    children.push(h("div", { class: "actions" }, isHost
      ? button(label, "arm-host", { tone: "warning", disabled, title: s.busy && s.busy !== busyKey ? "Another action is running" : undefined })
      : button(label, "restart-web", { disabled, title: s.busy && s.busy !== busyKey ? "Another action is running" : undefined })));
  }

  const edge = status.state === "failed" ? "edge-danger" : isHost ? "edge-warning" : "";
  return { children, className: `card process ${edge}`.trim() };
}

function renderFooter(s: Snapshot): Child[] {
  const live = ui.live === "sse"
    ? h("span", {}, "Live (SSE)")
    : ui.live === "polling" ? h("span", { class: "polling" }, "Live updates unavailable, polling") : h("span", {}, "Connecting…");
  return [
    live,
    h("span", {}, `Prototype on ${location.host}`),
    h("span", { class: "path" }, "Checkout ", h("span", { class: "mono" }, s.meta.checkout)),
    h("span", {}, `Checks every ${s.meta.pollMinutes} min`),
  ];
}

function byId(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function render(): void {
  const s = ui.snapshot;
  if (!s) return;
  const header = s.check.state === "update-available" ? "card header edge-warning"
    : s.check.state === "failed" ? "card header edge-danger" : "card header";
  patch(byId("header"), renderHeader(s), header);
  const update = renderUpdate(s);
  patch(byId("update"), update.children, update.edge || "card update");
  const changes = renderChanges(s);
  byId("changes").hidden = changes === null;
  if (changes) patch(byId("changes"), changes);
  const web = renderProcess(s, "web");
  patch(byId("web"), web.children, web.className);
  const host = renderProcess(s, "runtimeHost");
  patch(byId("host"), host.children, host.className);
  patch(byId("footer"), renderFooter(s));
}

/* ---------- transport ---------- */

function accept(snapshot: Snapshot): void {
  ui.snapshot = snapshot;
  ui.receivedAt = Date.now();
  ui.clockOffset = Date.parse(snapshot.meta.serverTime) - Date.now();
  if (snapshot.busy === "restart-runtime-host") ui.armed = false;
  render();
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
function startPolling(): void {
  if (pollTimer) return;
  ui.live = "polling";
  render();
  const tick = async () => {
    try { accept(await (await fetch("/api/state", { cache: "no-store" })).json() as Snapshot); } catch { /* next tick */ }
  };
  void tick();
  pollTimer = setInterval(tick, 1_000);
}

function connect(): void {
  if (typeof EventSource === "undefined") { startPolling(); return; }
  let errors = 0;
  const source = new EventSource("/api/events");
  source.addEventListener("state", (event) => {
    errors = 0;
    ui.live = "sse";
    accept(JSON.parse((event as MessageEvent<string>).data) as Snapshot);
  });
  source.addEventListener("error", () => {
    errors += 1;
    if (errors >= 2) {
      source.close();
      startPolling();
    }
  });
}

/* Durations and uptimes tick between snapshots. */
setInterval(render, 1_000);
connect();
