/**
 * A failed element comparison stays a failure (#2182): React-rendered
 * happy-dom nodes print as one line through `domInspect.ts`, which the test
 * preload installs, so Bun's `toBe` reports the mismatch instead of losing it
 * while it formats the React tree hung on each node.
 *
 * The comparisons themselves run in `domInspect.comparison.fixture.tsx`, a
 * child this file owns. A formatter that blocks never hands control back to
 * its own process, so the bound on it lives here in the parent: the clock
 * starts when the child says it is comparing, and expiry stops the child.
 */
import { spawn } from "node:child_process";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { ownFixtureTree, stopFixtureTree } from "@/lib/testing/fixtureProcess";

import { describeNode } from "./domInspect";

const dom = new Window({ url: "http://localhost/" });
afterAll(async () => {
  await dom.happyDOM.abort();
});

const FIXTURE = path.join(import.meta.dir, "domInspect.comparison.fixture.tsx");
const HOOK = path.join(import.meta.dir, "domInspect.ts");
/* Start-up (Bun, happy-dom, React, 400 rows) is bounded apart from the
   comparison, so a slow start under load never reads as a slow formatter. */
const START_MS = 30_000;
const COMPARE_MS = 5_000;

type Run = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; expired: "start" | "compare" | null };

async function compareInChild(mode: "mismatch" | "identity" | "stall", hook = true): Promise<Run> {
  const child = ownFixtureTree(spawn(process.execPath, [...(hook ? ["--preload", HOOK] : []), FIXTURE, mode], { stdio: ["ignore", "pipe", "pipe"] }));
  let stdout = "", stderr = "";
  let expired: Run["expired"] = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (phase: "start" | "compare", ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => { expired = phase; void stopFixtureTree(child); }, ms);
  };
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject);
    /* close, after both pipes drain, so the failure text is whole. */
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  arm("start", START_MS);
  child.stdout!.on("data", (chunk) => {
    const before = stdout;
    stdout += String(chunk);
    if (!before.includes("comparing\n") && stdout.includes("comparing\n")) arm("compare", COMPARE_MS);
  });
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  try {
    const [code, signal] = await exited;
    return { code, signal, stdout, stderr, expired };
  } finally {
    clearTimeout(timer);
    await stopFixtureTree(child);
  }
}

test("toBe fails, naming both nodes, when two React-rendered elements differ", async () => {
  const run = await compareInChild("mismatch");
  expect(run.expired).toBeNull();
  expect(run.stdout).toBe("comparing\n");
  expect(run.code).toBe(1);
  expect(run.stderr).toContain('Expected: <li data-row="7" class="row">');
  expect(run.stderr).toContain("Received: <body>");
}, START_MS + COMPARE_MS + 5_000);

test("the same element still passes toBe, a different one passes .not, and .not refuses the same one", async () => {
  const run = await compareInChild("identity");
  expect(run).toMatchObject({ expired: null, code: 0, stdout: "comparing\ndone\n" });
}, START_MS + COMPARE_MS + 5_000);

test("a formatter that never returns is stopped from outside at the comparison deadline", async () => {
  const run = await compareInChild("stall");
  expect(run.expired).toBe("compare");
  expect(run.stdout).toBe("comparing\n");
  expect(run.code).toBeNull();
  expect(run.signal).not.toBeNull();
  expect(run.stderr).not.toContain("Expected:");
}, START_MS + COMPARE_MS + 5_000);

test("without the one-line form the same mismatch outlasts the deadline", async () => {
  const run = await compareInChild("mismatch", false);
  expect(run.expired).toBe("compare");
  expect(run.stdout).toBe("comparing\n");
  expect(run.signal).not.toBeNull();
}, START_MS + COMPARE_MS + 5_000);

test("a node describes itself in one line", () => {
  const element = dom.document.createElement("section");
  element.setAttribute("data-kanban-reader", "conversation_plain-1");
  element.setAttribute("class", "reader");
  element.setAttribute("style", "color: red");
  expect(describeNode(element as never)).toBe('<section data-kanban-reader="conversation_plain-1" class="reader">');
  element.setAttribute("aria-label", "x".repeat(60));
  expect(describeNode(element as never)).toBe(`<section data-kanban-reader="conversation_plain-1" class="reader" aria-label="${"x".repeat(40)}…">`);
  expect(describeNode(dom.document.createTextNode("Ready to review") as never)).toBe('#text "Ready to review"');
  expect(describeNode(dom.document as never)).toBe("#document");
});
