# A failed image message on the stage installation: incident correlation

Status: read-only production audit, 2026-11-08. It supersedes the architect
brief of the same date. Base revision `66f9cc54` (main). The installation
inspected runs release `032c3c98`. Line numbers refer to `66f9cc54`. For every
file cited here, `git diff 032c3c98 66f9cc54` is empty, except
`src/lib/runtime/http.ts`, where the only change adds a member-admission step.
No product change has been made.

## 1. Originating requirement

Operator correction, 2026-11-08 (verbatim, with redactions). "[member]"
replaces a team member's first name, and "[account]" replaces an account name:

> «там треба розібратися чому на dev [account] - на стейдж сервері селестііі
> чому [member] повідомлення в делегатус не відправилося, і потім не працювалаа
> кнопккаа надіслати повідомлення , повторне як буде збренгікати ? там ж може
> бути інше , він просто заново скопіював текс т і відправив, просто те що не
> діставилося - те не дійшло»

Restated: on the Delegatus installation that runs on the stage server, a team
member's message was not delivered, and «Send again» did not work afterwards.
The member then copied the text and sent it as a new message. That copied send
is separate, and it is evidence about neither the original nor its retry.

## 2. Which installation

| Observation | How it was observed (UTC, 2026-11-08) |
|---|---|
| The machine running this stage serves a different public name through its own proxy. Its Viewer listens only on loopback. It is installation **A**. | Hostname, interface addresses, listening sockets and the proxy configuration's site names, 10:26–10:27 |
| The stage address from the incident resolves to a different host, **B**. Its TLS name matches. An unauthenticated `GET /` answers `401 {"code":"member_required"}` from a Delegatus Viewer behind a proxy. | DNS lookup, `openssl s_client`, `curl -D -` with no credentials, 10:27:09 |
| The hosting project's own instructions name the SSH alias for its stage server. Its `AGENTS.md` points to the Telegram-testing runbook, and the runbook says `ssh <stage alias>`. That alias resolves to the same address as B. This existing read-only route was used. No new key, grant or setting was created. | `~/.ssh/config` host names only; repository grep, 10:27 |
| On B, a user service runs a Delegatus Viewer from release `032c3c98` (2026-11-03, #3577). It also runs a runtime host from the same release, started 2026-11-03 18:21. A user-level proxy maps the public port to the Viewer. | `ps`, `git log -1` on the release checkout, the proxy file's site lines, the service's `systemctl --user` unit, 10:27–10:28 |
| That project's own application (bot, web app, relay) is a separate deployment on the same server. None of it is involved here. | Project runbook; process list |

The previous brief's §4 named B's records as the only discriminator. They were
read directly through that route, and no relay to another seat was needed.

## 3. Records read on B (all read-only)

Stores: `team/team.sqlite`, the runtime journal (`runtime-events-<install>.sqlite`), `activity/requests-2026-11-08.jsonl`, the Viewer's user journal, the inbox and runtime-image directories, and modification times under the state directory. SQLite was opened with `readonly: true`. Window: 2026-11-07 17:00 to 2026-11-08 10:30, read 10:28–10:35.

| # | Fact | Source |
|---|---|---|
| R1 | The sender is an active team member with role `member` and one session, created by invite on desktop Safari. The session is unrevoked, expires 2027-03-25 and was last seen 10:31:03. | `members`, `sessions` |
| R2 | The member's only accepted message in the window is a send at **09:52:48.363**. Its client key is `op_0314bbd0…` and it went to the project seat's conversation `dfd8c814…`. There is one `message.sent` event. The member's previous accepted send was 2026-11-07 17:10:49. | `message_authors`, `events` |
| R3 | That send was admitted at 09:52:48.283 as operation `01842208…` and **delivered** at 09:52:50.253 with **`imageCount: 0`**. | runtime journal `operations` |
| R4 | The screenshot's bubble text equals R3's text. The screenshot shows the caption for one image. **R3 is therefore the copied-text resend, and it carried no image.** | Visual comparison; text not reproduced |
| R5 | No operation carrying an image was admitted on B after 2026-11-07 10:33:40. That operation was an earlier image message to the same conversation, delivered. The newest file in the runtime image store has that same time. Nothing was written to the inbox in the window. | `operations` where `imageCount > 0`; directory listings |
| R6 | Between 09:30 and 10:05 the conversation's host was healthy. It advertised `imageInput.supported: true` (PNG, JPEG, GIF, WebP; 16 images; 10 MiB each) in every `session-status` event. It accepted and delivered other sends at 09:41:30, 09:52:48 and 10:04:00. | runtime journal `events`, `operations` |
| R7 | The Viewer journal for 09:40–10:05 has two unhandled errors, and neither is on the send route. One at 09:49:15 is on the resources route. One at 09:54:07 comes from the transcript-host reconciliation. No refusal of a send is logged, because the send route does not log refusals before admission. | `journalctl --user -u <viewer service>` |
| R8 | The proxy in front of B keeps no access log. The per-minute performance summaries sample runtime-host calls without routes or statuses. Neither can show the HTTP status of a browser request. | Proxy file; journal summaries |

**Conclusion from the records:** the original image message never reached
runtime admission, and neither did any retry of it. B holds no durable trace of
either. Text-only delivery to the same conversation worked minutes later, and
so did image delivery on the same release the day before.

## 4. Candidates after the records

The browser shows a failed row with the generic reason «Не доставлено» and the
action «Send again». The route's refusal surface (`dispatchRuntimeCommand`,
`src/lib/runtime/http.ts`) is matched against R1–R8 below:

| Candidate | Verdict | Why |
|---|---|---|
| Sign-in failure (401) | Excluded | R1: the session is valid. The text send at 09:52:48 used the same session, and a 401 would read "sign-in expired". |
| Cross-origin or membership refusal (403) | Excluded | R2–R3: the same member was admitted to the same conversation, from the same browser, minutes later. |
| Host unavailable, ownership unavailable, inbox write failure (503, `delivery: "refused"`) | Very unlikely | R6: the host was healthy and admitting. Such a refusal also returns the draft and removes the row when the composer is empty (`TmuxComposer.tsx:3900-3934`). |
| Admitted operation that then failed (K3) | Excluded | R5: no operation exists. |
| Client sends nothing on retry after a 4xx outside the refusal set (K1, D1 in the previous brief) | Excluded for this incident | For an image send with no files, the statuses this route can return are 400, 401, 403, 413, 415 and 503. Of these, 401 and 403 are excluded above. The others are inside the composer's refusal set, so D1 cannot be reached. It stays a real code defect, and it is not this incident (§7). |
| **C1: the route refused the image deterministically**, with 400 (invalid or truncated base64), 413 (too large) or 415 (MIME not PNG, JPEG, GIF or WebP, or a signature mismatch). | **Remains** | `admitRuntimeImagePayload` (`src/lib/runtime/runtimeImageAdmission.ts`). The composer sends `file.type` unfiltered for any `image/*` file (`imageAttachments.tsx:148`, `:389`), so a Safari TIFF or HEIC reaches the server and gets a 415. None of these sentences matches a row pattern (`messageRow.ts:141-150`), so the row reads «Не доставлено». «Send again» replays the sealed envelope under the same key and gets the same refusal, which is deterministic. The route logs nothing. |
| **C2: the composer's own image gate**, `structuredImagesDisabled` (`TmuxComposer.tsx:2088-2095`, `:4033-4036`, `:4077`, `:4222`) | **Remains, less likely** | When the browser's session view lacks `imageInput.supported`, the row fails locally with "no negotiated image capability" and no request is made. Every retry does the same. The server advertised support (R6), so C2 needs a stale or partial session view in that browser. |

C1 and C2 predict the same server records: none. Only the member's browser can
tell them apart. Three browser records would settle it: the
`sessionStorage["llvOutbox:<conversation>"]` entry for the failed row (its
`error` sentence), the IndexedDB `llv-composer-*-v1` row for its key (its
`refusal.status`), or the image's file type. This audit cannot read any of them.
That device is not reachable through any configured access, and reaching it
would mean contacting the member.

## 5. What is established about «Send again»

Both remaining candidates fail **deterministically**, and the row cannot say so:

1. The failure sentence never reaches the person. The generic reason hides
   "unsupported image type", "image is too large" or "no negotiated image
   capability".
2. «Send again» is offered for a failure that the same bytes can never pass.
   Pressing it repeats the refusal: under C1 it sends one request with the same
   key, and under C2 it sends nothing. To the member that looks like the button
   does not work, which matches the report.
3. The server records no refusal before admission, so neither the operator nor
   an audit can see the cause afterwards (R7, R8).

The copied resend succeeded because it dropped the image (R3, R4). That
confirms the operator's reading: what was not delivered (the image) never
arrived.

## 6. Minimal repair brief

Each item is correct under either C1 or C2, and none depends on choosing
between them.

- **F-a: log refusals before admission (server).** In `dispatchRuntimeCommand`,
  one structured line goes through the existing logger for every non-2xx exit
  before admission. It records status, `code`/`error`, the conversation id, the
  idempotency key, image count, file count and member id, and never text or
  bytes. Test: an image refused with 415 through the real handler emits one
  line with those fields and no text. Test file: the runtime HTTP route's
  existing test.
- **F-b: name deterministic image refusals on the row (client).** Add patterns
  in `FAILURE_PATTERNS` (`messageRow.ts`) for the three image-admission
  sentences and for `composer.structuredImagesProtocol`. Each gets an
  `outbox.failure.*` reason in en and uk. Test: `messageRow` unit cases.
- **F-c: offer the right action (client).** For a failure whose recorded refusal
  is deterministic for the payload (status 413 or 415, or the local image
  gate), the row offers the existing «Back to the composer» action instead of
  «Send again». Text and attachments return exactly as the existing editor
  return does. Test: `OutboxBubbles` and `TmuxComposer` DOM cases for 415 and
  for the gate. A generic 400 and transient failures keep «Send again».
- Rendered check: one case in the existing conversation-window browser driver,
  at 390 px and desktop, in en and uk, light and dark, with before and after
  frames inspected visually.

## 7. Kept as code observations, not incident causes

These were reproduced earlier with synthetic bytes through the production
components. They are not supported by B's records for this incident, and no
storage change follows from them.

- **D1:** after a 404 or 422 refusal, an image message gets no second request.
- **D2:** after a remount, an image message has no «Send again».
- **D3:** the editor return carries text only.

## 8. Audit conduct and gaps

- Everything on B was read-only, with two exceptions. Both were small files
  this audit created by mistake and then removed, and each removal was
  verified:
  - a helper script copied to B's `/tmp` at 10:28, removed at 10:29:06;
  - a stray shell redirect that wrote a 44-byte file of process counters to
    `/dev/shm` at 10:36:18, removed at 10:36:33.

  Queries otherwise passed code as an argument. No process, service, setting,
  session, message or receipt was touched. No resend, replay or join link was
  used.
- **Gap:** C1 versus C2 (§4). Closing it needs the member's own browser state
  or the image's file type. No server-side access closes it. F-a closes it for
  any future occurrence.
- Exact time of the original: between 2026-11-07 17:10:49 (the member's
  previous accepted send) and 09:52:48. The conversation in which it was
  reported places it shortly before 09:52 UTC. No record on B holds it.

## 9. Current serving health of B (context only)

This is one snapshot, taken 2026-11-08 10:36:18–10:36:28 UTC through the same
read-only route, plus the Viewer journal for 10:26:30–10:36:30. It is context
for the separate lag and host audit. It is **not** a cause of the incident: the
incident predates the snapshot, and nothing here correlates with it in time.
Attributing load to host groups over time remains with that audit.

| Measure | Value | Source |
|---|---|---|
| CPU (16 cores) | 11% of the whole host busy over 5 s. The Viewer process used 13% of one core and the runtime host 2%. Load average 1.33 / 1.88 / 2.28. | `/proc/stat` and `/proc/<pid>/stat`, sampled 5 s apart; `/proc/loadavg` |
| Memory | The Viewer's RSS is 8.5 GiB with 74 MiB swapped. The runtime host's RSS is 190 MiB. The host has 62 GiB total, 39 GiB available and 3.4 of 16 GiB swap used. | `/proc/<pid>/status`, `free -m` |
| Pressure (PSI) | CPU some avg10 0.18; memory 0.00; I/O 0.00; all "full" figures 0.00 | `/proc/pressure/*` |
| Viewer event loop | 5 loop gaps in 10 minutes, at 772–965 ms, roughly every 2.5 minutes. Each ran alongside seat-tick work: `seat-tick.check` 1.8–2.9 s, `children` about 1 s, `rule-reports` 0.7–1 s, decoding up to about 220 KB of JSON. That is co-occurrence, not proven attribution. | `[viewer loop-gap]` lines |
| Waits and holds | 30 blocking waits, max 215 ms, none synchronous. 17 state transaction holds, max 366 ms. 0 unhandled errors. | `[blocking-wait]`, `[state transaction-hold]` lines |
| Measurement caveat | The `http.render` span in every loop-gap line reports about 4.7 days, which is the process's age. It is an accumulated or never-closed span and cannot be read as a request duration. | Same lines |

Reading: at the time of the snapshot B was lightly loaded, with no memory or
I/O pressure. Its main visible stall was a sub-second Viewer loop gap every
few minutes, occurring alongside seat-tick work. Nothing here would refuse a
send request.
