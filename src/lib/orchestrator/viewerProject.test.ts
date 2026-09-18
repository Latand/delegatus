import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { projectIdentityFromRemote } from "@/lib/projects/identity";
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
 * The Viewer names itself the way the deploy refusal does (#1321): from the
 * canonical remote it is deployed from, `LLV_VIEWER_CANONICAL_REMOTE` when the
 * host configures one and the bundled repository metadata otherwise. So every
 * project here is an invented remote and no test depends on where this checkout
 * sits — and the packaged-release case below runs from a directory with no
 * `.git` above it at all. `LLV_STATE_DIR` points the alias resolver at an empty
 * directory for the same reason.
 */

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-viewer-project-"));
const STATE = path.join(SANDBOX, "state");
fs.mkdirSync(STATE, { recursive: true });

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const VIEWER_REMOTE = "https://example.invalid/team/the-viewer.git";
const OTHER_REMOTE = "https://example.invalid/team/another-product.git";
const VIEWER_PROJECT = projectIdentityFromRemote(VIEWER_REMOTE, SANDBOX)!.project;
const OTHER_PROJECT = projectIdentityFromRemote(OTHER_REMOTE, SANDBOX)!.project;

/** Runs `body` with the given remote standing in for the one the running Viewer
    is deployed from. Synchronous throughout, so no other test file can observe
    the environment this borrows. */
function asViewer<T>(remote: string, body: () => T): T {
  const previousRemote = process.env.LLV_VIEWER_CANONICAL_REMOTE;
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_VIEWER_CANONICAL_REMOTE = remote;
  process.env.LLV_STATE_DIR = STATE;
  try {
    return body();
  } finally {
    if (previousRemote === undefined) delete process.env.LLV_VIEWER_CANONICAL_REMOTE;
    else process.env.LLV_VIEWER_CANONICAL_REMOTE = previousRemote;
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

test("the predicate answers only for the project the Viewer is deployed from", () => {
  asViewer(VIEWER_REMOTE, () => {
    expect(viewerOwnProject()).toBe(VIEWER_PROJECT);
    expect(isViewerOwnProject(VIEWER_PROJECT)).toBe(true);
    expect(isViewerOwnProject(OTHER_PROJECT)).toBe(false);
    /* A delivery that names no project is not the Viewer's. */
    expect(isViewerOwnProject(null)).toBe(false);
    expect(isViewerOwnProject("")).toBe(false);
  });
});

/* Round 2 of #1745. The first predicate resolved the Viewer's project by
   walking up from the cwd for a `.git`, which the production image does not
   ship — so in a packaged release NOTHING resolved and the Viewer's own seat
   was denied its own section too. The resolver is now the one the deploy
   refusal uses, and it reads a remote rather than a checkout. */
test("in a packaged release with no .git the Viewer's own seat still receives the section, and a foreign seat does not", () => {
  const release = path.join(SANDBOX, "opt", "agent-log-viewer");
  fs.mkdirSync(release, { recursive: true });
  /* The layout a release runs from: server bundle, manifest, no repository. */
  fs.writeFileSync(path.join(release, "server.js"), "// bundled\n");
  expect(fs.existsSync(path.join(release, ".git"))).toBe(false);

  const previousCwd = process.cwd();
  process.chdir(release);
  try {
    /* Nothing above the release directory is a checkout either. */
    for (let directory = release; ; directory = path.dirname(directory)) {
      expect(fs.existsSync(path.join(directory, ".git"))).toBe(false);
      if (directory === path.dirname(directory)) break;
    }

    asViewer(VIEWER_REMOTE, () => {
      expect(viewerOwnProject()).toBe(VIEWER_PROJECT);

      const own = deliveredTo(ORCHESTRATOR_SYSTEM_PROMPT, VIEWER_PROJECT);
      expect(sections(own)).toBe(1);
      expect(own).toContain(ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE);

      const foreign = deliveredTo(ORCHESTRATOR_SYSTEM_PROMPT, OTHER_PROJECT);
      expect(sections(foreign)).toBe(0);
      expect(foreign).not.toContain("deploy_exact_sha");
    });
  } finally {
    process.chdir(previousCwd);
  }
});

test("the Viewer's own seat is delivered the deploy section exactly once", () => {
  asViewer(VIEWER_REMOTE, () => {
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
  asViewer(VIEWER_REMOTE, () => {
    const delivered = deliveredTo(reworded, VIEWER_PROJECT);
    expect(sections(delivered)).toBe(1);
    expect(delivered).toStartWith(reworded);
    expect(delivered).not.toContain(ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE);
  });
});

test("another project's delivered mandate carries no section under that heading", () => {
  asViewer(VIEWER_REMOTE, () => {
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
  asViewer(VIEWER_REMOTE, () => {
    const stripped = deliveredTo(stored, OTHER_PROJECT);
    expect(sections(stripped)).toBe(0);
    expect(stripped).not.toContain("Ask me first, then push the tag yourself.");
    expect(stripped).toContain("## Fences\n- one lane per issue");
  });
});

test("a retry of the same delivery appends nothing more and strips nothing more", () => {
  const stored = `A seat's own mandate.\n\n${ORCHESTRATOR_VIEWER_DEPLOYS_DIRECTIVE}`;
  asViewer(VIEWER_REMOTE, () => {
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
  asViewer(VIEWER_REMOTE, () => {
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
  asViewer(VIEWER_REMOTE, () => {
    const preflight = preflightFor(ORCHESTRATOR_SYSTEM_PROMPT, "spawn", VIEWER_PROJECT);
    expect(preflight.ok).toBe(true);
    if (preflight.ok) {
      expect(MAX_STRUCTURED_TEXT_BYTES - preflight.bytes - preflight.overhead).toBeGreaterThan(HISTORY_BUDGET_BYTES);
    }
  });
});
