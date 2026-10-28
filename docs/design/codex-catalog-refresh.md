# Catalog refresh after Codex protocol support

This is the next Opus UI slice. The backend admits Codex 0.164.0 alongside
0.154.0, 0.159.0, 0.162.1 and 0.163.0. It accepts `gpt-6.1-terra` for launch,
role mappings and conversation reconfiguration, with image input and the
observed low, medium, high, xhigh, max and ultra effort ladder. The installed
client remains 0.162.1 pending deployment and safe updater admission.

## Choices and history

Offer these verified Codex choices for fresh selections: `gpt-6-astra`,
`gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-6-luna`. Offer Haiku 5.5 through the
verified `haiku` alias or `claude-haiku-5-5` pinned id without duplicate rows.
The observed Terra minimum CLI version is 0.159.0.

Keep historical model ids and their labels interpretable, including saved
GPT-5.6, GPT-6-Sol and Haiku 4.5 selections. Retire old choices from fresh
menus while retaining a saved current selection and transcript provenance.
`launchModelIds` maintains Codex wire admission separately from presentation.
Preserve stored role, project, pipeline and resume values, the approved role
defaults and the relay Cloud runtime fixed to `gpt-6.1-sol`.

Update the shared catalog presentation and check all six consumers:
`AgentRuntimeControls`, `ReasoningControls`, `RuntimePill`, `DraftRuntimePill`,
`AgentMappingTable` and `ExternalRelaySection`.

## Generated images and callback projection

`src/components/feed/parse.ts` currently loses the `fileId` of generated
images when constructing a synthetic success with empty output. Preserve
the durable identity, including migration items containing both `fileId`
and an empty `result`; keep older inline results readable. Use the existing
authorized attachment path for retrieval and show its loading and failure
states. Confirm that path before adding transport behavior.

Extend the projected question-response coverage in
`src/components/runtime/ConversationAttention.test.ts` to the new pin. The
backend callback router retains its generated 0.162.1 type closure because
all 80 retained files match 0.164.0 byte for byte.

## Verification and completion

Use the existing board, conversation-window and phone browser drivers.
Inspect English and Ukrainian, light and dark, at 390px, desktop and an
intermediate width. Cover fresh choices, saved legacy selections, top effort
tiers, narrow controls and both generated-image representations. Keep
account files, receipts, transcripts, browser profiles and updater custody.

Run the Opus frontend, review/fix and visual-critic/fix stages on this same
task. Deployment and installed-client verification remain subsequent work.
After the serving release contains this support, the packaged
`codex-update.ts check` command requests the authenticated controller's
compatibility-gated update. The switch still requires zero Codex processes;
retain that admission and the existing rollback and report recovery.
