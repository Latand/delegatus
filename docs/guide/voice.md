# Voice

Delegatus can take your messages by voice and read answers aloud. This page
covers dictation, read aloud, voice conversations and Voice Delegatus.

## Dictation

The microphone button in the composer turns speech into
text. By default it runs on your machine with faster-whisper, and no audio
leaves the computer; run `scripts/setup-whisper.sh` once to install it.
You can switch this machine to a cloud backend instead: ChatGPT through
your Codex login, ElevenLabs or Soniox. Pick one in the setup guide's
**Voice** step, from the **Dictation** row of **Settings** in the
sidebar's ⋯ menu, or by right-clicking the microphone. The Voice step stores an ElevenLabs or Soniox key without
showing it again and checks that dictation works.
`DELEGATUS_TRANSCRIBE_BACKEND` fixes the choice and locks the menu. See
[docs/transcription.md](../transcription.md).

## Read aloud

The speaker button on an answer reads it with OpenAI,
ElevenLabs or Soniox speech, billed to your own API key. Right-click the
button to pick the provider. With Soniox the answer in view also starts from
the conversation header, and the first sentence plays as soon as it arrives.

## Voice conversation

A Codex agent that Delegatus hosts offers a
continuous voice conversation from its composer.

## Voice Delegatus

Switched on in Settings, a floating character on the
desktop answers questions about the board by voice and sends work to the
project's orchestrator when you ask. It speaks the orchestrator's new
reports once and keeps them in the call's transcript. Its settings choose
how a call talks. **Through the API (with a key)**, the default, uses your
OpenAI API key, has a monthly spend cap, and shows what the call and the
month cost. **Codex V3 (subscription)** needs no key and shows the call's
length and the plan's usage window. On a phone the voice is a small head
above the composer; **Hide** removes it and ends a live call, and **Show
voice** in the ⋯ menu brings it back. It remembers earlier calls: after
each call Claude Haiku, on one of your Claude subscription accounts, writes
a short summary of what you asked, what was done and decided and what is
still open, and the next call starts with up to five summaries from the
last week. The summaries stay on this machine, outside agent memory. The
voice settings list them with **Forget** and **Forget all**, and a switch
there turns remembering off.
