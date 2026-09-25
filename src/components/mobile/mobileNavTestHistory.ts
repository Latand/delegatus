import type { MobileNavHost } from "./mobileNav";

/**
 * A model of the browser's same-document history for the phone's navigation
 * tests: a list of entries and a cursor. `pushState` truncates the forward
 * branch, URLs resolve against the entry they are written on, and a traversal
 * moves the cursor and lands with the entry's state, as `popstate` does. The
 * store's deferred work (a sheet's close) runs as a microtask unless the test
 * holds it with `hold` and runs it with `flush`. `assign` starts loading
 * another document, and a traversal asked for while it loads cancels the
 * load, as Chrome's does.
 */
export function fakeHistory(url = "http://localhost/#p=atlas", { hold = false, lateMs = 0, settleMs }: {
  hold?: boolean;
  /** A traversal lands this late, as on a busy main thread; zero lands inside the call. */
  lateMs?: number;
  /** How long the store waits for its own pop to land. */
  settleMs?: number;
} = {}) {
  const entries: { state: unknown; url: string }[] = [{ state: null, url }];
  let index = 0;
  let pushes = 0;
  const listeners = new Set<(state: unknown, event?: object) => void>();
  const deferred: Array<() => void> = [];
  let loading: string | null = null;
  const cancelled: string[] = [];
  const land = () => {
    const event = {};
    for (const listener of [...listeners]) listener(entries[index]!.state, event);
  };
  const resolve = (next: string | undefined) => (next === undefined ? entries[index]!.url : new URL(next, entries[index]!.url).href);
  const go = (delta: number) => {
    if (loading !== null) {
      cancelled.push(loading);
      loading = null;
    }
    const move = () => {
      const to = index + delta;
      if (delta === 0 || to < 0 || to >= entries.length) return;
      index = to;
      land();
    };
    if (lateMs > 0) setTimeout(move, lateMs);
    else move();
  };
  const host: MobileNavHost = {
    history: {
      get state() {
        return entries[index]!.state;
      },
      get length() {
        return entries.length;
      },
      pushState(state, _unused, next) {
        pushes += 1;
        const target = resolve(next);
        entries.splice(index + 1);
        entries.push({ state, url: target });
        index += 1;
      },
      replaceState(state, _unused, next) {
        entries[index] = { state, url: resolve(next) };
      },
      go,
    },
    href: () => entries[index]!.url,
    onPopstate(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    assign(next) {
      loading = resolve(next);
    },
    defer: hold ? (task) => { deferred.push(task); } : (task) => queueMicrotask(task),
    ...(settleMs === undefined ? {} : { settleMs }),
  };
  return {
    host,
    /** The platform's Back: one entry. */
    back: () => go(-1),
    forward: () => go(1),
    /** A fragment navigation the store did not write (a link, a notification).
        A browser queues its `popstate`; `{ quiet: true }` holds it back so a
        test can deliver it later with `deliver`. */
    navigate(next: string, { quiet = false }: { quiet?: boolean } = {}) {
      entries.splice(index + 1);
      entries.push({ state: null, url: resolve(next) });
      index += 1;
      if (!quiet) land();
    },
    /** Delivers a traversal event carrying `state`, as a late `popstate` does. */
    deliver(state: unknown) {
      const event = {};
      for (const listener of [...listeners]) listener(state, event);
    },
    /** Runs the store's held deferred work. */
    flush() {
      while (deferred.length) deferred.shift()!();
    },
    length: () => entries.length,
    index: () => index,
    url: () => entries[index]!.url,
    hash: () => new URL(entries[index]!.url).hash,
    state: () => entries[index]!.state,
    entries: () => entries.map((entry) => ({ ...entry })),
    pushes: () => pushes,
    /** The document `assign` is loading, until a traversal cancels it. */
    loading: () => loading,
    cancelled: () => [...cancelled],
    listening: () => listeners.size > 0,
  };
}
