# Automatic long-text attachment

A 30,000-character Cyrillic message (60,000 UTF-8 bytes) was posted to
`/api/runtime/send` on an isolated Next.js Viewer before the change. HOME,
TMPDIR, XDG_CONFIG_HOME and LLV_STATE_DIR all pointed to private directories;
CLAUDE_CODE_TMPDIR pointed at the private temporary directory. The control URL
was `http://127.0.0.1:1`, and the runtime socket was an absent private socket.
A synthetic structured conversation was registered in the private state.

The exact answer was HTTP 413:

> structured message text exceeds the 32000-byte envelope bound

The record is [observation.json](../../evidence/long-text-attachment/observation.json).
No delivery reservation was created by that refusal.

## Behavior

Both `/api/runtime/send` and `/api/conversation-host` (also mounted at
`/api/tmux`) plan the final text including attachment paths. When its UTF-8
size exceeds 32,000 bytes, the full original text becomes `message.txt` in the
existing inbox-file batch. Filename collisions receive the existing numeric
suffix. The replacement names the file, instructs the agent to read it in
full, and includes all attachment paths. Images retain their original delivery
channel. The runtime envelope guard remains in place.

A generated file is additional to all five operator files; it must still fit
the 100 MiB per-file and 200 MiB total attachment limits. Stored upload
references count by their original byte size. A conversion that would
exceed those limits refuses before writing, with instructions to attach a text
file. A short message keeps its current delivery bytes and trimming behavior.
Native history injection keeps its existing contract.

Seat `send_message` calls get the same fallback because they use `/api/tmux`
and the same local inbox. Server callers and the composer therefore have the
same delivery behavior. Retry keeps the original client key and rewrites no
accepted file. Unknown delivery outcomes keep their attachments.

The outbox preserves the original text for retry and Copy. The delivered
marker's second line carries the operator's opening words (one line, 160
characters at most, never splitting a character). The sent bubble shows those
words clamped to two lines, and under them one caption row: the count of the
operator's own attachments, when there are any, beside a bordered
`message.txt` chip with the same file icon as the composer tiles and a hover
state. The generated file is never counted, so a message with three files
reads "3 attachments" beside the chip. The marker also lets the shared message
row draw the same bubble after transcript adoption and on another device.
The chip recognizes POSIX, Windows drive and UNC inbox paths.

## Verification

Focused tests cover the 30,000-character refusal-to-file transition, identical
short-message bytes, retry under the same key, filename collisions, three
operator files, images, a full five-file batch, the exact UTF-8 boundary,
attachment-path overhead, and refusal before writes when conversion exceeds
file limits. A production-queue test first gets the old 413, then admits the
converted message under that original key with a durable held reservation.

The existing conversation-window browser driver runs the real composer and
message rows over its synthetic host. Its long-text case sends a 30,000
character message, with and without three operator files, at 1440 and 390
pixels in light and dark, in both languages, then retries at both widths. It
requires the opening words in the bubble (never a bare counter), at most two
lines of them, the operator's count without the generated file, a chip with a
non-transparent fill, a border, the line icon and a changed hover colour, no
overflow, and the same words, count and single chip after transcript adoption.
The host responses in the browser fixture are synthetic; server tests check
the real inbox bytes and production queue admission separately. This check
launches no provider agent.

Run the browser case with an installed Chromium:

```sh
LLV_CONVERSATION_BROWSER_TEST=1 CHROME_BIN=<chromium> \
  bash scripts/gate-slot.sh bun test \
  src/components/conversation/conversationWindow.browser.test.tsx \
  --test-name-pattern 'automatic long-text attachment'
```

Use isolated HOME, XDG_CONFIG_HOME, TMPDIR, CLAUDE_CODE_TMPDIR and LLV_STATE_DIR
for every run. [readings.json](../../evidence/long-text-attachment/readings.json)
records the measured chip, caption and excerpt readings for each frame.
Frames are written to `.artifacts/long-text-attachment/`.

Rendered frames retained in review history: [desktop, light, Ukrainian, three files](https://raw.githubusercontent.com/Latand/delegatus/013b56f5b78c0d7e2af9cacbb2130ba7e23ccca7/.artifacts/long-text-attachment/1440-light-uk-files-send.png),
[desktop hover, dark](https://raw.githubusercontent.com/Latand/delegatus/013b56f5b78c0d7e2af9cacbb2130ba7e23ccca7/.artifacts/long-text-attachment/1440-dark-en-plain-send-hover.png), [phone, dark, three files, after adoption](https://raw.githubusercontent.com/Latand/delegatus/013b56f5b78c0d7e2af9cacbb2130ba7e23ccca7/.artifacts/long-text-attachment/390-dark-uk-files-send-adopted.png),
[phone, light, plain conversion](https://raw.githubusercontent.com/Latand/delegatus/013b56f5b78c0d7e2af9cacbb2130ba7e23ccca7/.artifacts/long-text-attachment/390-light-en-plain-send.png).
