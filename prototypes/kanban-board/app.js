/* Kanban-board prototype — the whole implementation.

   What it demonstrates (issue: task board as status columns):
     - four columns, one per task status; the Assigned column is the workspace
       and keeps the band's internals (member tiles, stage graph) inside the card;
     - optimistic status moves (menu, drag, keyboard) with undo and rollback;
     - one control hides a whole group (card + members + pipeline section) with
       undo, a hidden tray, a protected project-manager card, and a hidden task
       that comes back by itself when it needs a decision;
     - inline title/description editing with saving state, failed-save rollback
       that keeps the draft, and an agent editing the same card concurrently;
     - a named colour label per task;
     - history as a per-card disclosure, the full drawer tucked behind it.

   Everything is local: `server` below is a fake with latency and scripted
   refusals. No network, no build step, no dependency. */

(function () {
  "use strict";

  const F = window.FIXTURE;
  const q = new URLSearchParams(location.search);
  const root = document.documentElement;
  const app = document.getElementById("app");
  const receiptsEl = document.getElementById("receipts");

  const STATUSES = ["inbox", "assigned", "blocked", "done"];
  const STATUS_LABEL = { inbox: "Inbox", assigned: "Assigned", blocked: "Blocked", done: "Done" };
  const STATUS_HINT = {
    inbox: "Not started yet",
    assigned: "Has, or is waiting for, an agent",
    blocked: "Needs something outside the task",
    done: "Finished. History stays.",
  };
  const EMPTY = {
    inbox: ["Nothing in the inbox", "New tasks land here."],
    assigned: ["Nothing in progress", "Move a task here or add an agent to one."],
    blocked: ["Nothing blocked", "Move a task here when it waits on something outside it."],
    done: ["Nothing finished yet", "Finished tasks keep their history here."],
  };

  const svg = (inner, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;
  const ICON = {
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    more: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
    lock: svg('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    chevR: svg('<path d="m9 6 6 6-6 6"/>', 'class="chev"'),
    chevD: svg('<path d="m6 9 6 6 6-6"/>', 'class="chev"'),
    check: svg('<path d="m5 12 5 5L20 7"/>', 'class="check"'),
    eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6 0 10 8 10 8a17.7 17.7 0 0 1-3.2 4.1"/><path d="M6.6 6.6C3.9 8.5 2 12 2 12s4 8 10 8a10.9 10.9 0 0 0 4.4-.9"/>'),
    out: svg('<path d="M7 17 17 7M8 7h9v9"/>'),
  };

  /* ── Configuration from the URL ─────────────────────────────────────────── */
  const cfg = {
    latency: Number(q.get("latency") ?? 500),
    fail: q.get("fail"), // any | status | hide | show | title | description | color
    bench: q.get("bench") === "1",
    scheme: q.get("scheme"),
    width: q.get("w"),
    motion: q.get("motion"),
  };
  if (cfg.scheme === "dark" || cfg.scheme === "light") root.dataset.theme = cfg.scheme;
  if (cfg.motion === "reduce") root.dataset.motion = "reduce";
  const motionMs = () => parseFloat(getComputedStyle(root).getPropertyValue("--motion-base")) || 0;

  /* ── The fake server: latency, scripted refusals, a protected card ──────── */
  const clone = (t) => ({ ...t, members: t.members.map((m) => ({ ...m })), history: t.history.map((h) => ({ ...h })), rev: 1, hiddenAt: null });
  const server = {
    tasks: new Map(F.tasks.map((t) => [t.id, clone(t)])),
    failNext: cfg.fail,
    latency: cfg.latency,
    log: [],
    patch(id, patch, kind) {
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          const t = server.tasks.get(id);
          server.log.push({ id, patch, kind });
          if (!t) return reject(new Error("task not found"));
          if ("hiddenAt" in patch && patch.hiddenAt && t.protectedReason) return reject(new Error(t.protectedReason));
          if (server.failNext && (server.failNext === "any" || server.failNext === kind)) {
            server.failNext = null;
            return reject(new Error("the server refused the change (revision changed elsewhere)"));
          }
          Object.assign(t, patch);
          t.rev += 1;
          resolve({ rev: t.rev });
        }, server.latency);
      });
    },
  };

  /* ── Client state ───────────────────────────────────────────────────────── */
  const state = {
    tasks: F.tasks.map(clone),
    filter: q.get("q") || "",
    editing: new Map(), // id -> { field, draft }
    failed: new Map(), // id -> { field, draft, message }
    incoming: new Map(), // id -> { field, value }
    pending: new Map(), // id -> in-flight count
    tab: STATUSES.includes(q.get("tab")) ? q.get("tab") : "assigned",
    open: null, // { kind, el, anchor, onClose }
    clock: 0,
    mode: "wide",
    dragging: null,
  };
  (q.get("hidden") || "").split(",").filter(Boolean).forEach((id) => { const t = task(id); if (t) { state.clock += 1; t.hiddenAt = state.clock; server.tasks.get(id).hiddenAt = state.clock; } });

  function task(id) { return state.tasks.find((t) => t.id === id) || null; }
  const titleOf = (t) => t.title || "Untitled task";
  const short = (t) => { const s = titleOf(t); return s.length > 48 ? s.slice(0, 46).trimEnd() + "…" : s; };
  const working = (t) => t.members.filter((m) => m.state === "working").length;
  const needs = (t) => Boolean(t.needsDecision) || t.members.some((m) => m.state === "needs you");
  const idle = (t) => !t.protectedReason && t.members.length === 0;
  const colorOf = (id) => F.colors.find((c) => c.id === id) || F.colors[0];
  const age = (min) => (min < 1 ? "now" : min < 60 ? `${min}m` : min < 60 * 24 ? `${Math.round(min / 60)}h` : `${Math.round(min / (60 * 24))}d`);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const matches = (t) => { const f = state.filter.trim().toLowerCase(); return !f || titleOf(t).toLowerCase().includes(f) || (t.description || "").toLowerCase().includes(f); };
  /* Needs-you first, then the most working, then the most recently touched. */
  const cmp = (a, b) => (Number(needs(b)) - Number(needs(a))) || (working(b) - working(a)) || (a.updatedMin - b.updatedMin);
  const visible = (status) => state.tasks.filter((t) => t.status === status && !t.hiddenAt);
  const hiddenTasks = () => state.tasks.filter((t) => t.hiddenAt);
  const incPending = (id) => state.pending.set(id, (state.pending.get(id) || 0) + 1);
  const decPending = (id) => { const n = (state.pending.get(id) || 1) - 1; if (n <= 0) state.pending.delete(id); else state.pending.set(id, n); };

  /* ── Receipts: the only place undo lives ────────────────────────────────── */
  let latestUndo = null;
  function showReceipt(text, action, opts = {}) {
    const el = document.createElement("div");
    el.className = "receipt" + (opts.error ? " error" : "");
    el.innerHTML = `<span class="msg"></span>${action ? '<button class="act" type="button" data-focus="receipt-act"></button>' : ""}<button class="close" type="button" aria-label="Dismiss">${ICON.x}</button><span class="bar-t"></span>`;
    el.querySelector(".msg").textContent = text;
    const ttl = opts.ttl ?? 7000;
    let timer = null;
    const close = () => { clearTimeout(timer); el.remove(); if (latestUndo && latestUndo.el === el) latestUndo = null; };
    if (action) {
      const b = el.querySelector(".act");
      b.textContent = action.label;
      b.addEventListener("click", () => { close(); action.run(); });
      if (action.label === "Undo") latestUndo = { el, run: action.run, close };
    }
    el.querySelector(".close").addEventListener("click", close);
    const bar = el.querySelector(".bar-t");
    bar.style.transition = `transform ${ttl}ms linear`;
    requestAnimationFrame(() => { bar.style.transform = "scaleX(0)"; });
    const arm = () => { clearTimeout(timer); timer = setTimeout(close, ttl); };
    el.addEventListener("pointerenter", () => clearTimeout(timer));
    el.addEventListener("pointerleave", arm);
    el.addEventListener("focusin", () => clearTimeout(timer));
    el.addEventListener("focusout", arm);
    receiptsEl.appendChild(el);
    while (receiptsEl.children.length > 3) receiptsEl.firstChild.remove();
    arm();
    return { el, close };
  }
  function undoLatest() { if (latestUndo) { const u = latestUndo; u.close(); u.run(); } }

  /* ── Optimistic mutation with rollback ─────────────────────────────────── */
  async function mutate(id, patch, opts = {}) {
    const t = task(id);
    if (!t) return false;
    const before = {};
    for (const k of Object.keys(patch)) before[k] = t[k];
    if (opts.touch) before.updatedMin = t.updatedMin;
    Object.assign(t, patch);
    if (opts.touch) t.updatedMin = 0;
    incPending(id);
    render();
    if (opts.receipt) {
      showReceipt(opts.receipt, opts.undo === false ? null : {
        label: "Undo",
        run: () => mutate(id, before, { kind: opts.kind, what: opts.what, receipt: opts.undoReceipt || "Undone", undo: false }),
      });
    }
    try {
      const res = await server.patch(id, patch, opts.kind);
      t.rev = res.rev;
      decPending(id);
      render();
      return true;
    } catch (err) {
      Object.assign(t, before);
      decPending(id);
      render();
      flash(id);
      if (opts.onFail) opts.onFail(err);
      else showReceipt(`Couldn't save ${opts.what || "the change"}: ${err.message}`, { label: "Retry", run: () => mutate(id, patch, opts) }, { error: true, ttl: 12000 });
      return false;
    }
  }
  function flash(id) { const el = app.querySelector(`.card[data-id="${id}"]`); if (!el) return; el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }

  /* ── Domain actions ─────────────────────────────────────────────────────── */
  function setStatus(id, status) {
    const t = task(id);
    if (!t || t.status === status) return;
    const from = t.status;
    void mutate(id, { status }, { kind: "status", what: "the status", touch: true, receipt: `Moved «${short(t)}» to ${STATUS_LABEL[status]}`, undoReceipt: `«${short(t)}» is back in ${STATUS_LABEL[from]}` });
  }
  function shiftStatus(id, delta) { const t = task(id); if (!t) return; const i = STATUSES.indexOf(t.status) + delta; if (i < 0 || i >= STATUSES.length) return; setStatus(id, STATUSES[i]); }
  function hideTask(id) {
    const t = task(id);
    if (!t || t.protectedReason) return;
    state.clock += 1;
    const w = working(t);
    void mutate(id, { hiddenAt: state.clock }, {
      kind: "hide", what: `hiding «${short(t)}»`,
      receipt: w ? `Hidden «${short(t)}» · ${plural(w, "agent keeps", "agents keep")} working` : `Hidden «${short(t)}»`,
      undoReceipt: `«${short(t)}» is back on the board`,
    });
  }
  function showTask(id) { const t = task(id); if (!t) return; void mutate(id, { hiddenAt: null }, { kind: "show", what: "showing the task", receipt: `«${short(t)}» is back on the board`, undo: false }); }
  async function hideMany(ids, text) {
    if (!ids.length) return;
    const before = new Map(ids.map((id) => [id, task(id).hiddenAt]));
    state.clock += 1;
    ids.forEach((id) => { task(id).hiddenAt = state.clock; incPending(id); });
    render();
    showReceipt(text, { label: "Undo", run: () => { ids.forEach((id) => void mutate(id, { hiddenAt: before.get(id) }, { kind: "show", undo: false })); showReceipt(`${plural(ids.length, "task is", "tasks are")} back on the board`); } });
    await Promise.all(ids.map(async (id) => {
      try { const r = await server.patch(id, { hiddenAt: task(id).hiddenAt }, "hide"); task(id).rev = r.rev; }
      catch (e) { task(id).hiddenAt = before.get(id); showReceipt(`Couldn't hide «${short(task(id))}»: ${e.message}`, null, { error: true }); }
      decPending(id);
    }));
    render();
  }
  function setColor(id, color) { const t = task(id); if (!t || t.color === color) return; void mutate(id, { color }, { kind: "color", what: "the colour" }); }

  /* Inline editing. The draft lives in state so a failed save can keep it. */
  function startEdit(id, field) { const t = task(id); if (!t) return; state.failed.delete(id); state.editing.set(id, { field, draft: field === "title" ? t.title : (t.description || "") }); render(); const ed = app.querySelector(`.card[data-id="${id}"] .edit`); if (ed) { ed.focus(); ed.setSelectionRange(ed.value.length, ed.value.length); } }
  function cancelEdit(id) { state.editing.delete(id); render(); focusCard(id); }
  async function commitEdit(id) {
    const e = state.editing.get(id);
    if (!e) return;
    const t = task(id);
    const value = e.draft.trim();
    state.editing.delete(id);
    if (e.field === "title" && !value) { state.failed.set(id, { field: "title", draft: e.draft, message: "A task needs a title." }); render(); return; }
    const current = e.field === "title" ? t.title : (t.description || "");
    if (value === current) { render(); return; }
    await saveField(id, e.field, value);
  }
  async function saveField(id, field, value) {
    const patch = field === "title" ? { title: value, namePending: false } : { description: value };
    const ok = await mutate(id, patch, { kind: field, what: `the ${field}`, touch: true, onFail: (err) => { state.failed.set(id, { field, draft: value, message: err.message }); render(); } });
    if (ok) { state.failed.delete(id); state.incoming.delete(id); render(); }
  }
  function retryFailed(id) { const f = state.failed.get(id); if (!f) return; state.failed.delete(id); void saveField(id, f.field, f.draft); }
  function discardFailed(id) { state.failed.delete(id); render(); focusCard(id); }
  function focusCard(id) { const el = app.querySelector(`.card[data-id="${id}"]`); if (el) el.focus({ preventScroll: true }); }

  /* Simulations the bench (and the capture driver) can trigger. */
  function agentEditsCard(id) {
    const editingId = id || [...state.editing.keys()][0] || "t-export";
    const s = server.tasks.get(editingId);
    const t = task(editingId);
    if (!s || !t) return;
    const value = `${s.title.replace(/\s*\(agent revision\)$/, "")} (agent revision)`;
    s.title = value; s.rev += 1;
    const e = state.editing.get(editingId);
    if (e && e.field === "title") { state.incoming.set(editingId, { field: "title", value }); render(); return; }
    const old = t.title; t.title = value; t.rev = s.rev; render(); flash(editingId);
    showReceipt(`An agent renamed «${short({ title: old })}»`);
  }
  function hiddenTaskNeedsDecision() {
    const t = hiddenTasks().find((x) => !x.protectedReason);
    if (!t) { showReceipt("Hide a task first, then trigger this."); return; }
    const s = server.tasks.get(t.id);
    for (const x of [t, s]) {
      x.hiddenAt = null; x.needsDecision = true; x.updatedMin = 0;
      if (!x.members.length) x.members.push({ id: `${x.id}-decide`, role: "Implementer", engine: "codex", state: "needs you", latest: "Two branches match. Which one should win?", ageMin: 0 });
      else x.members[0].state = "needs you";
    }
    render(); flash(t.id);
    showReceipt(`«${short(t)}» is back on the board: it needs a decision`);
  }

  /* ── Menus, popovers, drawer ───────────────────────────────────────────── */
  function closeOpen() { if (!state.open) return; const o = state.open; state.open = null; o.el.remove(); if (o.onClose) o.onClose(); }
  document.addEventListener("pointerdown", (ev) => { if (state.open && !state.open.el.contains(ev.target) && !(state.open.anchor && state.open.anchor.contains(ev.target))) closeOpen(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && state.open) { const a = state.open.anchor; closeOpen(); if (a && a.isConnected) a.focus(); } });

  function place(el, anchor, align = "end") {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function openMenu(anchor, items, label) {
    closeOpen();
    const menu = document.createElement("div");
    menu.className = "menu"; menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", label);
    for (const it of items) {
      if (it.type === "sep") { menu.insertAdjacentHTML("beforeend", '<div class="sep" role="separator"></div>'); continue; }
      if (it.type === "head") { const h = document.createElement("div"); h.className = "head"; h.textContent = it.label; menu.appendChild(h); continue; }
      if (it.type === "swatches") {
        const g = document.createElement("div"); g.className = "swatches"; g.setAttribute("role", "group"); g.setAttribute("aria-label", "Colour");
        for (const c of F.colors) {
          const b = document.createElement("button"); b.type = "button"; b.className = "swatch"; b.setAttribute("role", "menuitemradio");
          b.setAttribute("aria-checked", String(c.id === it.value)); b.setAttribute("aria-label", c.name); b.title = c.name;
          if (c.hex) b.style.setProperty("--c", c.hex); else b.dataset.none = "1";
          b.addEventListener("click", () => { closeOpen(); it.onPick(c.id); anchor.focus(); });
          g.appendChild(b);
        }
        menu.appendChild(g); continue;
      }
      const b = document.createElement("button"); b.type = "button";
      b.setAttribute("role", it.type === "radio" ? "menuitemradio" : "menuitem");
      if (it.type === "radio") b.setAttribute("aria-checked", String(Boolean(it.checked)));
      if (it.disabled) b.setAttribute("aria-disabled", "true");
      if (it.danger) b.classList.add("danger");
      b.innerHTML = `${it.status ? `<span class="st" data-status="${it.status}"></span>` : ""}${it.type === "radio" ? ICON.check : ""}<span class="lbl"></span>${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ""}`;
      const lbl = b.querySelector(".lbl"); lbl.textContent = it.label;
      if (it.why) { const w = document.createElement("span"); w.className = "why"; w.textContent = it.why; lbl.appendChild(w); }
      b.addEventListener("click", () => { if (it.disabled) return; closeOpen(); it.onSelect(); if (anchor.isConnected) anchor.focus(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    place(menu, anchor, "end");
    state.open = { kind: "menu", el: menu, anchor };
    const focusables = () => [...menu.querySelectorAll('[role^="menuitem"]')].filter((x) => x.getAttribute("aria-disabled") !== "true");
    focusables()[0]?.focus();
    menu.addEventListener("keydown", (ev) => {
      const list = focusables(); const i = list.indexOf(document.activeElement);
      if (ev.key === "ArrowDown" || ev.key === "ArrowRight") { ev.preventDefault(); list[(i + 1) % list.length]?.focus(); }
      else if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") { ev.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
      else if (ev.key === "Home") { ev.preventDefault(); list[0]?.focus(); }
      else if (ev.key === "End") { ev.preventDefault(); list[list.length - 1]?.focus(); }
      else if (ev.key === "Tab") { ev.preventDefault(); closeOpen(); anchor.focus(); }
    });
    return menu;
  }

  function statusItems(t, includeHints) {
    return STATUSES.map((s) => ({ type: "radio", status: s, label: STATUS_LABEL[s], why: includeHints ? STATUS_HINT[s] : null, checked: t.status === s, onSelect: () => setStatus(t.id, s) }));
  }
  function openStatusMenu(t, anchor) { openMenu(anchor, [{ type: "head", label: "Move to" }, ...statusItems(t, true), { type: "sep" }, { type: "item", label: "Previous column", kbd: "[", onSelect: () => shiftStatus(t.id, -1), disabled: t.status === "inbox" }, { type: "item", label: "Next column", kbd: "]", onSelect: () => shiftStatus(t.id, 1), disabled: t.status === "done" }], `Status of ${titleOf(t)}`); }
  function openCardMenu(t, anchor) {
    const w = working(t);
    openMenu(anchor, [
      { type: "head", label: "Move to" }, ...statusItems(t, false),
      { type: "sep" },
      { type: "head", label: "Colour" }, { type: "swatches", value: t.color, onPick: (c) => setColor(t.id, c) },
      { type: "sep" },
      { type: "item", label: "Rename", kbd: "Enter", onSelect: () => startEdit(t.id, "title") },
      { type: "item", label: t.description ? "Edit description" : "Add a description", kbd: "E", onSelect: () => startEdit(t.id, "description") },
      { type: "item", label: "Add an agent", onSelect: () => showReceipt("Opens the launch form with this task selected (not part of this prototype)") },
      { type: "item", label: "Open full history", onSelect: () => openDrawer(t.id) },
      { type: "sep" },
      t.protectedReason
        ? { type: "item", label: "Hide from board", why: t.protectedReason, disabled: true, onSelect: () => {} }
        : { type: "item", label: "Hide from board", kbd: "H", why: w ? `${plural(w, "agent keeps", "agents keep")} working. History stays.` : "Nothing stops. History stays. Comes back by itself when it needs you.", onSelect: () => hideTask(t.id) },
    ], `Actions for ${titleOf(t)}`);
  }
  function openColumnMenu(status, anchor) {
    const items = [];
    if (status === "assigned") { const ids = visible("assigned").filter(idle).map((t) => t.id); items.push({ type: "item", label: `Hide idle tasks (${ids.length})`, why: "Assigned tasks with no agent on them. One undo brings them all back.", disabled: !ids.length, onSelect: () => hideMany(ids, `Hidden ${plural(ids.length, "idle task", "idle tasks")}`) }); }
    if (status === "done") {
      const all = visible("done").filter((t) => !t.protectedReason); const ids = all.filter((t) => !working(t)).map((t) => t.id); const kept = all.length - ids.length;
      items.push({ type: "item", label: `Hide finished tasks (${ids.length})`, why: kept ? `Keeps ${plural(kept, "task", "tasks")} whose agent is still working.` : "History stays in the task list.", disabled: !ids.length, onSelect: () => hideMany(ids, `Hidden ${plural(ids.length, "finished task", "finished tasks")}${kept ? ` · kept ${kept} with a working agent` : ""}`) });
    }
    const hidden = hiddenTasks().length;
    items.push({ type: "item", label: `Show hidden tasks (${hidden})`, disabled: !hidden, onSelect: () => openTray(app.querySelector('[data-focus="hidden-pill"]') || anchor) });
    openMenu(anchor, items, `${STATUS_LABEL[status]} column`);
  }

  function openTray(anchor) {
    closeOpen();
    const pop = document.createElement("div"); pop.className = "popover"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Hidden tasks");
    const list = hiddenTasks();
    pop.innerHTML = `<div class="head">Hidden tasks <span class="n">· ${list.length}</span></div>`;
    for (const t of list) {
      const row = document.createElement("div"); row.className = "row";
      const w = working(t);
      row.innerHTML = `<span class="pill" data-status="${t.status}" style="pointer-events:none">${STATUS_LABEL[t.status]}</span><span class="t"><span class="title"></span><span class="meta">${w ? `<span class="working">${plural(w, "agent", "agents")} working</span> · ` : ""}${plural(t.members.length, "conversation", "conversations")} · ${plural(t.history.length, "attempt", "attempts")}</span></span><button type="button" class="show">Show</button>`;
      row.querySelector(".title").textContent = titleOf(t);
      row.querySelector(".show").addEventListener("click", () => { closeOpen(); showTask(t.id); });
      pop.appendChild(row);
    }
    pop.insertAdjacentHTML("beforeend", `<p class="note">${list.length ? "Hidden tasks keep their agents and history. A task comes back by itself when it needs you." : "Nothing is hidden. Use × on a card, or a column's menu."}</p>`);
    document.body.appendChild(pop); place(pop, anchor, "end");
    state.open = { kind: "tray", el: pop, anchor };
    pop.querySelector("button")?.focus();
  }

  function openDrawer(id) {
    closeOpen();
    const t = task(id); if (!t) return;
    const d = document.createElement("aside"); d.className = "drawer"; d.setAttribute("role", "dialog"); d.setAttribute("aria-modal", "false"); d.setAttribute("aria-label", `History of ${titleOf(t)}`);
    d.innerHTML = `<header><h2></h2><button type="button" class="icon-btn" aria-label="Close history">${ICON.x}</button></header><div class="body">
      <p style="margin:0;font-size:var(--text-ui);color:var(--color-secondary)"><span class="pill" data-status="${t.status}" style="pointer-events:none">${STATUS_LABEL[t.status]}</span> &nbsp;${plural(t.members.length, "conversation", "conversations")} · ${plural(t.history.length, "recorded attempt", "recorded attempts")}</p>
      <section><h3>Original requirement</h3><div class="req"></div></section>
      <section><h3>Attempts and reviews</h3>${t.history.length ? "<ol></ol>" : '<p style="margin:0;font-size:var(--text-ui);color:var(--color-muted)">No attempt recorded yet.</p>'}</section>
      <p style="margin:0;font-size:var(--text-label);color:var(--color-muted)">Release and merge records appear here when the task's pipeline publishes.</p></div>`;
    d.querySelector("h2").textContent = titleOf(t);
    d.querySelector(".req").textContent = [t.title, t.description].filter(Boolean).join("\n\n") || "Name pending — the agent's first action names the task.";
    const ol = d.querySelector("ol");
    if (ol) for (const h of t.history) { const li = document.createElement("li"); li.innerHTML = `<span class="lbl"></span><span class="st"></span><span class="when"></span>`; li.querySelector(".lbl").textContent = h.label; li.querySelector(".st").textContent = h.state + (h.verdict ? ` · ${h.verdict}` : ""); li.querySelector(".when").textContent = `${age(h.ageMin)} ago`; ol.appendChild(li); }
    d.querySelector("header button").addEventListener("click", () => { closeOpen(); focusCard(id); });
    document.body.appendChild(d);
    state.open = { kind: "drawer", el: d, anchor: null };
    d.querySelector("header button").focus();
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */
  const el = (tag, attrs = {}, html) => { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : v); if (html !== undefined) n.innerHTML = html; return n; };
  const text = (tag, attrs, content) => { const n = el(tag, attrs); n.textContent = content; return n; };

  /* Four columns fit as a grid from 1200 px (3 × 220 + 440 + gaps); below that
     the board is a snapping horizontal scroller, and below 768 px a tab strip. */
  function layoutMode(w) { return w >= 1400 ? "wide" : w >= 1200 ? "narrow" : w >= 768 ? "scroll" : "tabs"; }

  function render() {
    const rects = new Map(); app.querySelectorAll(".card[data-id]").forEach((c) => rects.set(c.dataset.id, c.getBoundingClientRect()));
    const focusKey = document.activeElement && app.contains(document.activeElement) ? (document.activeElement.closest("[data-focus]")?.dataset.focus ?? null) : null;
    const caret = document.activeElement && document.activeElement.classList?.contains("edit") ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const scrolls = new Map(); app.querySelectorAll(".col-body").forEach((b) => scrolls.set(b.dataset.status, b.scrollTop));

    const frag = document.createDocumentFragment();
    frag.appendChild(renderBar());
    frag.appendChild(renderBoard());
    app.replaceChildren(frag);

    app.querySelectorAll(".col-body").forEach((b) => { if (scrolls.has(b.dataset.status)) b.scrollTop = scrolls.get(b.dataset.status); });
    if (focusKey) {
      const f = app.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
      if (f && (!app.contains(document.activeElement) || (document.activeElement !== f && !document.activeElement.classList.contains("edit")))) f.focus({ preventScroll: true });
      if (f && caret && f.classList.contains("edit") && typeof f.setSelectionRange === "function") { try { f.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ } }
    }
    flip(rects);
    app.dataset.ready = "1";
  }

  function flip(before) {
    if (!motionMs()) return;
    app.querySelectorAll(".card[data-id]").forEach((c) => {
      const b = before.get(c.dataset.id);
      if (!b) { c.classList.add("enter"); return; }
      const a = c.getBoundingClientRect(); const dx = b.left - a.left, dy = b.top - a.top;
      if ((!dx && !dy) || Math.abs(dx) + Math.abs(dy) > 2000) return;
      c.style.transition = "none"; c.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => { c.style.transition = ""; c.style.transform = ""; });
    });
  }

  function renderBar() {
    const all = state.tasks.filter((t) => !t.hiddenAt);
    const w = all.reduce((n, t) => n + working(t), 0);
    const n = all.filter(needs).length;
    const hidden = hiddenTasks().length;
    const bar = el("header", { class: "bar" });
    bar.appendChild(text("span", { class: "project" }, F.project));
    const sum = el("span", { class: "summary" });
    sum.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="num">${plural(w, "agent", "agents")} working</span>${n ? `<span aria-hidden="true">·</span><span class="dot warn" aria-hidden="true"></span><span class="num">${n} ${n === 1 ? "needs" : "need"} you</span>` : ""}<span aria-hidden="true">·</span><span class="num">${plural(all.length, "task", "tasks")} on the board</span>`;
    bar.appendChild(sum);
    bar.appendChild(el("span", { class: "grow" }));
    /* Creation stays beside the title on every width; the search and the hidden
       tray take their own row when the bar is narrow. */
    const create = el("div", { class: "bar-create" });
    for (const [label, msg] of [["Task", "Creates a task in the Inbox column (not part of this prototype)"], ["Agent", "Opens the launch form; the new agent gets a placeholder task (not part of this prototype)"]]) {
      const b = el("button", { type: "button", class: "btn" }, `<span class="plus" aria-hidden="true">+</span> ${label}`);
      b.addEventListener("click", () => showReceipt(msg));
      create.appendChild(b);
    }
    const tools = el("div", { class: "bar-tools" });
    const search = el("label", { class: "search" }, `${ICON.search}<input type="search" placeholder="Find a task" aria-label="Find a task" data-focus="search">`);
    const input = search.querySelector("input"); input.value = state.filter;
    input.addEventListener("input", () => { state.filter = input.value; render(); });
    tools.appendChild(search);
    const pill = el("button", { type: "button", class: "btn hidden-pill", "data-count": String(hidden), "data-focus": "hidden-pill", "aria-label": `${plural(hidden, "hidden task", "hidden tasks")}` }, `${ICON.eyeOff} Hidden <span class="count num">${hidden}</span>`);
    pill.addEventListener("click", () => openTray(pill));
    tools.appendChild(pill);
    if (state.mode === "wide" || state.mode === "narrow") { bar.appendChild(tools); bar.appendChild(create); }
    else { bar.appendChild(create); bar.appendChild(tools); }
    return bar;
  }

  function renderBoard() {
    const board = el("div", { class: `board ${state.mode === "wide" ? "" : state.mode}`, "data-board": "", "data-mode": state.mode });
    if (state.mode === "tabs") {
      const nav = el("div", { class: "tabs-nav", role: "tablist", "aria-label": "Columns" });
      for (const s of STATUSES) {
        const b = el("button", { type: "button", role: "tab", "aria-selected": String(state.tab === s), "aria-controls": `col-${s}`, "data-focus": `tab:${s}` }, `${STATUS_LABEL[s]}<span class="n num">${visible(s).length}</span>`);
        b.addEventListener("click", () => { state.tab = s; render(); });
        nav.appendChild(b);
      }
      board.appendChild(nav);
      for (const s of STATUSES) board.appendChild(renderColumn(s));
      return board;
    }
    if (state.mode === "scroll") {
      /* A jump strip: the columns are one swipe apart, and the strip says so. */
      const wrap = el("div", { class: "scroll-wrap" });
      const nav = el("div", { class: "tabs-nav jump", "aria-label": "Columns" });
      for (const s of STATUSES) {
        const b = el("button", { type: "button", "aria-label": `Scroll to ${STATUS_LABEL[s]}`, "data-focus": `jump:${s}` }, `${STATUS_LABEL[s]}<span class="n num">${visible(s).length}</span>`);
        b.addEventListener("click", () => app.querySelector(`.column[data-status="${s}"]`)?.scrollIntoView({ inline: "start", block: "nearest", behavior: motionMs() ? "smooth" : "auto" }));
        nav.appendChild(b);
      }
      wrap.appendChild(nav);
      for (const s of STATUSES) board.appendChild(renderColumn(s));
      wrap.appendChild(board);
      return wrap;
    }
    for (const s of STATUSES) board.appendChild(renderColumn(s));
    return board;
  }

  function renderColumn(status) {
    const all = visible(status);
    const shown = all.filter(matches).sort(cmp);
    const w = all.reduce((n, t) => n + working(t), 0);
    const n = all.filter(needs).length;
    const section = el("section", { class: `column ${state.mode === "tabs" && state.tab === status ? "active" : ""}`, "data-status": status, id: `col-${status}`, "aria-labelledby": `h-${status}`, role: state.mode === "tabs" ? "tabpanel" : null });
    const head = el("div", { class: "col-head" });
    head.appendChild(text("h2", { id: `h-${status}` }, STATUS_LABEL[status]));
    head.appendChild(text("span", { class: "n num" }, state.filter ? `${shown.length} of ${all.length}` : String(all.length)));
    if (w) head.appendChild(text("span", { class: "live num" }, `${w} working`));
    if (n) head.appendChild(text("span", { class: "needs num" }, `${n} ${n === 1 ? "needs" : "need"} you`));
    head.appendChild(el("span", { class: "spacer" }));
    const menuBtn = el("button", { type: "button", class: "icon-btn", "aria-label": `${STATUS_LABEL[status]} column actions`, "aria-haspopup": "menu", "data-focus": `colmenu:${status}` }, ICON.more);
    menuBtn.addEventListener("click", () => openColumnMenu(status, menuBtn));
    head.appendChild(menuBtn);
    section.appendChild(head);

    const body = el("div", { class: "col-body", "data-status": status });
    if (!shown.length) {
      const [h, p] = EMPTY[status];
      body.appendChild(el("div", { class: "empty" }, `<strong></strong><span></span>`));
      body.querySelector("strong").textContent = state.filter ? "No match here" : h;
      body.querySelector("span").textContent = state.filter ? "Try a shorter search." : p;
    } else if (status === "assigned") {
      const active = shown.filter((t) => !idle(t)), rest = shown.filter(idle);
      active.forEach((t) => body.appendChild(renderCard(t, status)));
      if (rest.length) {
        const d = el("div", { class: "divider", role: "separator", "aria-label": `${rest.length} idle` }, `<span>Idle · <span class="num">${rest.length}</span></span>`);
        const hideAll = el("button", { type: "button", "data-focus": "hide-idle" }, "Hide idle"); hideAll.title = "Assigned tasks with no agent on them. One undo brings them all back.";
        hideAll.addEventListener("click", () => hideMany(rest.map((t) => t.id), `Hidden ${plural(rest.length, "idle task", "idle tasks")}`));
        d.appendChild(hideAll);
        body.appendChild(d);
        rest.forEach((t) => body.appendChild(renderCard(t, status)));
      }
    } else shown.forEach((t) => body.appendChild(renderCard(t, status)));
    section.appendChild(body);
    return section;
  }

  function renderCard(t, status) {
    const workspace = status === "assigned";
    const w = working(t), nd = needs(t);
    const c = colorOf(t.color);
    const card = el("article", { class: `card ${status === "done" ? "done" : ""} ${workspace ? "work" : "shelf"}`, "data-id": t.id, "data-focus": `card:${t.id}`, tabindex: "0", "data-pending": state.pending.has(t.id) ? "1" : "0", "data-color": t.color, "data-protected": t.protectedReason ? "1" : null, "aria-label": `${titleOf(t)}, ${STATUS_LABEL[status]}${w ? `, ${w} working` : ""}${nd ? ", needs you" : ""}${t.protectedReason ? ", stays on the board" : ""}` });
    card.style.setProperty("--label", c.hex || "transparent");
    if (c.hex) card.style.setProperty("--label-strong", c.hex);
    card.appendChild(el("span", { class: "label", "aria-hidden": "true" }));
    card.appendChild(el("span", { class: "saving", "aria-hidden": "true" }));

    /* Head: title (or its editor) and the two tools. */
    const head = el("div", { class: "head" });
    const e = state.editing.get(t.id);
    if (e && e.field === "title") head.appendChild(renderEditor(t, e));
    else {
      const b = el("button", { type: "button", class: `title ${t.namePending ? "pending" : ""}`, "data-focus": `title:${t.id}`, "aria-label": t.namePending ? "Untitled task, name pending. Rename" : `Rename: ${titleOf(t)}` });
      const clamp = document.createElement("span"); clamp.className = "clamp"; clamp.textContent = t.namePending ? "Untitled task" : t.title; b.appendChild(clamp);
      b.title = t.title.length > 80 ? t.title : "Click to rename";
      b.addEventListener("click", () => startEdit(t.id, "title"));
      head.appendChild(b);
    }
    const tools = el("div", { class: "tools" });
    if (t.protectedReason) tools.appendChild(el("span", { class: "icon-btn lock", role: "img", "aria-label": t.protectedReason, title: t.protectedReason, "data-lock": "" }, ICON.lock));
    else {
      const hide = el("button", { type: "button", class: "icon-btn hide", "data-hide": t.id, "aria-label": `Hide «${titleOf(t)}» from the board`, title: "Hide from board. Nothing stops; history stays.", "data-focus": `hide:${t.id}` }, ICON.x);
      hide.addEventListener("click", () => hideTask(t.id));
      tools.appendChild(hide);
    }
    const more = el("button", { type: "button", class: "icon-btn", "aria-label": `Actions for «${titleOf(t)}»`, "aria-haspopup": "menu", "data-menu": t.id, "data-focus": `menu:${t.id}` }, ICON.more);
    more.addEventListener("click", () => openCardMenu(t, more));
    tools.appendChild(more);
    head.appendChild(tools);
    card.appendChild(head);
    if (t.namePending && !(e && e.field === "title")) card.appendChild(text("p", { class: "pending-line" }, "Name pending · the agent's first action names it, or rename it here"));

    /* Description (or its editor). Shelves show it only when it exists. */
    if (e && e.field === "description") card.appendChild(renderEditor(t, e));
    else if (t.description || workspace) {
      const d = el("button", { type: "button", class: `desc ${t.description ? "" : "placeholder"}`, "data-focus": `desc:${t.id}`, "aria-label": t.description ? "Edit description" : "Add a description" });
      const clampD = document.createElement("span"); clampD.className = "clamp"; clampD.textContent = t.description || "Add a description"; d.appendChild(clampD);
      d.addEventListener("click", () => startEdit(t.id, "description"));
      card.appendChild(d);
    }

    /* Notices: failed save keeping the draft; an agent's concurrent edit. */
    const f = state.failed.get(t.id);
    if (f) {
      const n = el("div", { class: "notice error", role: "alert" }, `<span class="msg"></span><button type="button" data-focus="retry:${t.id}">Retry</button><button type="button">Discard</button>`);
      n.querySelector(".msg").textContent = `Not saved: ${f.message} Your text is kept.`;
      n.querySelectorAll("button")[0].addEventListener("click", () => retryFailed(t.id));
      n.querySelectorAll("button")[1].addEventListener("click", () => discardFailed(t.id));
      card.appendChild(n);
    }
    const inc = state.incoming.get(t.id);
    if (inc) {
      const n = el("div", { class: "notice info", role: "status" }, `<span class="msg"></span><button type="button">Use theirs</button><button type="button">Keep mine</button>`);
      n.querySelector(".msg").textContent = `An agent changed the ${inc.field} while you edit: «${inc.value}»`;
      n.querySelectorAll("button")[0].addEventListener("click", () => { const ed = state.editing.get(t.id); if (ed) ed.draft = inc.value; state.incoming.delete(t.id); render(); const input = app.querySelector(`.card[data-id="${t.id}"] .edit`); input?.focus(); });
      n.querySelectorAll("button")[1].addEventListener("click", () => { state.incoming.delete(t.id); render(); app.querySelector(`.card[data-id="${t.id}"] .edit`)?.focus(); });
      card.appendChild(n);
    }

    /* Activity: what is happening now. */
    const act = el("div", { class: "activity" });
    const parts = [];
    if (w) parts.push(`<span class="working num">${w} working</span>`);
    if (nd) parts.push(`<span class="needs">needs you</span>`);
    if (t.members.length) parts.push(`<span class="quiet num">${plural(t.members.length, "conversation", "conversations")}</span>`);
    else parts.push(`<span class="quiet">No agent on it</span>`);
    if (t.pipeline) { const planned = t.pipeline.stages.filter((s) => s.state === "planned").length; if (planned) parts.push(`<span class="quiet num">${planned} planned</span>`); }
    act.innerHTML = parts.join('<span class="sep" aria-hidden="true">·</span>');
    card.appendChild(act);

    if (t.pipeline) card.appendChild(renderPipeline(t));
    if (t.members.length) {
      const m = el("div", { class: "members", role: "list", "aria-label": "Conversations" });
      for (const mem of t.members) {
        const tile = el("button", { type: "button", role: "listitem", class: `tile ${mem.state === "working" ? "working" : ""} ${mem.state === "needs you" ? "needs" : ""}`, "aria-label": `${mem.role}, ${mem.state}: ${mem.latest}`, style: workspace ? "" : "width:100%" });
        tile.innerHTML = `<span class="row"><span class="engine ${mem.engine}" title="${mem.engine === "claude" ? "Claude" : "Codex"}"></span><span class="role"></span><span class="state ${mem.state === "needs you" ? "needs" : mem.state}"></span></span><span class="latest"></span><span class="age"></span>`;
        tile.querySelector(".role").textContent = mem.role; tile.querySelector(".state").textContent = mem.state; tile.querySelector(".latest").textContent = mem.latest; tile.querySelector(".age").textContent = `${age(mem.ageMin)} ago`;
        tile.addEventListener("click", () => showReceipt(`Opens the ${mem.role.toLowerCase()} conversation in place (not part of this prototype)`));
        m.appendChild(tile);
      }
      card.appendChild(m);
    }

    /* History: what happened. A disclosure, never the headline. */
    if (t.history.length) {
      const last = t.history[0];
      const det = el("details", { class: "history" });
      const sum = el("summary", { "data-focus": `history:${t.id}` }, `${ICON.chevR}<span class="lbl"></span>`);
      sum.querySelector(".lbl").textContent = `${last.label} · ${last.state} · ${age(last.ageMin)} ago${t.history.length > 1 ? ` · ${t.history.length - 1} earlier` : ""}`;
      det.appendChild(sum);
      const ul = el("ul");
      for (const h of t.history) { const li = el("li"); li.innerHTML = `<span class="lbl"></span><span class="verdict ${/approved|deployed|merged/.test(h.state + (h.verdict || "")) ? "ok" : /failed|died|changes/.test(h.state + (h.verdict || "")) ? "bad" : ""}"></span><span class="when"></span>`; li.querySelector(".lbl").textContent = h.label; li.querySelector(".verdict").textContent = h.state + (h.verdict ? ` · ${h.verdict}` : ""); li.querySelector(".when").textContent = `${age(h.ageMin)} ago`; ul.appendChild(li); }
      det.appendChild(ul);
      const more = el("button", { type: "button", class: "more" }, `Open full history ${ICON.out}`);
      more.addEventListener("click", () => openDrawer(t.id));
      det.appendChild(more);
      card.appendChild(det);
    }

    /* Foot: the status pill is the ONE place status is edited. */
    const foot = el("div", { class: "foot" });
    const pill = el("button", { type: "button", class: "pill", "data-status": status, "aria-haspopup": "menu", "aria-label": `Status: ${STATUS_LABEL[status]}. Change`, "data-focus": `status:${t.id}` }, `${STATUS_LABEL[status]} ${ICON.chevD}`);
    pill.addEventListener("click", () => openStatusMenu(t, pill));
    foot.appendChild(pill);
    foot.appendChild(text("span", { class: "age num", title: `Updated ${t.updatedMin < 1 ? "just now" : `${age(t.updatedMin)} ago`}` }, t.updatedMin < 1 ? "just now" : `${age(t.updatedMin)} ago`));
    foot.appendChild(el("span", { class: "spacer" }));
    const add = el("button", { type: "button", class: "add", "aria-label": `Add an agent to «${titleOf(t)}»`, "data-focus": `add:${t.id}` }, `<span class="plus" aria-hidden="true">+</span> Agent`);
    add.addEventListener("click", () => showReceipt("Opens the launch form with this task selected (not part of this prototype)"));
    foot.appendChild(add);
    card.appendChild(foot);

    attachCardBehaviour(card, t);
    return card;
  }

  function renderEditor(t, e) {
    const wrap = el("div", { class: "editor", style: "display:flex;flex-direction:column;gap:4px;flex:1;min-width:0" });
    const isTitle = e.field === "title";
    const field = isTitle ? el("input", { type: "text", class: "edit title-edit", "aria-label": "Task title", maxlength: "200", placeholder: "Task title", "data-focus": `edit:${t.id}` }) : el("textarea", { class: "edit desc-edit", rows: "2", "aria-label": "Task description", maxlength: "6000", placeholder: "What is this task about, in one or two sentences?", "data-focus": `edit:${t.id}` });
    field.value = e.draft;
    const grow = () => { if (!isTitle) { field.style.height = "auto"; field.style.height = `${Math.min(220, field.scrollHeight + 2)}px`; } };
    field.addEventListener("input", () => { e.draft = field.value; grow(); });
    field.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancelEdit(t.id); }
      else if (ev.key === "Enter" && (isTitle || ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); void commitEdit(t.id); }
      ev.stopPropagation();
    });
    /* A blur caused by a re-render (the editor's node was replaced) is not the
       operator leaving the field: the new editor carries the same draft. */
    field.addEventListener("blur", () => { setTimeout(() => { if (!field.isConnected) return; if (state.editing.get(t.id) === e && !wrap.contains(document.activeElement)) void commitEdit(t.id); }, 0); });
    wrap.appendChild(field);
    const hint = el("div", { class: "edit-hint" }, `<span>${isTitle ? "Enter saves · Esc cancels" : "⌘/Ctrl+Enter saves · Esc cancels"}</span><button type="button">Save</button><button type="button">Cancel</button>`);
    hint.querySelectorAll("button")[0].addEventListener("click", () => void commitEdit(t.id));
    hint.querySelectorAll("button")[1].addEventListener("click", () => cancelEdit(t.id));
    wrap.appendChild(hint);
    requestAnimationFrame(grow);
    return wrap;
  }

  function renderPipeline(t) {
    const p = t.pipeline;
    const sec = el("div", { class: "stage-section", role: "group", "aria-label": `Pipeline: ${p.goal}, ${p.progress}` });
    sec.innerHTML = `<div class="sec-head"><span class="kind">Pipeline</span><span class="goal"></span><span class="progress"></span></div><div class="graph"></div>`;
    sec.querySelector(".goal").textContent = p.goal; sec.querySelector(".progress").textContent = p.progress;
    const g = sec.querySelector(".graph");
    p.stages.forEach((s, i) => {
      if (i > 0) {
        const r = p.rounds.find((x) => x.after === p.stages[i - 1].id);
        g.appendChild(el("span", { class: `edge ${p.stages[i - 1].state === "planned" || s.state === "planned" ? "planned" : ""}`, "aria-hidden": "true" }));
        if (r) { g.appendChild(el("span", { class: `round ${r.verdict === "approved" ? "approved" : r.verdict === "changes" ? "changes" : "open"}`, title: r.verdict ? `${r.label} · ${r.verdict === "changes" ? "changes requested" : r.verdict}` : `${r.label} · in review` }, r.label)); g.appendChild(el("span", { class: `edge ${s.state === "planned" ? "planned" : ""}`, "aria-hidden": "true" })); }
      }
      const st = el("button", { type: "button", class: `stage ${s.state}`, "aria-label": `${s.name}, ${s.state}: ${s.detail}` });
      st.innerHTML = `<span class="name"></span><span class="detail"></span>`; st.querySelector(".name").textContent = s.name; st.querySelector(".detail").textContent = s.detail;
      st.addEventListener("click", () => showReceipt(`Opens the ${s.name.toLowerCase()} stage in place (not part of this prototype)`));
      g.appendChild(st);
    });
    if (p.failEdge) {
      const fe = el("div", { class: "fail-edge", "aria-label": `Planned fail edge: ${p.failEdge.label}` }, `<svg viewBox="0 0 400 14" preserveAspectRatio="none"><path d="M396 2 C 396 12, 380 12, 360 12 L 40 12 C 20 12, 4 12, 4 2" stroke="var(--border-strong)" stroke-dasharray="4 4" fill="none" stroke-width="1.5"/><path d="M0 4 L4 0 L8 4" stroke="var(--border-strong)" fill="none" stroke-width="1.5"/></svg><span class="lbl"></span>`);
      fe.querySelector(".lbl").textContent = p.failEdge.label; sec.appendChild(fe);
    }
    return sec;
  }

  /* ── Card behaviour: keyboard, drag ─────────────────────────────────────── */
  function attachCardBehaviour(card, t) {
    card.addEventListener("keydown", (ev) => {
      if (ev.target !== card) return;
      const k = ev.key;
      if (k === "Enter") { ev.preventDefault(); startEdit(t.id, "title"); }
      else if (k === "e" || k === "E") { ev.preventDefault(); startEdit(t.id, "description"); }
      else if (k === "h" || k === "H") { ev.preventDefault(); if (t.protectedReason) showReceipt(t.protectedReason); else hideTask(t.id); }
      else if (k === "[") { ev.preventDefault(); shiftStatus(t.id, -1); }
      else if (k === "]") { ev.preventDefault(); shiftStatus(t.id, 1); }
      else if (k === "s" || k === "S") { ev.preventDefault(); openStatusMenu(t, card.querySelector(".pill")); }
      else if (k === "m" || k === "M") { ev.preventDefault(); openCardMenu(t, card.querySelector("[data-menu]")); }
      else if (k === "c" || k === "C") { ev.preventDefault(); openMenu(card.querySelector("[data-menu]"), [{ type: "head", label: "Colour" }, { type: "swatches", value: t.color, onPick: (c) => setColor(t.id, c) }], "Colour"); }
      else if (k === "ArrowDown" || k === "ArrowUp") { ev.preventDefault(); const cards = [...card.closest(".col-body").querySelectorAll(".card")]; const i = cards.indexOf(card); cards[i + (k === "ArrowDown" ? 1 : -1)]?.focus(); }
      else if (k === "ArrowLeft" || k === "ArrowRight") {
        ev.preventDefault();
        const cols = [...app.querySelectorAll(".column")]; const ci = cols.indexOf(card.closest(".column")); const target = cols[ci + (k === "ArrowRight" ? 1 : -1)];
        if (!target) return;
        if (state.mode === "tabs") { state.tab = target.dataset.status; render(); }
        const rows = [...card.closest(".col-body").querySelectorAll(".card")]; const i = rows.indexOf(card);
        const dest = [...(app.querySelector(`.column[data-status="${target.dataset.status}"] .col-body`)?.querySelectorAll(".card") || [])];
        (dest[Math.min(i, dest.length - 1)] || app.querySelector(`[data-focus="colmenu:${target.dataset.status}"]`))?.focus();
      }
    });

    /* Pointer drag with a threshold; scrolling is untouched (touch-action: pan-y). */
    card.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0 || ev.pointerType === "touch") return;
      if (ev.target.closest("button, input, textarea, summary, details, [role=listitem], .stage, .tile")) return;
      if (state.editing.has(t.id)) return;
      const sx = ev.clientX, sy = ev.clientY; let started = false; let ghost = null; let hint = null; let over = null;
      const move = (e2) => {
        const dx = e2.clientX - sx, dy = e2.clientY - sy;
        if (!started) { if (Math.hypot(dx, dy) < 6) return; started = true; card.setPointerCapture(ev.pointerId); card.classList.add("dragging"); ghost = card.cloneNode(true); ghost.classList.add("ghost"); ghost.classList.remove("dragging"); ghost.style.setProperty("--w", `${card.offsetWidth}px`); ghost.setAttribute("aria-hidden", "true"); document.body.appendChild(ghost); hint = el("div", { class: "drag-hint" }, "Drop on a column to change its status · Esc cancels"); document.body.appendChild(hint); state.dragging = t.id; }
        const r = card.getBoundingClientRect();
        ghost.style.left = `${r.left + dx}px`; ghost.style.top = `${r.top + dy}px`;
        ghost.style.display = "none"; const under = document.elementFromPoint(e2.clientX, e2.clientY); ghost.style.display = "";
        const col = under ? under.closest(".column") : null;
        if (over && over !== col) over.classList.remove("drop");
        over = col; if (over && over.dataset.status !== t.status) over.classList.add("drop"); else if (over) over.classList.remove("drop");
      };
      const finish = (cancel) => {
        card.removeEventListener("pointermove", move); card.removeEventListener("pointerup", up); card.removeEventListener("pointercancel", cancelEv); document.removeEventListener("keydown", esc, true);
        if (!started) return;
        card.classList.remove("dragging"); ghost?.remove(); hint?.remove(); over?.classList.remove("drop"); state.dragging = null;
        if (!cancel && over && over.dataset.status !== t.status) setStatus(t.id, over.dataset.status);
      };
      const up = () => finish(false); const cancelEv = () => finish(true);
      const esc = (e3) => { if (e3.key === "Escape" && started) { e3.stopPropagation(); finish(true); } };
      card.addEventListener("pointermove", move); card.addEventListener("pointerup", up); card.addEventListener("pointercancel", cancelEv); document.addEventListener("keydown", esc, true);
    });
  }

  /* Global keys: undo, search. */
  document.addEventListener("keydown", (ev) => {
    if (ev.target.matches("input, textarea")) return;
    if ((ev.key === "u" || ev.key === "U") && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); undoLatest(); }
    if (ev.key === "/" ) { ev.preventDefault(); app.querySelector('[data-focus="search"]')?.focus(); }
    if ((ev.key === "z" || ev.key === "Z") && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); undoLatest(); }
  });

  /* ── Bench ─────────────────────────────────────────────────────────────── */
  function renderBench() {
    const bench = document.getElementById("bench");
    if (!cfg.bench) return;
    document.body.dataset.bench = "1"; bench.hidden = false;
    bench.innerHTML = `
      <label>Scheme <select data-b="scheme"><option value="">system</option><option value="light">light</option><option value="dark">dark</option></select></label>
      <label>Width <select data-b="width"><option value="">fill</option><option>1440</option><option>1280</option><option>1024</option><option>768</option><option>390</option></select></label>
      <label>Latency <input data-b="latency" type="number" min="0" step="100" style="width:70px;height:26px" value="${server.latency}"> ms</label>
      <label><input data-b="fail" type="checkbox"> Fail the next save</label>
      <label><input data-b="motion" type="checkbox"> Reduce motion</label>
      <button type="button" data-b="agent">Agent edits the card you're editing</button>
      <button type="button" data-b="decision">A hidden task asks for a decision</button>
      <button type="button" data-b="reset">Reset</button>`;
    const scheme = bench.querySelector('[data-b="scheme"]'); scheme.value = root.dataset.theme || ""; scheme.addEventListener("change", () => { if (scheme.value) root.dataset.theme = scheme.value; else delete root.dataset.theme; });
    const width = bench.querySelector('[data-b="width"]'); width.value = cfg.width || ""; width.addEventListener("change", () => applyWidth(width.value));
    bench.querySelector('[data-b="latency"]').addEventListener("change", (e) => { server.latency = Number(e.target.value) || 0; });
    bench.querySelector('[data-b="fail"]').addEventListener("change", (e) => { server.failNext = e.target.checked ? "any" : null; });
    bench.querySelector('[data-b="motion"]').addEventListener("change", (e) => { if (e.target.checked) root.dataset.motion = "reduce"; else delete root.dataset.motion; });
    bench.querySelector('[data-b="agent"]').addEventListener("click", () => agentEditsCard());
    bench.querySelector('[data-b="decision"]').addEventListener("click", () => hiddenTaskNeedsDecision());
    bench.querySelector('[data-b="reset"]').addEventListener("click", () => location.reload());
    /* The fail checkbox reflects a consumed refusal. */
    setInterval(() => { const cb = bench.querySelector('[data-b="fail"]'); if (cb && !server.failNext && cb.checked) cb.checked = false; }, 300);
  }
  function applyWidth(w) {
    const frame = document.getElementById("frame");
    if (w) { frame.style.width = `${w}px`; frame.style.margin = "0 auto"; frame.style.borderLeft = frame.style.borderRight = "1px solid var(--border-default)"; }
    else { frame.style.width = ""; frame.style.margin = ""; frame.style.borderLeft = frame.style.borderRight = ""; }
  }

  /* ── Boot ──────────────────────────────────────────────────────────────── */
  renderBench();
  if (cfg.width) applyWidth(cfg.width);
  state.mode = layoutMode(app.clientWidth || window.innerWidth);
  render();
  new ResizeObserver(() => { const m = layoutMode(app.clientWidth); if (m !== state.mode) { state.mode = m; render(); } }).observe(app);

  /* Deep links for the capture matrix. */
  if (q.get("edit")) { app.querySelector(`.card[data-id="${q.get("edit")}"]`)?.scrollIntoView({ block: "center" }); startEdit(q.get("edit"), "title"); }
  if (q.get("editdesc")) { app.querySelector(`.card[data-id="${q.get("editdesc")}"]`)?.scrollIntoView({ block: "center" }); startEdit(q.get("editdesc"), "description"); }
  const reveal = (a) => { a.closest(".card")?.scrollIntoView({ block: "center" }); return a; };
  if (q.get("menu")) { const id = q.get("menu"); const a = app.querySelector(`[data-menu="${id}"]`); if (a) openCardMenu(task(id), reveal(a)); }
  if (q.get("status")) { const id = q.get("status"); const a = app.querySelector(`.card[data-id="${id}"] .pill`); if (a) openStatusMenu(task(id), reveal(a)); }
  if (q.get("colmenu")) { const a = app.querySelector(`[data-focus="colmenu:${q.get("colmenu")}"]`); if (a) openColumnMenu(q.get("colmenu"), a); }
  if (q.get("tray") === "1") openTray(app.querySelector('[data-focus="hidden-pill"]') || app.querySelector(".bar"));
  if (q.get("drawer")) openDrawer(q.get("drawer"));
  if (q.get("history") === "open") app.querySelectorAll("details.history").forEach((d) => { d.open = true; });
  if (q.get("focus")) { const c = app.querySelector(`.card[data-id="${q.get("focus")}"]`); if (c) { c.scrollIntoView({ block: "center" }); c.focus({ preventScroll: true }); } }

  window.__proto = { state, server, cfg, task, setStatus, hideTask, showTask, hideMany, setColor, startEdit, commitEdit, cancelEdit, agentEditsCard, hiddenTaskNeedsDecision, undoLatest, render, working, needs, STATUSES };
})();
