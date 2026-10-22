# Voice

Delegatus can take your messages by voice and read answers aloud. This page
covers dictation, read aloud, voice conversations and Voice Delegatus.

## Dictation

The microphone button in the composer turns speech into text.

- **Default.** It runs on your machine with faster-whisper, and no audio
  leaves the computer. Run `scripts/setup-whisper.sh` once to install it.
- **Cloud backends.** Switch this machine to ChatGPT through your Codex
  login, ElevenLabs or Soniox. Pick one in the setup guide's **Voice** step,
  from the **Dictation** row of **Settings** in the sidebar's ⋯ menu, or by
  right-clicking the microphone.
- **Keys.** The Voice step stores an ElevenLabs or Soniox key without
  showing it again and checks that dictation works.
- **Locked choice.** `DELEGATUS_TRANSCRIBE_BACKEND` fixes the backend and
  locks the menu.

See [docs/transcription.md](../transcription.md).

## Read aloud

The speaker button on an answer reads it with OpenAI,
ElevenLabs or Soniox speech, billed to your own API key. Right-click the
button to pick the provider. With Soniox the answer in view also starts from
the conversation header, and the first sentence plays as soon as it arrives.

## Voice conversation

A Codex agent that Delegatus hosts offers a
continuous voice conversation from its composer.

## Voice Delegatus

Switched on in Settings, a floating character on the desktop answers
questions about the board by voice and sends work to the project's
orchestrator when you ask. It writes each task in its own words, in your
interface language unless you ask for another: what to do and why, the expected
outcome, and the context needed from your conversation and the board. Each
task can contain up to 4,000 characters. A short quote may preserve your key
phrase. It keeps your scope and sends independent requests separately.
General knowledge, chat and content it can provide itself stay with the voice;
it answers them or declines, even if you ask to send them to the orchestrator.
It speaks the orchestrator's new reports once and keeps them in the call's
transcript.

- **Through the API (with a key).** The default. It uses your OpenAI API
  key, has a monthly spend cap, and shows what the call and the month cost.
- **Codex V3 (subscription).** Needs no key and shows the call's length and
  the plan's usage window.
- **On a phone.** The voice is a small head above the composer. **Hide**
  removes it and ends a live call; **Show voice** in the ⋯ menu brings it
  back.

### What a call did

A tap on the character (on a phone, **Conversation** in the head's menu)
opens the call's transcript, also after a page reload or a Delegatus restart.
When more than one call is kept, a list at the top of the transcript opens any
of them; each entry shows the call's time, project and number of actions. Each
request to the orchestrator shows whether it was delivered, queued, refused or
failed, and why nothing was sent when it was not. An opened request links to the
orchestrator conversation it went to. Delegatus keeps your last 50 calls, each
for up to 30 days.

### Call memory

After each call Claude Haiku, on one of your Claude subscription accounts,
writes a short summary of what you asked, what was done and decided and what
is still open. The next call starts with up to five summaries from the last
week. The summaries stay on this machine, outside agent memory. The voice
settings list them with **Forget** and **Forget all**, and a switch there
turns remembering off.

### When the connection drops

A call that drops keeps what was said: a lost network, a provider session that
ends mid-call, a page reload and a Delegatus restart all leave the call's
record on this machine. The character says the connection dropped and offers
**Reconnect** (on a phone, in the head's menu) for 30 minutes, also after a
reload. Reconnect continues the same call: the voice starts with the
conversation so far, as much of it as fits the call-memory budget, newest lines
first and with a note of how many older lines it left out, and does not ask
again for what you already said. The call's transcript shows every part of the call,
with a line where the connection dropped. **Talk** starts a new call instead.
A part of a call that read a private Telegram group is not carried into the
reconnected call.
