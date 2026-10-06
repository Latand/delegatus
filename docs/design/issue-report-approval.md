# Delegatus issue reports: hints, agent judgment and operator approval

## Operator decision 2026-10-06: detectors are hints

The operator's words, verbatim, from the seat chat voice transcript:

> Это нужно сделать не так, абсолютно. Точнее, как: вот это шаблоны, которые я проверяю, их нужно использовать только для подсказки нашему искусственному интеллекту. Но принятие о том, приватное, ну, то есть он должен сам пересмотреть всё, прогнать этот инструмент, и не полагаться на его решения, а самому принять решение, то есть агент должен принять решение, содержит ли там что-то или нет. А после этого уже принимает решение человек. То есть мы не ограничиваем, если отказ идёт какой-то, нам не нужно раздувать эту форму на миллион разных совпадений.

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
existing chat, using a short hint list beside the text and the existing
suggested replies. The operator decides last and may approve text with hints.
Legacy previews show an explicit missing-judgment notice and advisory hints.

## Publication and authority

The existing digest continues to cover exactly the title and body. Edits get a
new digest; an approval names the full digest and is read from the operator's
latest message in that seat's conversation after the preview was shown.
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
