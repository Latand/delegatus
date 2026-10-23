# Offer to report a Delegatus defect

Design for #2518. Status: proposed completion and verification of the existing flow; no product changes in this document. Code references checked at `adce57649`.

## The operator's problem

The requirement, paraphrased: when Delegatus itself goes wrong, explain what happened and offer to report it. A dedicated reporter prepares a useful public report while protecting private conversations and installation details. Show the exact candidate, file it after explicit approval, and confirm the outcome.

The original issue text is not reproduced in the inspected repository. Its intent is recorded in `src/lib/roles/defaults.ts:189` and `src/lib/issueReports/store.ts:13`; this design uses those comments and the supplied issue summary. Most of the requested feature has already shipped. The remaining work is to make the offer predictable, resolve ambiguous cancellation wording, and verify the whole operator journey.

Two later decisions govern the design: [issue-report approval](issue-report-approval.md) makes privacy detectors advisory, and `src/lib/orchestrator/prompt.ts:297` records the move to decision forms. Neither decision should be reversed to reconstruct an older interpretation of #2518.

## What exists, and what must stay

| Current behavior | Evidence in current code | Design consequence |
| --- | --- | --- |
| Every seat is instructed to ask before preparing a report, launch `issue-reporter`, show the result and ask again before publication. The directive is carried into older or customized mandates. | `src/lib/orchestrator/prompt.ts:298`, `src/lib/orchestrator/prompt.ts:301` | Keep the two decisions: permission to prepare, then approval to publish. No new reporting tool is needed. |
| The reporter gathers read-only evidence, checks open issues, writes five report sections, removes private details, reviews hints and returns a preview. | `src/lib/roles/defaults.ts:195` | Reuse this role and report format. A matching issue ends preparation without a new issue or public comment. |
| Reporter writes and child launches are fenced. | `src/lib/mcp/toolAllowlist.ts:279`, `src/lib/agent/spawnAdmission.ts:272`, `src/lib/roles/defaults.ts:388` | “Filed by a dedicated reporter” means prepared and privacy-reviewed by that role. The seat requests publication through the tool; the reporter never receives publication authority. |
| Hints and an explicit agent judgment accompany the preview; detector matches do not block it. | `src/lib/mcp/bindings.ts:2032`, `src/lib/mcp/bindings.ts:2063` | A clean scan is no privacy guarantee. The reporter must read the whole report; the operator decides last. |
| The preview marks the public title/body separately from private review notes. | `src/lib/issueReports/previewText.ts:85`, `src/lib/mcp/bindings.ts:2091` | Show the returned `previewText` unchanged. Only its title and body are submitted. |
| Publication requires a seat that read the preview and the newest matching decision form answered explicitly by a person. | `src/lib/mcp/bindings.ts:2090`, `src/lib/mcp/bindings.ts:2130`, `src/lib/issueReports/approvalForm.ts:66` | Neither a chat paraphrase nor accepting recommended answers authorizes publication. Current policy also accepts a team member's explicit choice. |
| A digest binds exact text; exclusive claims prevent two submissions, and uncertain outcomes are reconciled. | `src/lib/issueReports/store.ts:80`, `src/lib/issueReports/store.ts:190`, `src/lib/mcp/bindings.ts:2108` | Keep existing storage and retry rules. Never treat a timeout as proof that nothing was filed. |
| The destination comes from the installation's Delegatus repository configuration. Writes use the existing forge boundary. | `src/lib/issueReports/publish.ts:23`, `src/lib/issueReports/publish.ts:35` | Do not let a reporter brief choose the destination. App-configured destinations fail closed; other destinations retain the existing CLI policy. |

The seat follows prompt instructions to recognize defects and offer reports; this behavior still needs observation in actual runs. Also, `preview` currently accepts identified callers generally (`src/lib/mcp/bindings.ts:2052`), so reporter authorship depends on the handoff instructions. This design keeps the existing approval mechanism.

## Variants

| Variant | Operator experience | Trade-off |
| --- | --- | --- |
| 1. Clarify and verify the existing conversation flow (recommended) | One brief offer, a dedicated reporter after consent, then the exact preview and existing publication form. | Small scope; no schema or UI work. Detection and suppression of repeated offers remain the seat's responsibility. |
| 2. Persist a defect-offer record | A durable per-incident record remembers offered, declined, preparing, previewed and resolved across seat rotations. | More reliable repeat suppression and recovery, but needs incident identity, retention, concurrency and migration rules. A report digest cannot identify an incident before text exists. Defer until repeated-offer or lost-handoff evidence warrants it. |
| 3. Prepare immediately, ask only before filing | The first interruption already contains a scrubbed preview. | One fewer decision, but spends reporter work and accesses evidence without the preparation consent the current mandate promises. Requires an explicit policy change; not recommended. |

Recommend variant 1. First establish whether the shipped flow meets the issue in practice. Add narrowly scoped prompt clarification and regression coverage only where the scenarios below expose a gap. Do not add a new table, daemon, detector family, reporter role or approval endpoint for this issue.

## Proposed operator journey

1. **Recognize a likely product defect.** Examples are contradictory tool answers, an internal failure, or a launch refusal inconsistent with the visible state. Expected input validation, an ordinary account limit or a failure in the operator's own project does not by itself justify a Delegatus report. If the cause is uncertain, say so; do not claim a confirmed defect.
2. **Offer once for the observed incident.** Briefly explain the symptom, whether the original work can continue, and that preparation leads to a public-text preview. Ask through the existing taskless decision form: “Prepare a scrubbed Delegatus bug report?” Offer prepare and decline, with free text available. This is consent to preparation only. Continue independent authorized work while waiting; do not put unrelated tasks on hold.
3. **Prepare after consent.** Send the reporter the minimum relevant evidence references and symptom. It reads through existing tools, searches for duplicates and follows the current privacy rules. Never paste a transcript wholesale into its brief. If a duplicate covers the symptom, return its issue number and explain the match privately; do not automatically comment on it.
4. **Show the exact candidate.** Read the stored preview with `issue_report show`, display its returned `previewText`, then pass its `approvalForm.issueReport` to `publish_prototype_review` without a task id. Keep the public text, privacy judgment, remaining hints and source warnings visible together. Explain uncertainty without calling the report guaranteed safe.
5. **Respect the answer.** Explicit approval files the stored text through `issue_report publish`. A requested edit returns to the reporter, followed by a new preview and approval form. A plain decline ends the attempt; it does not automatically send the reporter back to revise or ask again. Clarify the current mandate's ambiguous “a no or an edit returns to the reporter” sentence accordingly. Silence, a custom note, an agent decision and accepting recommendations remain non-approval.
6. **Give the outcome.** Confirm success only with the returned issue reference. On a provable pre-write failure, retain the preview and explain the retryable failure. On an unknown outcome, say it may have been filed and reconcile through the existing tool; do not create another preview to bypass the held claim. A seat rotation reuses available preview and form records; if approval cannot be established, ask again rather than infer consent from a summary.

Public report text contains no person, account identity, host, domain, IP address, port, local or absolute path, private project name, runtime identifier, secret, plan data or operator quotation. Use generic roles and paraphrased evidence. Repository-relative Delegatus source references and tool names are useful and permitted. Attachments stay out of this flow. Privacy review notes must describe removed values by category, never repeat them.

## Data and state touched

Variant 1 adds no persistent state. These are the existing boundaries implementation and verification must respect:

| Data | Existing owner and location | Handling |
| --- | --- | --- |
| Offer, consent, reporter handoff and final answer | Seat conversation; directive at `src/lib/orchestrator/prompt.ts:298` | Local operational context. Do not copy the conversation into public text. Repeat suppression uses available conversation context only; it is not a durable guarantee. |
| Preparation and publication questions | Taskless `seat-decisions` SQLite collection, `src/lib/prototypeReview/seatRounds.ts:18`, `src/lib/prototypeReview/seatRounds.ts:52` | Reuse existing question storage. Publication checks the matching form and deciding person's authority. Preparation consent grants no publication authority. |
| Title, body, judgment, hints and source warnings | Immutable digest-addressed preview under state-relative `issue-reports`, `src/lib/issueReports/store.ts:65`, `src/lib/issueReports/store.ts:85`, `src/lib/issueReports/store.ts:165` | Treat all preview metadata as local sensitive state. Same text reuses its preview; changed text needs a new digest. No new retention or cleanup policy here. |
| Read-back marker and publication receipt | Separate shown/claim records, `src/lib/issueReports/store.ts:88`, `src/lib/issueReports/store.ts:183`, `src/lib/issueReports/store.ts:196` | Preserve atomic claims and receipts across processes. A decline does not delete records or revoke an already completed publication. |
| Public issue payload | `src/lib/issueReports/publish.ts:43` | Send exactly stored title and body; exclude judgment, hints, conversation references and local metadata. The forge necessarily adds its own author metadata; scrubbing the body does not make forge authentication anonymous. |

## Delivery slices and acceptance

### 1. Reconcile the contract

Update only the active mandate/reporter wording and guide where needed: distinguish decline from edit, define a useful offer trigger, and describe reporter preparation versus seat publication. Preserve custom-mandate injection and the later detector/decision-form decisions.

Acceptance: the operator can distinguish the two approvals; declining ends the attempt; an edit always gets a fresh preview approval. Existing prompt coverage in `src/lib/orchestrator/prompt.test.ts` still verifies directive delivery. No blanket promise that tools mechanically detect every defect is added.

### 2. Verify the existing safety boundary

Use and extend only necessary cases in `src/lib/mcp/issueReport.test.ts`, `src/lib/mcp/pipelineRoleFence.test.ts` and the existing `src/lib/issueReports/` tests. Most approval, privacy and retry cases already exist; do not duplicate them just to rename them for this issue.

Acceptance: no approval, wrong-seat approval, changed text, custom text, recommendations and agent choices cannot cause a new write. The reporter cannot publish or spawn. Hinted text can reach human review; missing hint sources remain visible. Concurrent publication creates one issue, and an uncertain write cannot be blindly retried. Assert the submitted payload contains only the exact approved title/body.

### 3. Rehearse the operator journey

Exercise one synthetic contradictory tool result, one expected refusal, one duplicate, one decline, one edit and one uncertain publication using stubbed forge writes and isolated state. Use the existing conversation-window/board browser drivers for any rendered evidence; introduce no issue-specific driver. Check English and Ukrainian, light and dark, including a narrow screen.

Acceptance: the defect receives a concise offer; the expected refusal alone does not; decline produces no reporter launch; duplicate produces no issue write; the full bounded preview and form remain readable; editing cannot reuse approval; the final answer distinguishes filed, failed-before-write and unknown. Continue independent work during pending decisions. Record actual prompt-following observations separately from deterministic tool assertions. Run tests with private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR` and `LLV_STATE_DIR`, never the live installation.

## Questions for the operator

1. **Keep two decisions, or prepare automatically?** Recommended: keep preparation consent and exact-text publication approval, as currently shipped.
2. **Who files the report?** Recommended: retain the dedicated reporter as author/privacy reviewer and the seat as the only tool caller allowed to request publication. Moving write authority into the reporter would weaken the existing role boundary.
3. **Does a plain decline mean revise or stop?** Recommended: stop. Revise only when the operator requests an edit or reopens reporting.
4. **Must only the operator personally approve?** Recommended: retain current explicit operator-or-team-member approval. Operator-only approval would be a separate authorization change, not an implication of scrubbing.
5. **Should repeat suppression survive rotation as a new persistent guarantee?** Recommended: defer variant 2; reuse conversation and existing preview/form records, and collect evidence of repeat offers first.
6. **Must every issue be authored by the Delegatus App?** Recommended: retain the current destination-dependent forge policy for this scope. If account-free forge authorship is required as well as identity-free report text, make App-only publication an explicit follow-up; the current fallback does not guarantee it.
