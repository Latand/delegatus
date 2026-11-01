# Delegatus issue reports: hints, agent judgment and operator approval

## Operator decision 2026-10-06: detectors are hints

Detectors provide advisory hints. The agent reviews the whole text and judges
its privacy; a person then decides whether to publish it.

This decision replaces the scrub-before-preview acceptance in #2518. Detector
completeness and the four earlier pattern findings are outside acceptance.
No new detector is needed to cover a missed spelling. Keep a small, readable
set of general hints; stop growing special cases for scripts, punctuation,
wrappers and URI variants.

## Reporter and preview contract

The read-only `issue-reporter` collects evidence through Delegatus read tools,
checks open issues for duplicates and writes the title and body. It calls
`issue_report` with `action: "hints"`, then re-reads the whole text and makes its
own judgment. Hints are pointers: each has a class, matched text, field,
lines and UTF-16 offsets in its written or decoded reading. A hint may be a
false alarm; a clean result proves nothing. The agent removes or rewrites
identifying details and operator quotes according to the role's privacy rules.

The agent calls `action: "preview"` with the final text and `privacyJudgment`:
its assessment, what it removed (by kind), which hints it judged harmless and
why, and uncertainties. Storage keeps these annotations with the text. Matches
never refuse preview, storage or a publication claim. Unavailable known-name
sources return a compact warning, while shared static hints remain available.
The tool never substitutes detector output for the agent's judgment.

The orchestrator's `action: "show"` returns the exact title/body, the agent's
judgment, remaining hints and source warnings. It shows them together in the
existing chat, then passes `approvalForm.issueReport` to
`publish_prototype_review` without `taskId`. The server builds the approval
form. The operator decides last and may approve text with hints.
Legacy previews show an explicit missing-judgment notice and advisory hints.

## Publication and authority

The existing digest continues to cover exactly the title and body. Edits get a
new digest. Publication reads the newest taskless approval form for this
preview asked by any seat in the publishing seat's project lineage. The form
must have been created at or after that lineage's earliest recorded show of the
preview. A person must choose the option naming the full digest, and the stored
title and body must still match it.

Approval survives seat rotation. The successor uses that approval without
asking again. Forms from another project, approvals of another digest, changed
text and agent answers cannot authorize publication. Missing or ambiguous
project lineage cannot transfer a predecessor's approval. A newer matching
form that is unanswered or declined prevents publication.

Publication accepts no replacement text and no caller-supplied approval.
Withdrawal still prevents a claim, and the exclusive claim and forge outcome
reconciliation keep publication idempotent. Publication uses the existing
Delegatus App write boundary. Detector results take no part in admission.

The mandate's ask-before-filing line, reporter mutation/spawn fences and
cross-project rule remain unchanged. Cross-project task, pipeline and agent
creation by a seat is refused before dispatch with a pointer to
`send_message_to_orchestrator`; a nonempty `crossProjectRequest` expresses the
operator's explicit request. Refusal preserves the receiving orchestrator's
ownership of its board.

## Verification

Focused tests cover hints reaching reporter and preview with class and span,
agent judgment on both hinted and clean text, advisory source failures,
preview/storage/publication with matches, and legacy previews. Existing tests
retain digest mismatch, no approval, withdrawal, exact stored text, publication
claims, reporter fences, mandate delivery and cross-project admission.
Rotation tests use the production seat-intent writers and approval-form builder:
seat A shows and asks, a person approves, then seat B shows and publishes through
an SDK client over the exported HTTP MCP route. Refusal cases cover foreign
projects, another digest, changed text, agent answers and unavailable lineage.
The injected publisher records calls without filing a real issue.
