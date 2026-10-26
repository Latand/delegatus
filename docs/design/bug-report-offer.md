# Offer to report a Delegatus defect

Design for #2518 and decision #3293. Status: implementation contract updated by the operator decision of 2026-10-24.

## Decision recorded 2026-10-24

The seat prepares a scrubbed bug-report draft on its own through the dedicated
`issue-reporter`. Preparation has no separate consent step. The seat shows the
exact candidate with its privacy review and asks once, before publication, for
approval of that text through the existing decision form.

A plain decline ends the report. Revise only when the operator requests an edit
or reopens reporting. Revised text needs a new preview and fresh exact-text
approval. Continue independent authorized work while the publication question
is pending.

Issue authorship remains destination-dependent: a declared App repository uses
the Delegatus GitHub App and refuses unavailable App credentials; other
destinations retain the existing CLI policy. App-only authorship is a separate,
deferred task. Preparing the report does not change forge authentication.

This decision replaces the earlier recommendation to ask before preparation
(variant 1). It selects immediate preparation (variant 3). The originating
requirement remains a useful public report that protects private conversations
and installation details. The decisions in [issue-report approval](issue-report-approval.md)
keep detectors advisory and leave the final decision with a person.

## Operator journey

1. **Recognize a likely product defect.** Examples are contradictory tool
   answers, an internal failure or a launch refusal inconsistent with visible
   state. Expected validation, an ordinary account limit or a failure in the
   operator's own project alone does not justify a Delegatus report. Describe
   uncertainty honestly.
2. **Prepare automatically.** Briefly explain the symptom and whether the
   original work can continue. Send the dedicated reporter the minimum relevant
   evidence references. Never paste a transcript wholesale into its brief.
   The reporter gathers read-only evidence, searches open issues for duplicates,
   writes the existing five report sections, scrubs private details and reviews
   the whole text. A matching issue ends preparation: return its number and
   explain the match privately, without an automatic public comment.
3. **Show the exact candidate and ask once.** Read it with `issue_report show`,
   display its returned `previewText` unchanged, then pass `approvalForm.issueReport`
   to `publish_prototype_review` without a task id. Keep public text, privacy
   judgment, remaining hints and source warnings visible together. A clean scan
   provides no privacy guarantee.
4. **Respect the answer.** Explicit approval files the stored text through
   `issue_report publish`. A plain decline stops reporting without another
   reporter handoff or question. A requested edit or an explicit reopening may
   return to the reporter; changed text needs a new preview and approval form.
   Silence, custom notes, agent decisions and accepting recommendations remain
   non-approval. Current authorization accepts an explicit operator or team
   member choice.
5. **Give the outcome.** Confirm success only with the returned issue reference.
   A provable pre-write failure retains the preview for retry. An unknown
   outcome may already have produced an issue: reconcile through the existing
   tool and never create a new preview to bypass the held claim. Seat rotation
   reuses available preview/form records and never infers approval from a summary
   or reopens a declined report on its own.

## Boundaries that remain

- `src/lib/roles/defaults.ts` keeps the dedicated reporter read-only, with no
  publication or child-launch authority. `src/lib/mcp/toolAllowlist.ts` and
  `src/lib/agent/spawnAdmission.ts` enforce its role fences.
- Public title/body contain no person, account identity, host, domain, IP
  address, port, local or absolute path, private project name, runtime identifier,
  secret, plan data or operator quotation. Use generic roles and paraphrases.
  Repository-relative Delegatus source references and tool names are permitted.
  Attachments stay out of this flow. Privacy notes describe removed categories
  without repeating private values.
- `src/lib/mcp/bindings.ts` requires an identified preview caller, a valid title
  and body and a complete privacy judgment. Advisory hints and source warnings
  remain visible. Preserve every existing refusal; do not add detector-based
  refusals or expand the detector family for this decision.
- `src/lib/issueReports/approvalForm.ts` binds the exact form to the preview.
  Publication requires the seat's read-back and the newest matching form with
  an explicit approving choice by a person. Wrong-seat approval, changed text,
  custom text, recommendations and agent choices authorize no new write.
- `src/lib/issueReports/store.ts` retains immutable digest-addressed previews,
  separate read-back markers and exclusive publication claims. Concurrent calls
  produce one issue; uncertain outcomes remain held until reconciled. Declining
  does not delete records or undo a completed publication.
- `src/lib/issueReports/publish.ts` sends only the approved title and body to the
  installation's configured destination. Review notes and local metadata stay
  private. A reporter brief cannot choose the destination.

## Delivery and verification

Update the active mandate, its version and shipped-text upgrades, reporter role,
MCP description and reply guidance together. Bespoke and older mandates receive
the current directive through existing delivery; pending intent replays retain
what they recorded. No new detector, table, daemon, role or approval endpoint is
required.

Regression coverage prepares a draft with no consent form, then declines its
sole publication form and verifies no issue write or automatic revision.
Mandate tests verify delivery upgrades and idempotence; MCP tests verify the
existing exact-text approval, privacy judgment, role fences and retry
boundaries. These are deterministic tool and delivery checks; actual
seat recognition and suppression of repeat offers still depend on following
those instructions. Repeat suppression across rotation gains no new persistent
guarantee here (variant 2 remains deferred).

Run changed tests and all tests importing changed modules on main and branch,
with private HOME, XDG_CONFIG_HOME, LLV_STATE_DIR and TMPDIR and a closed
LLV_VIEWER_CONTROL_URL. Run typecheck, ESLint and publication checks. Existing
browser drivers remain the route for any later rendered changes; this decision
adds no UI surface or issue-specific driver.
