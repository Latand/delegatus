/* Invented, identity-free fixture for the kanban-board prototype.
   No real project, account, handle, path, commit or id appears here; every
   name is made up and every number is illustrative.

   Vocabulary is the product's: task status is one of
   inbox · assigned · blocked · done (src/lib/tasks/types.ts); a conversation's
   state word is one of working · needs you · waiting · queued · held ·
   finished (cardStatus.* / bands.*). Ages are minutes before "now" so the
   prototype can sort deterministically. */

window.FIXTURE = (function () {
  const F = {
    project: "atlas",
    nowLabel: "14:05",

    /* Named colour labels an operator can pick. The name is what the UI says;
       the hue is only a carrier. `none` is the default: a neutral card. */
    colors: [
      { id: "none", name: "No colour", hex: null },
      { id: "coral", name: "Coral", hex: "#e07a5f" },
      { id: "amber", name: "Amber", hex: "#d9a400" },
      { id: "lime", name: "Lime", hex: "#7cb342" },
      { id: "teal", name: "Teal", hex: "#1a9e8f" },
      { id: "sky", name: "Sky", hex: "#3d7fd6" },
      { id: "violet", name: "Violet", hex: "#8a63d2" },
      { id: "pink", name: "Pink", hex: "#d64f8a" },
      { id: "slate", name: "Slate", hex: "#7b8a99" },
    ],

    tasks: [
      /* ── Assigned ─────────────────────────────────────────────────────── */
      {
        id: "t-seat",
        title: "Project manager seat",
        description: "The Viewer's built-in manager for this project. Wakes on the seat tick and dispatches work.",
        status: "assigned",
        color: "none",
        protectedReason: "The project manager stays on the board. Rotate or stop it from the orchestrator panel.",
        updatedMin: 2,
        createdMin: 60 * 24 * 6,
        members: [
          { id: "c-seat", role: "Orchestrator", engine: "claude", state: "working", latest: "Reading the queue and the last verdicts", ageMin: 2 },
        ],
        history: [
          { label: "Seat rotated", state: "finished", ageMin: 60 * 5 },
          { label: "Seat started", state: "finished", ageMin: 60 * 24 * 6 },
        ],
      },
      {
        id: "t-search",
        title: "Restore search results after the index rebuild",
        description: "Results vanish for ten minutes after a rebuild. Keep the old index live until the new one answers.",
        status: "assigned",
        color: "sky",
        updatedMin: 4,
        createdMin: 60 * 7,
        pipeline: {
          goal: "Restore search results after the index rebuild",
          progress: "stage 2 of 3",
          stages: [
            { id: "s1", name: "Implementer", state: "finished", detail: "handed off 41 min ago" },
            { id: "s2", name: "Reviewer", state: "working", detail: "round 2 · reading the diff" },
            { id: "s3", name: "Verifier", state: "planned", detail: "starts after review" },
          ],
          rounds: [{ after: "s1", label: "R1", verdict: "changes" }, { after: "s2", label: "R2", verdict: null }],
          failEdge: { from: "s3", to: "s1", label: "on fail · 2 rounds left" },
        },
        members: [
          { id: "c-search-1", role: "Implementer", engine: "codex", state: "finished", latest: "Handed the diff to review", ageMin: 41 },
          { id: "c-search-2", role: "Reviewer", engine: "claude", state: "working", latest: "Checking the fallback path", ageMin: 4 },
        ],
        history: [
          { label: "Round 1 · Reviewer", state: "changes requested", ageMin: 60 + 12, verdict: "2 findings" },
          { label: "Attempt 1 · Implementer", state: "finished", ageMin: 60 * 3 },
        ],
      },
      {
        id: "t-export",
        title: "Simplify the export settings sheet",
        description: "Fold the eleven toggles into three sensible presets and one advanced disclosure.",
        status: "assigned",
        color: "none",
        updatedMin: 9,
        createdMin: 60 * 26,
        members: [
          { id: "c-export-1", role: "Implementer", engine: "claude", state: "working", latest: "Writing the preset model", ageMin: 9 },
          { id: "c-export-2", role: "Explorer", engine: "codex", state: "finished", latest: "Listed every toggle and its callers", ageMin: 60 * 2 },
        ],
        history: [{ label: "Attempt 1 · Explorer", state: "finished", ageMin: 60 * 2 }],
      },
      {
        id: "t-links",
        title: "Repair old links in the release notes",
        description: "",
        status: "assigned",
        color: "none",
        needsDecision: true,
        updatedMin: 17,
        createdMin: 60 * 5,
        members: [
          { id: "c-links-1", role: "Implementer", engine: "codex", state: "needs you", latest: "Which of the two anchors should win?", ageMin: 17 },
        ],
        history: [],
      },
      {
        id: "t-merge-a",
        title: "Merge the approved queue adapter release · merge",
        description: "",
        status: "assigned",
        color: "none",
        updatedMin: 60 * 26,
        createdMin: 60 * 27,
        members: [],
        history: [{ label: "Attempt 1 · Merger", state: "finished", ageMin: 60 * 26, verdict: "merged" }],
      },
      {
        id: "t-verify-a",
        title: "Verify delivery recovery across transcript boundaries · verify",
        description: "",
        status: "assigned",
        color: "none",
        updatedMin: 60 * 30,
        createdMin: 60 * 31,
        members: [],
        history: [{ label: "Attempt 1 · Verifier", state: "failed", ageMin: 60 * 30, verdict: "host died before the verdict" }],
      },
      {
        id: "t-disk",
        title: "Disk space: find what Docker, worktrees and temp storage hold",
        description: "",
        status: "assigned",
        color: "none",
        updatedMin: 60 * 41,
        createdMin: 60 * 41,
        members: [],
        history: [],
      },

      /* ── Inbox ────────────────────────────────────────────────────────── */
      {
        id: "t-longtitle",
        title:
          "You are the reviewer in an implement-review loop. Working directory is the lane worktree. Read the diff against the merge base, run the touched tests by path, and answer with one verdict block; do not change product source in this stage.",
        description: "",
        status: "inbox",
        color: "none",
        updatedMin: 60 * 3,
        createdMin: 60 * 3,
        members: [],
        history: [],
      },
      {
        id: "t-pending",
        title: "",
        description: "",
        status: "inbox",
        color: "none",
        namePending: true,
        updatedMin: 6,
        createdMin: 6,
        members: [{ id: "c-pending-1", role: "Worker", engine: "claude", state: "queued", latest: "Waiting for a seat", ageMin: 6 }],
        history: [],
      },
      {
        id: "t-onboarding",
        title: "Write the first-run walkthrough",
        description: "Three screens, one action each. No tour bubbles.",
        status: "inbox",
        color: "amber",
        updatedMin: 60 * 24 * 2,
        createdMin: 60 * 24 * 2,
        members: [],
        history: [],
      },

      /* ── Blocked ──────────────────────────────────────────────────────── */
      {
        id: "t-auth",
        title: "Passkey sign-in for the shared board",
        description: "Waiting on the domain decision before the relying-party id can be fixed.",
        status: "blocked",
        color: "coral",
        updatedMin: 60 * 20,
        createdMin: 60 * 24 * 4,
        members: [{ id: "c-auth-1", role: "Implementer", engine: "codex", state: "held", latest: "Parked until the domain is chosen", ageMin: 60 * 20 }],
        history: [{ label: "Attempt 1 · Implementer", state: "held", ageMin: 60 * 20 }],
      },
      {
        id: "t-limits",
        title: "Show the account limit reset time on the card",
        description: "",
        status: "blocked",
        color: "none",
        updatedMin: 60 * 24 * 3,
        createdMin: 60 * 24 * 5,
        members: [],
        history: [{ label: "Attempt 1 · Implementer", state: "failed", ageMin: 60 * 24 * 3, verdict: "rate limited" }],
      },

      /* ── Done ─────────────────────────────────────────────────────────── */
      {
        id: "t-interrupt",
        title: "Universal interrupt and stop for every engine",
        description: "",
        status: "done",
        color: "none",
        updatedMin: 60 * 8,
        createdMin: 60 * 24 * 3,
        members: [],
        history: [
          { label: "Released", state: "finished", ageMin: 60 * 8, verdict: "deployed" },
          { label: "Round 2 · Reviewer", state: "approved", ageMin: 60 * 10 },
          { label: "Round 1 · Reviewer", state: "changes requested", ageMin: 60 * 20, verdict: "1 finding" },
        ],
      },
      {
        id: "t-attach",
        title: "Finish responsive native attachment delivery",
        description: "",
        status: "done",
        color: "none",
        updatedMin: 60 * 12,
        createdMin: 60 * 24 * 2,
        members: [{ id: "c-attach-1", role: "Verifier", engine: "claude", state: "working", latest: "Re-running the phone matrix", ageMin: 3 }],
        history: [{ label: "Round 1 · Reviewer", state: "approved", ageMin: 60 * 12 }],
      },
      {
        id: "t-compact",
        title: "Compact board stages and separate history from live work",
        description: "",
        status: "done",
        color: "lime",
        updatedMin: 60 * 24 * 2,
        createdMin: 60 * 24 * 4,
        members: [],
        history: [{ label: "Released", state: "finished", ageMin: 60 * 24 * 2, verdict: "deployed" }],
      },
      {
        id: "t-voice",
        title: "Keep the orchestrator role when voice is enabled",
        description: "",
        status: "done",
        color: "none",
        updatedMin: 60 * 24 * 3,
        createdMin: 60 * 24 * 5,
        members: [],
        history: [{ label: "Round 1 · Reviewer", state: "approved", ageMin: 60 * 24 * 3 }],
      },
      {
        id: "t-queue",
        title: "Preserve native queue recovery through journal compaction",
        description: "",
        status: "done",
        color: "none",
        updatedMin: 60 * 24 * 4,
        createdMin: 60 * 24 * 6,
        members: [],
        history: [{ label: "Released", state: "finished", ageMin: 60 * 24 * 4, verdict: "deployed" }],
      },
    ],
  };

  return F;
})();
