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
