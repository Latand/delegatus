# Relay reply verification, 2026-11-12

Bun 1.4.0 and Claude Code 2.1.322. Product base: `aae7208f2d`.
The final results cover 146 tests: 144 pass and two matching baseline failures.
Six default-Markdown cases fail on the base and pass on the change.
The native check passes with two real model turns and 16 assertions.
Four offline rendering cases pass with 12 assertions.

For each row, the command is `bash "$GATE" bun run test src/lib/externalRelay/<file>`.
`GATE` is the controller-supplied installed gate-slot wrapper at release
`34b741354731`. Campaigns start once using
`bash "$GATE" --record "$TMPDIR/<campaign>.log" bash <campaign-script>`
and finish through `wait_for_check`. The campaign invokes one explicit file
per command, sequentially, with private HOME, XDG_CONFIG_HOME, TMPDIR and
LLV_STATE_DIR; LLV_VIEWER_CONTROL_URL points to closed loopback port 1.

Render commands set LLV_RELAY_SERVICE_ROOT and LLV_RELAY_RENDER_PYTHON to a
private backend export and interpreter. Native commands set
LLV_RELAY_REPLY_PROBE=1; the successful run also pins LLV_RELAY_REPLY_CONFIG
to a private copy of the selected account's configuration. The native CLI
uses `--safe-mode --restricted --tools WebSearch,WebFetch --allowedTools WebSearch,WebFetch --strict-mcp-config --mcp-config '{"mcpServers":{}}'`.
No chat transport is called.

Initial, base, scratch-confirmation and final native r7 checks use scratch
source exports. Repair checks and native r6 read the assigned checkout with
isolated state; their final confirmation uses scratch exports.

The receiving service renderer was exported read-only from clean source
revision `b699727a81b529445042ba99b0df2a5ee1891b77`. Its real answer validator
and HTML fallback feed Telethon's entity parser. Python 3.13.15 used
markdown-it-py 3.0.0, Pydantic 2.12.3 and Telethon 1.41.2.

| Run | Command file | Exit | Pass | Fail | Skip | Assertions |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Initial | `answerV2.test.ts` | 0 | 6 | 0 | 0 | 67 |
| Initial | `ownerAnswer.test.ts` | 1 | 1 | 1 | 0 | 19 |
| Initial | `ownerRelayContract.test.ts` | 0 | 11 | 0 | 0 | 19 |
| Initial | `prompt.test.ts` | 0 | 18 | 0 | 0 | 162 |
| Initial | `ownerTier.test.ts` | 1 | 53 | 1 | 0 | 613 |
| Initial | `ownerEnvelope.test.ts` | 1 | 47 | 3 | 0 | 325 |
| Initial | `ownerAnswer.render.test.ts` | 1 | 0 | 4 | 0 | 8 |
| Initial | `ownerReply.native.test.ts` | 1 | 0 | 1 | 0 | 1 |
| Base aae7208f | `ownerAnswer.test.ts` | 1 | 1 | 1 | 0 | 16 |
| Base aae7208f | `ownerTier.test.ts` | 1 | 53 | 1 | 0 | 613 |
| Base aae7208f | `ownerEnvelope.test.ts` | 0 | 50 | 0 | 0 | 360 |
| Base aae7208f | `ownerRelayContract.test.ts` | 1 | 5 | 6 | 0 | 19 |
| Repair | `ownerAnswer.test.ts` | 1 | 1 | 1 | 0 | 20 |
| Repair | `ownerEnvelope.test.ts` | 0 | 50 | 0 | 0 | 360 |
| Repair | `ownerAnswer.render.test.ts` | 1 | 3 | 1 | 0 | 12 |
| Repair | `ownerReply.native.test.ts` | 1 | 0 | 1 | 0 | 1 |
| Scratch confirmation | `ownerAnswer.test.ts` | 1 | 1 | 1 | 0 | 20 |
| Scratch confirmation | `ownerEnvelope.test.ts` | 0 | 50 | 0 | 0 | 360 |
| Scratch confirmation | `ownerAnswer.render.test.ts` | 0 | 4 | 0 | 0 | 12 |
| Scratch confirmation | `ownerReply.native.test.ts` | 1 | 0 | 1 | 0 | 1 |
| Native r4 | `ownerReply.native.test.ts` | 1 | 0 | 1 | 0 | 1 |
| Native r5 | `ownerReply.native.test.ts` | 1 | 0 | 1 | 0 | 0 |
| Native r6 | `ownerReply.native.test.ts` | 1 | 0 | 1 | 0 | 13 |
| Native r7 | `ownerReply.native.test.ts` | 0 | 1 | 0 | 0 | 16 |

The outer recorded commands exited: setup 0, initial focused campaign 1,
baseline campaign 0 (its individual failing results remain listed above),
repair campaign 1, scratch-confirmation campaign 1, native r4/r5/r6 1,
native r7 0. The source and test files in the final scratch export match this
commit's implementation. Raw command logs and counts are retained in the
stage's private evidence directory.

The two baseline failures are `ownerAnswer.test.ts`'s attachment refusal
through a dot-directory in the stage scratch path, and
`ownerTier.test.ts`'s truncated-JSON credential assertion. Both reproduce
unchanged on the base. The focused fix leaves their production behavior intact.

Initial envelope failures exposed fixed prompt-size assumptions. Final tests
assert overflow and context preservation independently of prompt wording.
Initial render/native helpers passed data to stdin.end; explicit stdin.write
then end supplies it correctly under Bun 1.4.0. Native r2/r3/r4 lacked login
because the project test preload replaces CLAUDE_CONFIG_DIR; r5's diagnostic
launcher encountered the same replacement. Pinning the private probe config
after preload resolves it. Native r6 obtained both replies but required a new
search on the continuation; final r7 proves search on the first turn and
allows reuse of that source. List entity offsets follow the receiving
service's existing HTML fallback with three newline characters between these two list items.

Other verification:

| Command | Exit | Counts |
| --- | ---: | --- |
| Recorded gate: `uv venv "$TMPDIR/render-venv"` then `uv pip install --python "$TMPDIR/render-venv/bin/python" markdown-it-py==3.0.0 pydantic==2.12.3 telethon==1.41.2` | 0 | 11 packages installed |
| `bun run lint <8 original changed TypeScript paths>` | 0 | 8 files, 0 diagnostics |
| `bun run lint <9 changed TypeScript paths>` | 0 | 9 files, 0 diagnostics |
| `LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE=scripts/privacy-known-value-fingerprints.json bun scripts/privacy-publication-gate.ts --require-known-values --paths <9 original changed paths>`, initial | 1 | 1 resource_identifier finding in synthetic session fixture |
| Same privacy command after fixture correction | 0 | 9 files, 0 findings |
| Private native launcher `--version` diagnostic | 0 | Claude Code 2.1.322; 0 model turns |
| `git diff --check`, repeated during editing | 0 | 0 whitespace errors |
| `git diff --cached --check`, first staged check | 2 | 1 extra blank line at the report EOF |
| `git commit -m "Reply directly in relay chats and default owner Markdown"` with attribution trailer, first attempt | 1 | pre-commit refused the report whitespace; no commit created |

The original TypeScript paths under src/lib/externalRelay are answerV2.ts,
ownerAnswer.ts, ownerRun.ts, searchGuidance.ts, ownerAnswer.test.ts,
ownerRelayContract.test.ts, ownerAnswer.render.test.ts and
ownerReply.native.test.ts. The nine-file lint command adds
ownerEnvelope.test.ts. Original privacy paths include the eight TypeScript
paths and docs/design/relay-v2-rich-media-out.md. Final publication privacy,
final native-file lint and the repository commit hook are reported in the
stage handover after this record.

## Sources footer cause, 2026-11-12

Claude Code 2.1.322, Bun 1.4.0, base `1a85f5eb78`.

### Where the footer comes from

An isolated probe sent the real owner prompt (`prepareOwnerPrompt` over
`rich.fixture.ts`) to `claude -p` with a private copy of the account
credentials, private HOME, XDG_CONFIG_HOME and TMPDIR, and
`ANTHROPIC_BASE_URL` pointed at a loopback pass-through that recorded the
request bodies. No chat transport was involved.

- The Delegatus prompt and the system prompt in the recorded requests do not
  mention sources.
- The `WebSearch` tool definition sent by Claude Code ends with: `After
  answering from results, end with a "Sources:" list of the URLs you used as
  markdown links.` The other description variant in the same binary carries
  `CRITICAL REQUIREMENT ... you MUST include a "Sources:" section at the end of
  your response`.
- Every `WebSearch` result ends with `REMINDER: You MUST include the sources
  above in your response to the user using markdown hyperlinks.`
- The binary's internal `CLAUDE_CODE_WEBSEARCH_CITATIONS` switch replaces the
  description line, but snippet-free results still carry the reminder. It is
  not a Delegatus setting, so the fix does not use it.

The owner relay posted the agent's final message, its "response to the user",
to the chat, so this engine convention reached the group. The native probe at
the base reproduced it: the first reply ended with `Джерела: [IANA: Example
Domains](…), [RFC 2606 …](…).` and failed `hasInlineCitations`.

### Change

With rich-message negotiation the chat reply is `relay_answer` `text`; the
final message stays in the session and is posted only when no call supplied
text. Without negotiation nothing changes. The native probe now serves the
production `relay_answer` description and schema from a recording stdio stub
(`ownerReply.native.fixture.ts`) and checks the text that the owner turn would
post. `--safe-mode` was dropped from the probe because it skips MCP servers;
`--restricted`, `--setting-sources ""`, `--strict-mcp-config` and the private
configuration keep it isolated. `ToolSearch` is allowed because Claude Code
defers MCP tools behind it, as in a real session.

### Native probe series

Each series runs `bun test --timeout=60000
src/lib/externalRelay/ownerReply.native.test.ts` three times with
`LLV_RELAY_REPLY_PROBE=1`, each run under fresh HOME, XDG_CONFIG_HOME,
LLV_STATE_DIR and TMPDIR, through the gate-slot wrapper.

| Series | Tree | Runs passed | Notes |
| --- | --- | ---: | --- |
| Base | `1a85f5eb78` | 0 of 1 | `Джерела:` closing sentence |
| 1 | change, first heuristic | 2 of 3 | run 3: a link after `пише так:` inside a continuing sentence, rejected by the colon rule |
| 2 | change, refined heuristic | 1 of 3 | run 1: continuation answered without `relay_answer`; run 3: `Офіційні джерела: […] та […].` inside the composed text |
| 3 | continuation names `relay_answer` | 3 of 3 | |
| 4 | merged with `origin/main` | 2 of 3 | run 1: `Джерело: [RFC 2606](…).` inside the composed paragraph |
| 5 | final, `87fb83262e` | 5 of 6 | one run: `Офіційна сторінка IANA про це: [iana.org/…](…).` inside the composed paragraph |

From series 3 on, all 24 turns gave the chat reply through `relay_answer`, and
no composed text ended with a sources paragraph or list. The remaining misses
are single citation sentences after the claim they support; the probe's
`hasInlineCitations` counts a colon followed only by links as a list and
fails them. Two direct calls of the final prompt without `relay_answer` (the
last message is then the chat reply) produced one reply that ended with a
`Sources:` list, which is the base behaviour.

### Focused tests

Each file ran by explicit path with fresh HOME, XDG_CONFIG_HOME, LLV_STATE_DIR
and TMPDIR and `LLV_VIEWER_CONTROL_URL` on closed loopback port 1, through the
gate-slot wrapper, on a scratch export of the commit. Failures in
`ownerAnswer.test.ts` (1), `ownerTier.test.ts` (1), `ownerLifecycle.test.ts`
(17), `ownerDelivery.test.ts` (4) and `runner.test.ts` (7) have identical test
names on the base `1a85f5eb78` under the same isolation; the scratch root sits
under a dot-directory, which the attachment rules refuse. The new
`relay_answer text=true` runner case and the new `text` assertions in
`ownerAnswer.test.ts` run and pass (runner 327 passes against 326 on the
base; ownerAnswer reaches 25 assertions against 20 before the shared refusal).
