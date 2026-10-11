# Codex subscription voice: slice 2 verification

This implements slice 2 of [the design](../design/voice-codex-subscription.md)
on top of slice 1 (#2706). The Codex path stays behind
`LLV_VOICE_BACKEND=codex`. Its dynamic tools use `runCompanionTool`, the
existing admission gate and the call's read ledger.

1. **Transcript and timing.** `codexTranscript.test.ts` replays the recorded
   flat role/delta and role/text shapes through the adapter and compares their
   segments, turns and fragment timing with `LiveTranscript`. Codex supplies
   no audio timestamps here, so notification receipt offsets provide timing.
   A done event seals its speaker without appending the full text twice or
   advancing the operator turn. Parts remain separate when a stdio batch
   shares one receipt millisecond. `codexConversation.test.ts` verifies that
   short credential fragments stay masked in every published snapshot and
   stored transcript, including across completed parts.
2. **Duplicate handoff.** The conversation test replays two recorded handoff
   shapes, one backing turn and its steered user message, with fixture words
   and identifiers. One delegation reaches the fixture inbox. Replaying the
   tool request and polling concurrently keep the delivery count at one.
3. **Hang-up admission.** Dynamic `end_conversation` refuses “finish the task”
   and admits “заверши розмову”. The admitted call sends one stop RPC and
   closes with reason `tool`. The recorded operator inputs carry turns 1 and
   2; admission reads those inputs through the existing gate.
4. **Reports.** Three reports supplied out of order produce three
   `appendSpeech` RPCs in sequence order, once each across concurrent polls.
   Speech and context RPCs share one ordered writer for the call.
5. **Project context.** Switching projects produces one developer message via
   `thread/inject_items` and one developer `thread/realtime/appendText` with
   the same text. A following projectless request reaches the new project.
   A steered duplicate keeps its backing turn's original project and waiting
   confirmation. A later voice confirmation sends that original proposal
   once, even after the view switched.
6. **Prototype image.** The frame travels beside the text tool result as
   `inputImage` with a data URL. Frame bytes stay outside the textual result
   and transcript. The installed Codex schema checks the actual context and
   tool-result builders, including the image variant and unsupported-field
   negative controls. The live app-server accepted an image reply and
   completed its backing turn.
7. **Live canary.** A copied managed ChatGPT sign-in ran in an isolated home,
   configuration, state and temporary root on Codex 0.162.1 and Bun 1.4.0.
   Locally synthesized clips drove WebRTC. The real companion admission and
   `sendCompanionMessage` wrote only to a fixture orchestrator inbox behind
   a stand-in route. One ordinary request and one request confirmed by voice
   were delivered; voice hang-up ended the call with reason `tool`.

The initial canary delivered two unique requests, with zero duplicates, four
handoffs, one spoken confirmation, one admitted hang-up and one stop RPC.
An extended canary repeated those results and also accepted one image reply,
one project injection and one realtime context append, over 68.06 seconds.
A further run refused an unknown project selector supplied by the model and
delivered nothing; its owned processes exited. The final run registers named
fixture projects and uses the production project resolver. Its results:

| Measurement | Final canary |
| --- | ---: |
| Ordinary inbox sends | 1 |
| Sends after voice confirmation | 1 |
| Duplicate / unexpected sends | 0 / 0 |
| Handoffs | 5 |
| Successful voice confirmations | 1 |
| Admitted voice hang-ups / stop RPCs | 1 / 1 |
| Closed reason | `tool` |
| Report speech RPCs, in order | 3: 1, 2, 3 |
| Project injections / realtime text appends | 1 / 1 |
| Image tool replies | 1 |
| Call duration | 71.37 s |
| New Codex session files / surviving helpers | 0 / 0 |

Raw wire, audio, authentication material and PID ledgers stay outside this
public repository. Cleanup addresses only the recorded Viewer stand-in and
leased helper PIDs. The successful initial, extended and final calls each
created zero Codex session files and left zero surviving helpers. Every
attempted call's Viewer stand-in and both leased helper PIDs were recorded
privately; cleanup reported zero survivors for the refused-selector run too.

The failing-first checks exposed ignored transcripts, premature hang-up,
unregistered send tools, missing speech/context RPCs, a dropped image,
unmasked short credential fragments, retargeted steered calls and merged
parts sharing a receipt timestamp. The focused files cover 90 passing tests:
`codexConversation.test.ts` (7), `codexTranscript.test.ts` (2),
`codexProvider.test.ts` (13), `codexVoiceSchema.test.ts` (1),
`liveTranscript.test.ts` (6) and `liveSession.test.ts` (61).

Checks use explicit test paths through `scripts/gate-slot.sh`, with `HOME`,
XDG directories, `TMPDIR` and `LLV_STATE_DIR` under a private temporary root,
and a closed loopback `LLV_VIEWER_CONTROL_URL`. TypeScript and changed-file
ESLint pass. Publication privacy is checked from the merge base with main.
The companion imports no composer voice code. Plan-window UI, selecting Codex
by default and removing the API provider remain with slices 3 and 4.
