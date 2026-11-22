import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { TranscriptWork } from "@/lib/board/attemptWork";
import { useAttemptWork, WORK_REFRESH_MS, type WantedWork, type WorkLoader, type WorkRead } from "./useAttemptWork";

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator });

const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) flushSync(() => root.unmount()); document.body.replaceChildren(); });

const evidence = (start: number): TranscriptWork => ({ windows: [[start, start + 60_000]], lastRecordAt: start + 60_000, complete: true });
const BASE = 1_800_000_000_000;

function mount(load: WorkLoader) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  let latest: ReadonlyMap<string, WorkRead> = new Map();
  const Probe = ({ wanted, nowMs }: { wanted: WantedWork[]; nowMs: number }) => { latest = useAttemptWork(wanted, nowMs, load); return null; };
  const render = (wanted: WantedWork[], nowMs: number) => flushSync(() => root.render(<Probe wanted={wanted} nowMs={nowMs} />));
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  return { render, settle, reads: () => latest, unmount: () => { flushSync(() => root.unmount()); roots.splice(roots.indexOf(root), 1); } };
}

test("a settled attempt is read once, a running one again at each 30-second step of the board clock, and ticks inside a step ask nothing", async () => {
  const asked: string[] = [];
  const view = mount(async identity => { asked.push(identity); return evidence(BASE + asked.length); });
  const wanted = [{ identity: "settled", settled: true }, { identity: "running", settled: false }];
  view.render(wanted, BASE);
  await view.settle();
  expect(asked.sort()).toEqual(["running", "settled"]);
  expect([...view.reads().keys()].sort()).toEqual(["running", "settled"]);
  view.render(wanted, BASE + 10_000);
  view.render([...wanted], BASE + WORK_REFRESH_MS - 1);
  await view.settle();
  expect(asked).toHaveLength(2);
  view.render(wanted, BASE + WORK_REFRESH_MS + 5);
  await view.settle();
  expect(asked.filter(id => id === "running")).toHaveLength(2);
  expect(asked.filter(id => id === "settled")).toHaveLength(1);
  // An attempt that joins the open rows later is read when it appears, and the others are not asked again.
  view.render([...wanted, { identity: "joined", settled: true }], BASE + WORK_REFRESH_MS + 6);
  await view.settle();
  expect(asked.filter(id => id === "joined")).toHaveLength(1);
  expect(asked.filter(id => id === "settled")).toHaveLength(1);
});

test("a failed read keeps what was known, answers unknown when nothing was, and is asked again at the next step", async () => {
  let fail = false;
  const asked: string[] = [];
  const view = mount(async identity => { asked.push(identity); if (fail) throw new Error("refused"); return evidence(BASE); });
  const wanted = [{ identity: "a", settled: false }, { identity: "b", settled: true }];
  view.render([wanted[0]!], BASE);
  await view.settle();
  const known = view.reads().get("a")!.work;
  expect(known?.complete).toBe(true);
  fail = true;
  view.render(wanted, BASE + WORK_REFRESH_MS);
  await view.settle();
  expect(view.reads().get("a")?.work).toEqual(known);
  expect(view.reads().get("b")).toEqual({ at: BASE + WORK_REFRESH_MS - (BASE % WORK_REFRESH_MS), work: null });
  fail = false;
  view.render(wanted, BASE + 2 * WORK_REFRESH_MS);
  await view.settle();
  // The settled attempt that failed is read again, now that the server answers.
  expect(view.reads().get("b")?.work?.complete).toBe(true);
  expect(asked.filter(id => id === "b")).toHaveLength(2);
});

test("an unread answer never replaces a known value, and a settled attempt that got one is asked again", async () => {
  const unread: TranscriptWork = { windows: [], lastRecordAt: null, complete: false };
  const answers: TranscriptWork[] = [evidence(BASE), unread, unread, evidence(BASE + 5_000)];
  const asked: string[] = [];
  const view = mount(async identity => { asked.push(identity); return answers.shift() ?? null; });
  const wanted = [{ identity: "a", settled: true }, { identity: "b", settled: true }];
  // "a" gets a complete answer first, so it is never asked again; "b" gets an unread one and nothing known before it.
  view.render([wanted[0]!], BASE);
  await view.settle();
  const known = view.reads().get("a")!.work;
  expect(known?.complete).toBe(true);
  view.render(wanted, BASE + WORK_REFRESH_MS);
  await view.settle();
  expect(view.reads().get("b")?.work).toEqual(unread);
  expect(view.reads().get("a")?.work).toBe(known);
  // The next step asks "b" again though its attempt settled; the complete answer then replaces the unread one.
  view.render(wanted, BASE + 2 * WORK_REFRESH_MS);
  await view.settle();
  expect(asked.filter(id => id === "b")).toHaveLength(2);
  expect(view.reads().get("b")?.work?.complete).toBe(false);
  view.render(wanted, BASE + 3 * WORK_REFRESH_MS);
  await view.settle();
  expect(view.reads().get("b")?.work?.complete).toBe(true);
  expect(asked.filter(id => id === "a")).toHaveLength(1);
});

test("a running attempt's unread answer keeps its known value", async () => {
  const unread: TranscriptWork = { windows: [], lastRecordAt: null, complete: false };
  const answers: TranscriptWork[] = [evidence(BASE), unread];
  const view = mount(async () => answers.shift() ?? null);
  const wanted = [{ identity: "live", settled: false }];
  view.render(wanted, BASE);
  await view.settle();
  const known = view.reads().get("live")!.work;
  view.render(wanted, BASE + WORK_REFRESH_MS);
  await view.settle();
  expect(view.reads().get("live")?.work).toBe(known);
});

test("unmounting abandons the reads in flight", async () => {
  let release: (work: TranscriptWork | null) => void = () => {};
  let signal: AbortSignal | null = null;
  const view = mount((_identity, abort) => { signal = abort; return new Promise(resolve => { release = resolve; }); });
  view.render([{ identity: "slow", settled: true }], BASE);
  view.unmount();
  expect(signal).not.toBeNull();
  expect((signal as unknown as AbortSignal).aborted).toBe(true);
  release(evidence(BASE));
  await new Promise(resolve => setTimeout(resolve, 5));
});
