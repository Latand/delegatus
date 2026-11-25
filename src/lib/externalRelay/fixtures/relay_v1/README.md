X1 service fixtures copied byte for byte at revision `a0d9245bcac2c2246f29f180f8bd21aa825d478c`. All identities are synthetic placeholders.

```text
sha256 bytes file
2fdc03a4de10fbdc2df73322fc8e11fa4b240acb680962a70b2fce30b44c2a7d 10825 claimed_tools_member.json
845186f2d2c796a9a73ae47ad190312c311108af41f0ea38846cccab08ff4730 33322 claimed_tools_admin.json
cd05cf1937401dd4cfe804ddb3ed5b720961fdc3823582d2fe5ebf4ca1e71dae 33321 claimed_tools_anonymous_admin.json
7721980b31846f829b4bd67cf94a82ca3b5e478d32a606bf3d7c5833645b8994 34733 claimed_tools_owner.json
8e9274697d44d2996f2bbb20ec8d5b9620cc5d5878bcadab8e1e24a418b3f039 16863 claimed_tools_admin_owner_member.json
5514420f514516525418841ba19cfc8fa6c173c9e785a4b8943194f185627c6f 66162 claimed_tools_actions_admin.json
a8f60107ec907ca0237cae6670edb36875716a3d94097981f8f3c448d4cd6785 1165 tool_call_bodies.json
2c0c9008b8e84c9040ee56a09bce5bda116a9d7d4db598eb687e6d8e2dcb9d71 899 tool_call_errors.json
3d34147920af82036e5cfd628f911a5dcd406fb238ce93396c6c368cc4caf50f 38069 tool_call_results.json
bc90fffcec11665fee7022470747d0b741a9e649c3048a54474902945ad88e59 1436 tool_index_measurements.json
```

The merge of slice 2a at `f38f7e64` refreshed all ten service JSON files to
the manifest above. Slice 2b uses those exact bytes.

`actions-off-2a-hashes.json` and `actions-off-x2-2a-hashes.json` were captured
from the real runner at `f38f7e64`, in an isolated archive of that revision.
They pin SHA-256 of each runner prompt, compact CLI schema and serialized call
body for the five X1 role runs, the action index degraded to hand-off exactly
as the service does with actions OFF, and the X2 pending/page run in both HTTP
arrival orders. The X2 `wire` hash pins the complete 2a X2 bytes; the 2b test
removes its appended action runs and F2 advertisement before comparing them.
Read metadata rows carry no effect field.

The 2b X2 action run includes two concurrent reads before the action so that
normal and reversed HTTP arrivals exercise the same admission snapshots.
Polling an admitted image generation returns its stored delivered outcome with
`replayed: true`; the double counts one execution for that call identity.

## Slice 3 (X3)

Copied byte for byte from service revision `c5067f000493ca14e51216cdcac68fd6442fa2f6`.

| File | Bytes | SHA-256 |
|---|---:|---|
| `claimed_compact_owner.json` | 692 | `9b38c08da1a938cef1f28c8ca41703bc3f5207a3c2c61308c90055436a8c5276` |
| `claimed_compact_admin.json` | 690 | `63230ac373e55c9fe039bd5a5d313f9e5062a164dfc622bef23f762c25304a04` |
| `compact_completions.json` | 7988 | `4b90e23eed944d18f127ac2121b25a6fc6c48fa30db70a23b36c0f2db746816c` |

## Owner tools (X4), dark

Specification: Celestia amendment revision `03de6455`, 56,267 bytes,
SHA-256 `0a0e746a0868d7e5c81be9bdd12219205506f4cee082bb0126e2e82c89af050e`.
The install switch is `relay:owner_tools:enabled` in the existing private
`external-relay/switches.json`; absent, malformed or unreadable is OFF.
The production default stays OFF. No owner credential is introduced.

`owner-tools-index.json` is a local I10 rendering of the checked-in Celestia
`apps/backend/docs/openapi/public_moderation_openapi.json` at that revision
(document SHA-256 `451e8775dc9cf39bb10baae3e4029295c9af1023b59a05e6f1a31918903e42f4`).
It contains the 14 I9/R7 operations and their complete schemas, totaling
4,903 bytes. Production consumes the service's index and stores no operation
list; the fixture has no role in production negotiation or execution.

`owner-tools-off-v3-hashes.json` pins 34 retained fixture and evidence
JSON files, including K/P compact claims and completions. The earlier X1,
X2 and X3 files retain their bytes. The owner-tier merge updates only the
`card.json` pin to the reviewed owner-switch settings capture from #2677;
the other 33 artifacts and all wire captures retain their original pins.
The current `evidence/external-relay/chats.json` is a regenerated UI measurement
record, updated for reply-chain conversations in #3017. Its obsolete byte pin
was removed; the immutable wire captures remain checked byte for byte.
`owner-tools-off-runner-hashes.json`
was captured from the original Delegatus revision `39f654248666faa6e5deb01d59eeae305e64573f`
through the existing runner test, under isolated state. It pins each role's
prompts, schemas and calls, plus the OFF claim capabilities.

The guest requester schema changes keep those historical captures intact.
`actions-off-x2-2a-guest-schema-hashes.json` and
`owner-tools-off-runner-guest-schema-hashes.json` pin the corresponding current
runner schemas while guest answer negotiation is present.

`evidence/external-relay/install_tool_loop_owner.json` extends the existing
X2 runner capture format: its root is the reads run; `actions` contains
writes, retry_ceiling, inner_404, lease_lost and confirmation. Every run drives
the real runner and HTTP transport against deterministic port-0 service
doubles. These are install-side captures; Celestia's future five X4 service
fixtures and the named-revision cross-check remain their follow-up before
either switch is enabled. The capture records a null completion for lease
loss. Confirmation identifiers and absolute expiry appear only on the wire;
the model sees the summary and seconds left, with confirmation through chat
buttons alone.

The E3 regression fails at the original revision with `failed/invalid_answer`
and passes here with `declined/handoff`. Four wire-defined 429 refusals make
three waits, cache the failure, refund exactly one local debit, and preserve
any earlier possible action. An ambiguous attempt keeps its debit and makes
an action outcome unknown. All owner calls use the existing shared limits.

Regenerate the install capture through the existing runner test only:
`LLV_RELAY_WIRE_OUTPUT_OWNER=<output> bash scripts/gate-slot.sh bun test src/lib/externalRelay/runner.test.ts --test-name-pattern 'X4 six owner runs'`,
with HOME, XDG, TMPDIR and LLV_STATE_DIR isolated and the Viewer control URL
pointing at a closed loopback port. No service fixture generator is added here.

### Corrected R8 capture

The X4 double formerly returned bare arrays for grid lists and clone
activation. It also modeled two short grid route pages as relay fragments,
so concatenation produced two JSON documents. These values came from the
runner test's HTTP double. The production loop forwards the service's output
text unchanged and stores each result separately; it constructs no public
route response bodies and performs no page concatenation.

The corrected reads run follows the grid route's `output.next_cursor` in
the next call's `arguments.cursor`. Both responses are complete compact JSON
documents containing `items` and `next_cursor`; their items are combined
after parsing each document. Relay fragment paging uses the outer `cursor`
for one long document and remains exercised by the existing X2 capture.
Pending polling, cached repetition, sequential writes, 204, rate-limit
retries, inner 404, lease loss and confirmation retain their X4 coverage.

| Capture | Bytes | SHA-256 |
|---|---:|---|
| `evidence/external-relay/install_tool_loop_owner.json` | 23,596 | `daeae4b1cdb703768f37a0cde9adb6f4092f4a6eff5ac3dbb9f75f8d6e14f2d0` |

`ownerCapture.test.ts` validates every captured ToolCallResult envelope and
every successful body with Draft 2020-12, including nested response items
and formats, and checks the transport refusals, 204 and inner error bodies.
The same response validator runs inside the existing X4 runner test before
it writes a capture, so its regeneration command rejects invalid R8 bodies
even when the standalone capture test is filtered out.
`owner-tools-response-schemas.json` contains the 14 public operation response
schemas and their reference closure, copied from the agreed OpenAPI revision
and identified by its source path and digest. CI uses that public snapshot.
For a cross-repository check, set `LLV_CELESTIA_OPENAPI_FILE` to a read-only
export of Celestia's `apps/backend/docs/openapi/public_moderation_openapi.json`
and run the test by path through the isolated gate runner. The test requires
all 14 responses and every referenced definition to match the snapshot.
They also match Celestia main `0997461ccf4d6e8752d03d3df2ed40ebc8187659`
(full OpenAPI digest `a517e69dc0f0b19ed604dfe8d2612efdbcb4ca1396cfcfdf187fc6cdfe7bcb11`).

The amended wire list retains its agreed bytes. Owner tools stay OFF on both
sides; this capture authorizes neither enablement nor deployment.

| File | Bytes | SHA-256 |
|---|---:|---|
| `owner-tools-index.json` | 6730 | `13ffb1c99fde7ce1e74f3c7127f870b2a2c56dfc9e08a05984ae729dc926b93f` |
| `owner-tools-off-v3-hashes.json` | 4652 | `df6899a7f7d3ad4d562463b08dd55e7e0a0e93e797a5802b1d7e848224e6b144` |
| `owner-tools-off-runner-hashes.json` | 2879 | `709baf921762e4e9fdab4ab70eafd6141b0f7da7bac342d65ea7741374f9e9e2` |

Original X4 capture before the R8 correction: 22,956 bytes, SHA-256
`791d1c97d8da0359927fb909dca6cc05839ff88e772ac2c65fd591695599367b`.

## Owner private chat and publication

`install_owner_private_loop.json` is generated by `ownerPrivateLoop.test.ts`
through the production destination selector, claim builder, Telegram sender,
publish transport and decision runner. The copied answer is decoded from the
sent copy button. The owner-tier settings have separate captured cases with
distinct request identities and advisory poll publications.

| File | Bytes | SHA-256 |
|---|---:|---|
| `install_owner_private_loop.json` | 7146 | `495e43237f086390d2e64caf4ac21e1bc3ba7241af8f4107065fdaecf4fe41b5` |

The ordinary test compares each complete captured payload to its stored case. Set
`LLV_RELAY_PRIVATE_LOOP_OUTPUT` to a scratch file to export it through the
same test, using isolated HOME, XDG, TMPDIR and LLV_STATE_DIR and a closed
loopback Viewer control URL. See `docs/design/telegram-relay-publication.md`.


## Owner group history (H1–H3), dark

The install reads the operator's IANA zone from `operator-settings.json` via
`operatorTimeZone()`. The pairing-authenticated endpoints use the existing
owner-tools switch, default OFF. Agents and voice read one page per call;
continuations retain the first page's explicit local dates and zone. The
operator's decision permits ordinary installation agents and voice callers,
including team members who direct them; live relay replies in Telegram are
refused. The direct browser route remains operator-only.

The authoritative Celestia document is `docs/design/relay-owner-group-history.md`,
introduced at `507ac6e0` and unchanged at main `8e1a0904`: 34,077 bytes,
SHA-256 `becc3785513c31c22411a00af4f8b7a2b3eea6348ef0c4ec097670d18fed5996`.
The strict response schemas match its `OwnerHistoryGroups` and `OwnerHistoryPage`
definitions. Authors' ids are discarded before presentation. MCP receipts
never store this read, and voice tool records contain only status and count speech.

`evidence/external-relay/install_owner_group_history.json` is a recorded API run
against the local synthetic double in `ownerHistory.fixture.ts`, with no call to
Celestia. It covers all nine cross-check scenarios and redacts credentials:
28,729 bytes, SHA-256
`1fa1865c6e8611f8252a8c769faa816303d545c828b379e7368a6fa0e2058f0a`.
Set `LLV_RELAY_WIRE_OUTPUT_HISTORY=1` when running
`src/lib/externalRelay/ownerHistory.test.ts` to regenerate it. The recording test
validates scenario statuses and credential redaction before writing, even when
selected by name. The build report names the commit containing these bytes.


On-demand discovery fixtures, copied byte for byte from service revision `c3dcbb66b3`:

| File | SHA-256 |
|---|---|
| `claimed_tools_on_demand_owner.json` | `2718a2057a2fcc23376c9919597508e20576ac1cb5ac1e4a94d7d25a26f0f2d9` |
| `lookup_bodies.json` | `9a4d0939395368c537af193127ca985fcb78b16c8de6b821eac50efb0aef15f9` |
| `lookup_results.json` | `965de49cc36a455c141b789e03d36a0738e27df29c461f7c355b7be3b1483160` |

## Read-tool images

`tool_result_images.json` is copied byte for byte from the service's
`apps/backend/tests/fixtures/relay_v1/tool_result_images.json` at revision
`ff616e1956c9234cd9507cd58ad035bfede3e725`: 2,015 bytes, SHA-256
`176fdbef0f50b83973a21f998692d7f6df31d1df7da63011309bb5d27a2bd3a6`.
The source README and `docs/design/relay-slice2-direct-tools.md` section 4.5
were checked through the source API on 2026-11-13. All refs and opaque
identifiers are synthetic.

Decode `ToolCallResult.output` as JSON: avatar/photo descriptors are in
`media[]`; video frame descriptors are in `selected_frames[].file`. Ready
photos carry a request-local ref; unavailable photos carry their availability
reason without a ref. Downloads require negotiated `relay_media_in` and the
current pairing and lease. The source fixture expiry is intentionally fixed;
tests bind expiry, byte length and frame encoding to their synthetic downloads.

## Avatar image seeds

Pass `seed_media_refs` to either image tool using ready inbound image refs or
image refs successfully downloaded from earlier read-tool results in the same
request. The optional array accepts one to ten unique refs in submitted order.
Both `requester_context` and `relay_media_in` must be negotiated.

`avatar_seed.json` is mirrored byte for byte from the paired service's
`apps/backend/tests/fixtures/relay_v1/avatar_seed.json` at reviewed revision
`e29441330685e4ff2e5d0709f35189f18534a621`, Git blob
`adbfecae8821039ac2de15a312152da60294f051`, SHA-256
`def8750ba2ce52f604c4a3e519b01502736b2b15c6bdb4ed5cb9f58c4dd02ba7`.
The source generator was inspected: users, files, call IDs and opaque refs are
synthetic. Its `negotiated_features` contains both required features.

The fixture confirms that the service deduplicates the current avatar when it
is also submitted as a seed, and places the current avatar before explicit
seeds when `use_current_profile_photo` is true. The client forwards arguments
without rewriting them. Roles, chat membership, seed resolution and charging
remain service decisions. Unknown and unavailable seeds may be denied by the
service; the client preserves that answer. A successful `generate_image` call
does not establish that every seed was used: the service can skip unreadable
seeds when another input is readable. An unreadable admitted seed for
`update_self_profile_photo` is denied with `invalid_arguments` without charge.

`avatarSeed.test.ts` drives every example through the real tool loop and an
isolated HTTP double. It freezes download time for the fixture's fixed expiry
and binds descriptor byte lengths to synthetic PNGs; submitted call arguments
and service result outputs retain their fixture values. Unknown refs, refs
from another request and eleven seeds are refused locally before dispatch.

`action_finality.json` is the synthetic producer sample at revision
`2450d7318a0f`, copied byte for byte (SHA-256
`76e00df4fdacaa335d91b3d3db55fb1ff7ffc85a77863d66a00b1e05e0cc7351`).
`actionFinality.test.ts` replays it through the HTTP client and consumer loop.

The existing action wire captures include bounded receipt reads and the reply
that a posted confirmation's eventual outcome is unavailable to the client.

## Guest answers

`claimed_guest_owner.json` is copied byte for byte from the paired service's
`apps/backend/tests/fixtures/relay_v1/claimed_guest_owner.json` at revision
`f27ca4e08746f685f54ea19084c82b5f64403848`: 4,721 bytes, SHA-256
`61d6d384f956e70d9b0097da80ab855772b4091a5184efa41bf3e1d4df9ca4f5`.
The design at that revision, `docs/design/relay-guest-mode.md` sections 3.1
and 4, limits arbitrary history-item media to guest photos. Documents retain
the trigger/direct-parent rule. All fixture identifiers are synthetic.

The claim advertises `relay_guest_answers` together with `requester_context`.
Guest requests preserve `delivery`, require final-only delivery and handoff-only
service tools, and offer handoff even with an empty index. Neither structured
answers nor native owner answers accept ignore. Final text is bounded by
`answer.max_chars`, has `reply_to: null` and carries no rich parts. Descriptor
progress steps are also suppressed. History photos retain their own item and
reference; unsupported input is refused and unavailable descriptors remain
explicit model context. Existing non-guest media scope is unchanged.

`install_guest_loop.json` is emitted by `guestMode.test.ts` through the real
claim builder, HTTP client and decision runner, with synthetic inference ports.
Its baseline uses the exact guest request above. The runner selects the
restricted ephemeral profile for guest delivery with either setting of owner
tier. The requester selector still identifies the verified owner, while guest
execution has no host tools, shared transcript or memory. Other conversation
items remain escaped data. The tests cover both owner-tier settings, both
tool-index sizes, reply/handoff, ten native input photos and rejection of an
eleventh reference and per-item removal of a history document. Follow-up probes
cover successful and failed Claude/Codex guest turns, ordinary owner continuity, another guest
turn in the same and another chat, and Cloud's ephemeral thread confirmation
and isolated native fallback.

Run `bun test src/lib/externalRelay/guestMode.test.ts` through the gate wrapper
in an isolated export. Set `LLV_RELAY_GUEST_LOOP_OUTPUT` to a scratch output to
regenerate the capture; otherwise the test compares its complete bytes.
Isolate HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR, and set
LLV_VIEWER_CONTROL_URL to a closed loopback port. This capture proves no live
service delivery; that cross-service rehearsal belongs to the paired seats.

The service keeps ordinary sends behind `relay_send.py` `_authorize`; its
repository `publish_message` also refuses another person's positive chat id.
`delivery_allowed` rechecks the guest requester against the current pairing
owner for final guest delivery. These checks were read at the pinned revision. The client neither derives a destination from
opaque chat/message keys nor supplies one for guest delivery. Without
`owner_delivery`, ordinary late owner replies retain pending-delivery-context and make
no send/publish request.

Historical non-guest captures and their pinned hashes retain their original bytes.
Compatibility tests apply the additional claim feature when comparing current
claims; non-guest prompt, schema, call and completion pins remain unchanged.
The nearby action-finality lane also edits `prompt.ts` (tool-round framing) and
this README. Guest framing changes `answerPrompt` only. PR #4051 also edits
`protocol.ts` (attachment selectors), `runner.ts` (tool-result image collection),
`mediaInputValidation.ts` (seed expiry/preview bounds) and `runner.test.ts`.
Guest parsing, action selection, progress and photo scope are separate hunks;
both changes must survive integration.

The shared path is service claim → `requestSchema` → runner admission and
`ownerTierFor` → prompt/schema and media preparation → checked decision →
completion. Tool-index hydration starts only for advertised direct tools, which
guest validation refuses. The guest guard precedes owner/prototype selection
and reply-chain resolution. Request-local engine configs disable persistence
and automatic memory. Guest answers use the existing secret scrubber before
final validation. A missing delivery field keeps the prior defaults.

| Guest capture | Bytes | SHA-256 |
|---|---:|---|
| `install_guest_loop.json` | 845 | `3397b1f7c5bdf32f195fc2534a562413bebf5d3fba446d15cbda742b28a5ab41` |
