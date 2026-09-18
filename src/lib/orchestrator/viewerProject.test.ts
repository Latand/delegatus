import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";

import { HISTORY_BUDGET_BYTES, mandatePreflight } from "./handoffDigest";
import {
  ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE,
  ORCHESTRATOR_SYSTEM_PROMPT,
  ORCHESTRATOR_TASK_OWNERSHIP_HEADING,
  ORCHESTRATOR_VIEWER_CLOCK_HEADING,
  ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE,
  ORCHESTRATOR_VIEWER_DEPLOYS_HEADING,
  orchestratorMandateForDelivery,
} from "./prompt";
import { isViewerOwnProject, viewerOwnProject } from "./viewerProject";

/**
 * Issue #1745: the deploy section describes deploying Agent Log Viewer itself,
 * and every project's manager was receiving it. What is proved here is the
 * delivery decision and nothing about the prose: a seat's project either is the
 * Viewer's own — and then the section arrives exactly once — or it is not, and
 * then the delivered mandate carries no section under that heading, whatever
 * the stored mandate says.
 *
 * Both projects are invented repositories in a sandbox, named through
 * `LLV_VIEWER_REPOSITORY_ROOT`, so no test depends on where this checkout sits
 * or on the operator's own state. `LLV_STATE_DIR` points the alias resolver at
 * an empty directory for the same reason.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-project-"));
const STATE = path.join(SANDBOX, "state");
fs.mkdirSync(STATE, { recursive: true });

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

function repositoryAt(name: string, remote: string): string {
  const root = path.join(SANDBOX, name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n  url = ${remote}\n`);
  return root;
}

const VIEWER_ROOT = repositoryAt("viewer-checkout", "https://example.invalid/team/the-viewer.git");
const OTHER_ROOT = repositoryAt("other-checkout", "https://example.invalid/team/another-product.git");
const VIEWER_PROJECT = projectIdentityFromRepositoryRoot(VIEWER_ROOT)!.project;
const OTHER_PROJECT = projectIdentityFromRepositoryRoot(OTHER_ROOT)!.project;

/** Runs `body` with the given checkout standing in for the running Viewer's
    own. Synchronous throughout, so no other test file can observe the
    environment this borrows. */
function asViewer<T>(root: string | null, body: () => T): T {
  const previousRoot = process.env.LLV_VIEWER_REPOSITORY_ROOT;
  const previousState = process.env.LLV_STATE_DIR;
  if (root === null) delete process.env.LLV_VIEWER_REPOSITORY_ROOT;
  else process.env.LLV_VIEWER_REPOSITORY_ROOT = root;
  process.env.LLV_STATE_DIR = STATE;
  try {
    return body();
  } finally {
    if (previousRoot === undefined) delete process.env.LLV_VIEWER_REPOSITORY_ROOT;
    else process.env.LLV_VIEWER_REPOSITORY_ROOT = previousRoot;
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
}

/** Delivery as a seat of `project` receives it: the composition every server
    caller makes, since `prompt.ts` is imported by client surfaces too and does
    not reach the repository itself. */
function deliveredTo(mandate: string, project: string): string {
  return orchestratorMandateForDelivery(mandate, { viewerSeat: isViewerOwnProject(project) });
}

/** The preflight a seat of `project` is measured by, resolved the same way. */
function preflightFor(mandate: string, mode: "spawn" | "existing", project: string) {
  return mandatePreflight(mandate, mode, { mode: "standard" }, { viewerSeat: isViewerOwnProject(project) });
}

/** Sections, not substrings: the heading is recognized as a whole line. */
function sections(mandate: string): number {
  return mandate.split("\n").filter((line) => line.trimEnd() === ORCHESTRATOR_VIEWER_DEPLOYS_HEADING).length;
}

test("the predicate answers only for the project of the checkout the Viewer runs from", () => {
  asViewer(VIEWER_ROOT, () => {
    expect(viewerOwnProject()).toBe(VIEWER_PROJECT);
    expect(isViewerOwnProject(VIEWER_PROJECT)).toBe(true);
    expect(isViewerOwnProject(OTHER_PROJECT)).toBe(false);
    /* A delivery that names no project is not the Viewer's. */
    expect(isViewerOwnProject(null)).toBe(false);
    expect(isViewerOwnProject("")).toBe(false);
  });
});

test("a release that cannot name its own checkout claims no project at all", () => {
  /* A directory with no repository above it: `projectIdentityFromRepositoryRoot`
     has nothing to read, and the answer is no for everyone rather than yes for
     someone. */
  const bare = path.join(SANDBOX, "not-a-repository");
  fs.mkdirSync(bare, { recursive: true });
  asViewer(bare, () => {
    expect(viewerOwnProject()).toBeNull();
    expect(isViewerOwnProject(VIEWER_PROJECT)).toBe(false);
    expect(isViewerOwnProject(OTHER_PROJECT)).toBe(false);
  });
});

test("the Viewer's own seat is delivered the deploy section exactly once", () => {
  asViewer(VIEWER_ROOT, () => {
    const delivered = deliveredTo(ORCHESTRATOR_SYSTEM_PROMPT, VIEWER_PROJECT);
    expect(sections(delivered)).toBe(1);
    expect(delivered).toContain(ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE);
    /* The every-project directives are unaffected by the scope. */
    expect(delivered).toContain(ORCHESTRATOR_TASK_OWNERSHIP_HEADING);
    expect(delivered).toContain(ORCHESTRATOR_VIEWER_CLOCK_HEADING);
    expect(delivered).toContain(ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE);
  });
});

test("a Viewer seat whose stored mandate already carries the section keeps one copy, in its own wording", () => {
  const reworded = `${ORCHESTRATOR_VIEWER_DEPLOYS_HEADING}\nDeploy whenever main is green. Nothing else changes.`;
  asViewer(VIEWER_ROOT, () => {
    const delivered = deliveredTo(reworded, VIEWER_PROJECT);
    expect(sections(delivered)).toBe(1);
    expect(delivered).toStartWith(reworded);
    expect(delivered).not.toContain(ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE);
  });
});

test("another project's delivered mandate carries no section under that heading", () => {
  asViewer(VIEWER_ROOT, () => {
    const fresh = deliveredTo(ORCHESTRATOR_SYSTEM_PROMPT, OTHER_PROJECT);
    expect(sections(fresh)).toBe(0);
    expect(fresh).not.toContain(ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE);

    /* The shape thirteen other projects are holding today: the section as it
       was, inside the body, followed by more mandate. */
    const stored = [
      "You run the conveyor for this project.",
      "",
      ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE,
      "",
      "## Fences",
      "- Operate exclusively through the viewer API and MCP tools.",
    ].join("\n");
    const stripped = deliveredTo(stored, OTHER_PROJECT);
    expect(sections(stripped)).toBe(0);
    expect(stripped).not.toContain("deploy_exact_sha");
    /* Only up to the next heading: what followed the section is still there,
       and so is what preceded it. */
    expect(stripped).toContain("You run the conveyor for this project.");
    expect(stripped).toContain("## Fences\n- Operate exclusively through the viewer API and MCP tools.");
  });
});

test("a caller-reworded body under the heading is removed just the same", () => {
  const stored = [
    "Ship what the operator asks for.",
    "",
    ORCHESTRATOR_VIEWER_DEPLOYS_HEADING,
    "Ask me first, then push the tag yourself.",
    "",
    "## Fences",
    "- one lane per issue",
  ].join("\n");
  asViewer(VIEWER_ROOT, () => {
    const stripped = deliveredTo(stored, OTHER_PROJECT);
    expect(sections(stripped)).toBe(0);
    expect(stripped).not.toContain("Ask me first, then push the tag yourself.");
    expect(stripped).toContain("## Fences\n- one lane per issue");
  });
});

test("a retry of the same delivery appends nothing more and strips nothing more", () => {
  const stored = `A seat's own mandate.\n\n${ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE}`;
  asViewer(VIEWER_ROOT, () => {
    for (const project of [VIEWER_PROJECT, OTHER_PROJECT]) {
      for (const mandate of [ORCHESTRATOR_SYSTEM_PROMPT, stored]) {
        const once = deliveredTo(mandate, project);
        expect(deliveredTo(once, project)).toBe(once);
        expect(sections(once)).toBe(project === VIEWER_PROJECT ? 1 : 0);
      }
    }
  });
});

test("the delivery preflight counts the bytes the seat's own project receives", () => {
  asViewer(VIEWER_ROOT, () => {
    for (const project of [VIEWER_PROJECT, OTHER_PROJECT]) {
      const preflight = preflightFor(ORCHESTRATOR_SYSTEM_PROMPT, "existing", project);
      expect(preflight.ok).toBe(true);
      expect(preflight.bytes).toBe(
        Buffer.byteLength(deliveredTo(ORCHESTRATOR_SYSTEM_PROMPT, project), "utf8"),
      );
    }
    /* And the two really are different texts, so a count taken against the
       wrong project would be a count of bytes nobody is handed. */
    const viewer = preflightFor(ORCHESTRATOR_SYSTEM_PROMPT, "existing", VIEWER_PROJECT);
    const other = preflightFor(ORCHESTRATOR_SYSTEM_PROMPT, "existing", OTHER_PROJECT);
    expect(viewer.bytes).toBeGreaterThan(other.bytes);
  });
});

/* The Viewer's own seat is handed the largest delivery there is, and a rotation
   still has to fit its history and handoff beside it. Checked on that seat
   rather than on the every-project delivery, which is now the smaller one. */
test("the largest delivery — the Viewer's own seat — leaves a rotation its room", () => {
  asViewer(VIEWER_ROOT, () => {
    const preflight = preflightFor(ORCHESTRATOR_SYSTEM_PROMPT, "spawn", VIEWER_PROJECT);
    expect(preflight.ok).toBe(true);
    if (preflight.ok) {
      expect(MAX_STRUCTURED_TEXT_BYTES - preflight.bytes - preflight.overhead).toBeGreaterThan(HISTORY_BUDGET_BYTES);
    }
  });
});
