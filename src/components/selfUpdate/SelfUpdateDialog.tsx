"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Z } from "@/components/layers";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLocale } from "@/lib/i18n";
import type { Snapshot } from "@/lib/selfUpdate/types";

import { OPEN_SELF_UPDATE_EVENT } from "./openSelfUpdate";
import { SelfUpdateView, type ViewActions, type ViewState } from "./SelfUpdateView";
import { useSelfUpdateFeed } from "./useSelfUpdateFeed";

/**
 * The Update surface (#2007): how this install updates itself, reached from
 * the rail menu and the phone's menus. One dialog on the desktop and a full
 * screen on the phone, like the setup guide beside it. The body is
 * `SelfUpdateView`; this shell owns the feed, the actions and the one thing a
 * surface served by the process it restarts has to handle: after "Restart
 * web" nothing answers for a while, and what answers afterwards is a newer
 * server than the one this page came from.
 */

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function useClock(offset: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now + offset;
}

export function SelfUpdateDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const feed = useSelfUpdateFeed();
  const s = feed.snapshot;
  const [armed, setArmed] = useState(false);
  const [openLogs, setOpenLogs] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [webRestart, setWebRestart] = useState<{ pid: number | null } | null>(null);
  const firstWebPid = useRef<number | null | undefined>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  const offset = s ? Date.parse(s.meta.serverTime) - Date.now() : 0;
  const now = useClock(Number.isFinite(offset) ? offset : 0);

  if (s && firstWebPid.current === undefined) firstWebPid.current = s.processes.web.pid;
  if (s?.busy === "restart-runtime-host" && armed) setArmed(false);

  /* A web restart is over once a different web process answers healthy. */
  const web = s?.processes.web;
  const replaced = Boolean(web && web.pid !== null && web.state === "healthy" && firstWebPid.current !== undefined && web.pid !== firstWebPid.current);
  useEffect(() => {
    if (webRestart && web && web.pid !== webRestart.pid && web.state === "healthy") setWebRestart(null);
  }, [webRestart, web]);

  const act = useCallback(async (key: string, path: string, body?: unknown) => {
    setPending((value) => new Set(value).add(key));
    setError(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await response.json().catch(() => null) as ({ error?: string; snapshot?: Snapshot } & Partial<Snapshot>) | null;
      if (!response.ok) setError(payload?.error ?? `Request failed (${response.status})`);
      const next = response.ok ? payload as Snapshot | null : payload?.snapshot;
      if (next && next.meta) feed.accept(next);
      return response.ok;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setPending((value) => {
        const copy = new Set(value);
        copy.delete(key);
        return copy;
      });
    }
  }, [feed]);

  const actions: ViewActions = {
    check: () => { void act("check", "/api/self-update/check"); },
    update: () => { void act("update", "/api/self-update/update", { key: newKey() }); },
    retry: () => { void act("update", "/api/self-update/update", { key: newKey(), retry: true }); },
    restartWeb: () => {
      const pid = s?.processes.web.pid ?? null;
      void act("restart-web", "/api/self-update/restart", { role: "web" }).then((ok) => { if (ok) setWebRestart({ pid }); });
    },
    armHost: () => {
      setArmed(true);
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[data-action="confirm-host"]')?.focus());
    },
    cancelHost: () => {
      setArmed(false);
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('[data-action="arm-host"]')?.focus());
    },
    confirmHost: () => {
      setArmed(false);
      void act("restart-runtime-host", "/api/self-update/restart", { role: "runtime-host", confirm: true });
    },
    toggleLog: (id) => setOpenLogs((value) => {
      const copy = new Set(value);
      if (copy.has(id)) copy.delete(id); else copy.add(id);
      return copy;
    }),
    reload: () => window.location.reload(),
  };

  const state: ViewState = {
    now,
    armed,
    openLogs,
    pending,
    error,
    waitingForWeb: webRestart !== null && (feed.offline || !web || web.pid === webRestart.pid),
    reloadTo: replaced ? (s?.serving.web?.short || s?.installed.short || null) : null,
  };

  /* Escape takes back an armed confirmation first, then closes. Tab stays
     inside the panel; focus returns to whatever opened it. */
  const escapeRef = useRef<() => void>(() => {});
  useEffect(() => { escapeRef.current = () => { if (armed) setArmed(false); else onClose(); }; });
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])"))
        .filter((element) => element.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (!inside || active === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const title = t("selfUpdate.title");
  const body = s
    ? <SelfUpdateView snapshot={s} live={feed.live} state={state} actions={actions} />
    : <p className="m-0 text-ui text-muted">{t("selfUpdate.loading")}</p>;

  if (isMobile) {
    return (
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-self-update-dialog="" className={`fixed inset-0 ${Z.modal} flex flex-col bg-canvas outline-none`}>
        <header className="shrink-0 border-b border-border bg-raised pt-[env(safe-area-inset-top)]">
          <div className="flex h-[52px] items-center gap-1 pl-4 pr-1">
            <span className="min-w-0 flex-1 truncate text-body font-semibold text-primary">{title}</span>
            <button type="button" aria-label={t("selfUpdate.close")} onClick={onClose} className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-muted active:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(24px+env(safe-area-inset-bottom))] pt-4">{body}</div>
      </div>
    );
  }

  return (
    <div className={`fixed inset-0 ${Z.modal} flex items-center justify-center bg-black/40 p-12`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-self-update-dialog="" className="flex h-[calc(100vh-96px)] max-h-[960px] w-[1120px] max-w-full flex-col overflow-hidden rounded-[12px] border border-border bg-canvas shadow-2 outline-none">
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border bg-raised px-4">
          <span className="min-w-0 flex-1 truncate text-title font-bold text-primary">{title}</span>
          <button type="button" aria-label={t("selfUpdate.close")} onClick={onClose} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-muted hover:bg-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">{body}</div>
      </div>
    </div>
  );
}

/** Mounted once in the Viewer; opens from the menus. */
export function SelfUpdateHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_SELF_UPDATE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SELF_UPDATE_EVENT, onOpen);
  }, []);
  if (!open) return null;
  return <SelfUpdateDialog onClose={() => setOpen(false)} />;
}
