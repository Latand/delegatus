# Connect the GitHub App to another repository: one request, one confirmation

Implementation added 2026-11-01. Baseline code anchors are at `c97325311`. `origin/main` (`f5e0b67b2`) shifts only
`src/lib/mcp/server.ts` and `src/lib/mcp/bindings.ts`, by 34 lines.

## Originating requirement

Requirement, 2026-11-01: an agent requests repository access and Delegatus sends the operator one
confirmation containing GitHub's required action links. Delegatus completes discovery, credential
verification and declaration automatically.

**Should this be built: yes.** Without it, a new repository's stages write as the operator or stop,
and the only fix today is hand-editing a state file and the keyring.

## Decisions

1. **One seat tool, `github_app_connect`.** The server publishes the form, watches GitHub, stores the
   credential, declares the repository and reports back.
2. **The form is the existing decision form**, plus server-built links on a question. Question text
   is a plain `<p>` today (`src/components/prototypeReview/DecisionQuestions.tsx:88`), so a form
   cannot carry a clickable link. The Keys page does not change.
3. **Normal case: one link, one click.**
   `https://github.com/apps/<slug>/installations/new/permissions?suggested_target_id=<account-id>&repository_ids%5B%5D=<repository-id>`
4. **Private App: the same form carries two ordered steps, once ever.** GitHub has no single action
   that makes an App public and installs it, and no API for either.
5. **Discovery is bounded polling with the App JWT on `GET /repos/{owner}/{repo}/installation`.** No
   setup URL, no webhook, no App setting change.
6. **The click confirms only for the seat's own project repository.** Any other repository also
   needs a person's yes on the form (§5.2).

## 1. What GitHub documents (observed 2026-11-01)

Pages read whole through `docs.github.com/api/article/body`, each answering 200. REST schema:
`github/rest-api-description`, `api.github.com.deref.json`, version 1.1.4.

| | Page → section | Quote |
|---|---|---|
| a | Making a GitHub App public or private → About visibility for GitHub Apps | "If you set your GitHub App registration to public, any user on GitHub can install it and authorize it. If you set your GitHub App registration to private, it can only be installed on the account that owns the app." |
| a | Same → Private installation flow | "Private GitHub Apps can only be installed on the user or organization account of the app owner." |
| a | Modifying a GitHub App registration → Changing the visibility of a GitHub App | "Public apps cannot be made private if they're installed on other accounts." and, under Advanced: "Under "Danger zone," depending on the current visibility of your GitHub App, click either **Make public** or **Make private**." |
| a | Transferring ownership of a GitHub App → Transferring a GitHub App registration | "If transferring the app would uninstall it from your account, a warning will appear." |
| b | Migrating OAuth apps to GitHub Apps → Prompt users to install your GitHub App | "To pre-select any repositories your OAuth app had access to, you can append `/permissions` and query parameters to the install URL." |
| b | Same | "`suggested_target_id`: The ID of the user or organization that is installing your GitHub App. This parameter is required." |
| b | Same | "`repository_ids[]`: The repository IDs to select for the installation. If omitted, all repositories are selected." |
| b | Installing a GitHub App from a third party → Installing a GitHub App | After location, repositories and permission review: "Click **Install**, **Install and request**, or **Request**. The button that is presented depends on whether your organization owner must approve none, some, or all of the requested access for the app." |
| c | Requesting a GitHub App from your organization owner | "If you don't have permission to install the GitHub App on the organization, GitHub will send an email to the organization owner to notify them of the request. The organization owner can modify the repositories that you selected and choose whether to install the GitHub App." |
| c | REST: List installation requests for the authenticated app | `GET /app/installation-requests`: "Lists all the pending installation requests for the authenticated GitHub App." |
| d | REST: Get a repository installation for the authenticated app | `GET /repos/{owner}/{repo}/installation`: "Enables an authenticated GitHub App to find the repository's installation information." Answers 200, 301, 404. Same family: `GET /orgs/{org}/installation`, `GET /users/{username}/installation`. |
| d | REST: List installations for the authenticated app | `GET /app/installations`: "The permissions the installation has are included under the permissions key." |
| d | Webhook events and payloads → installation | "All GitHub Apps receive this event by default." |
| d | About the setup URL | "Bad actors can hit this URL with a spoofed `installation_id`. Therefore, you should not rely on the validity of the `installation_id` parameter." |

`target_id` is documented only as a field of the REST installation object, so the link uses
`suggested_target_id`.

**Visibility cannot be read from the App's own settings.** `GET /app` ("Get the authenticated app")
returns `id, slug, node_id, client_id, owner, name, description, external_url, html_url, created_at,
updated_at, permissions, events, installations_count`, with no `public` or `visibility` field; so
does `GET /apps/{app_slug}` ("Get an app"). No REST endpoint creates an installation or changes
visibility.

**Observed by me:** anonymous `GET https://api.github.com/apps/<public app>` answered 200 with those
fields. Anonymous `GET` of the preselected link on a public App answered 302 to login, keeping both
parameters in `return_to`.

**Unobserved, because the fences forbid an install and the live keyring:** the signed-in page behind
the link, so "one click" is inferred from the documentation; and this App's live `GET /app` body.
"Get an app" lists 404 without defining anonymous access, so an anonymous 404 stays a hint, matching
the seat's checks of 2026-11-01. The design holds if preselection is ignored, because discovery
verifies coverage. The first real click is the probe.

## 2. The baseline mechanism

- **Declaration:** `forge-app-repositories.json`, read at every launch
  (`src/lib/git/agentForgeCredentials.ts:19-47`). No code writes it.
- **Credential:** one keyring item per repository, read at `bin/forge-app-token.mjs:657-663`, holding
  the registration plus `installation_id` (`:145-146`, `:172-175`). No code writes it, and Keys
  deliberately excludes it (`docs/design/keys-settings.md:107`).
- **Proof on every mint:** `mintInstallationToken` (`bin/forge-app-token.mjs:159-226`).
- **Keyring reach:** the Viewer's container has no session bus (`docs/design/keys-settings.md:146`),
  so keyring work runs through the helper as a child (`src/lib/forge/appWrite.ts:75-97`).
- **A declared repository's writes never fall back to a person** (`CONTRIBUTING.md:88-91`), so a
  declaration without a working item stops its agents. §5.3 orders the steps for that.
- **Form precedent:** the issue-report approval, built on the server
  (`src/lib/prototypeReview/http.ts:145-154`), accepting only a person's explicit choice
  (`src/lib/issueReports/approvalForm.ts:70-76`).

## 3. The MCP entry

`github_app_connect { clientRequestId, owner?, repository }`, beside `issue_report` in the name and
replay lists (`src/lib/mcp/server.ts:142`, `:231`), posting to a Viewer route as
`publish_prototype_review` does (`src/lib/mcp/bindings.ts:8532-8536`). It never blocks, so there is
no wait parameter and no numeric input to clamp; the window is server-owned and returned as
`expiresAt`. `repository` takes a name, `owner/name` or a GitHub URL through `parseRepository`
(`bin/forge-app-token.mjs:89-104`); `owner` is optional when `repository` names it.

**Callers:** a designated seat with no deputy (predicate at `bindings.ts:2115`) or the operator's own
session (`:1722`).

**Idempotence:** replaying a `clientRequestId` returns the first receipt. A new id for a repository
with an open request publishes no second form, runs one fresh check and returns the current state,
which is how a seat reads status. The row key is the lower-cased `owner/name`, so two seats cannot
open two forms for one repository.

| `state` | Means |
|---|---|
| `awaiting_click` | Form sent, link unused. `prerequisite`: `none` or `app_private`. |
| `awaiting_answer` | A person's yes is needed: the App already covers the repository, or it is another project's. |
| `awaiting_owner` | GitHub holds a pending request for this account; an owner approves on GitHub. |
| `missing_repository` | The App is on the account without this repository. Carries `installationUrl`. |
| `verification_failed` | The mint proof refused. Carries the helper's reason; retried until `expiresAt`. |
| `connected` | Stored, proved, declared. Carries `installationId`, `changed`, `appliesTo: "new launches"`. |
| `expired` / `cancelled` | No click in the window / a person chose «Не підключати». A re-call opens a new request. |

Refusals, kept to identity and safety:

| `code` | Text |
|---|---|
| `not_permitted` | "Only a project's designated seat or the operator's own session asks to connect a repository." |
| `invalid_repository` | "`<input>` does not name a github.com repository; pass owner/name." Includes `.` and `..` names, which the pattern at `bin/forge-app-token.mjs:61` admits and which would rewrite an API path, and an `owner` conflicting with `repository`. |
| `app_credential_unavailable` | "No declared repository holds a readable GitHub App credential: unlock the credential store on this machine, or register the App first." |
| `github_unreachable` | "GitHub could not be read to check `<what>`; nothing was sent to the operator. Call again." |
| `form_refused` | The publisher's own message (`src/lib/prototypeReview/seatRounds.ts:138`). |

## 4. The one confirmation

**The request first reads, sending nothing:** App JWT `GET /app` (slug, owner); anonymous
`GET /users/<owner>` (id, type); `githubRepositoryLookup` (`src/lib/projects/forgeRename.ts:153`, id
and `full_name`, already through the machine's `gh` login for private repositories, then REST); App
JWT `repos/<owner>/<name>/installation`, then the account's installation; anonymous
`GET https://api.github.com/apps/<slug>`, where any answer other than 200 or 404 refuses as
`github_unreachable`.

**App-is-private rule:** the anonymous read is 404 and the account is not the App's owner (`GET /app`
`owner.id` against the account id). An App owned by the target account installs there whatever its
visibility.

| Case | Observed | Link(s) on the form |
|---|---|---|
| **A** | App already covers the repository | None; the person's yes confirms. |
| **B** | App on the account, repository not covered | Installation `html_url`. GitHub documents no preselection there, so the label names the repository to add. |
| **C** | No installation; App public or owned by the account | The preselected install link. |
| **D** | No installation; App-is-private rule true | Step 1: App settings. Step 2: the preselected install link. |
| **E** | App covers the repository, requested permissions are missing | App settings when the App registration lacks keys, then installation `html_url` to accept them. For the calling project's own repository, the verified grant completes without another answer; another project's repository requires the person's choice. |

One round, published with `publishPrototype` and `postPrototypeReviewToTelegram` as
`http.ts:164-165` does, so it reaches «Рішення», «Чекають на вас» and Telegram with no further code
(`src/lib/prototypeReview/read.ts:142-149`). Title «GitHub App для репозиторію»; options «Підключити»
(recommended) and «Не підключати»; language from `operatorLocale()` as at `http.ts:153`.

**Case C copy:**

> Підключити GitHub App до `<owner/name>`? Натисніть посилання, далі Install на GitHub: акаунт і
> репозиторій уже вибрано. Решту зробить Delegatus, відповідати не треба.

**Case D copy:**

> Підключити GitHub App до `<owner/name>`? Схоже, App приватний, а такий GitHub ставить лише на
> акаунт-власника. Потрібні два кроки, решту зробить Delegatus.
>
> [Крок 1, один раз: Advanced → Make public. Після цього App зможе встановити будь-хто на GitHub, а назад у приватний він не повернеться, поки стоїть на іншому акаунті. Бачите Make private? Цей крок уже зроблено.]
>
> [Крок 2: встановити на `<owner>`]

Step 1 links to `https://github.com/settings/apps/<slug>`, or
`https://github.com/organizations/<owner>/settings/apps/<slug>` for an organization-owned App; only
that base is documented, so the label names Advanced. Its last sentence covers a wrong hint. For
another project's repository the last clause of C and D becomes "потрібні обидва: Install і
«Підключити» тут". Each form passes the 300-character limit at the longest legal name; the two above
measure 292 and 281.

**Repository id unavailable:** no form is published. The service returns a named
`repository_id_unavailable` refusal before persisting a request, credential or declaration. Every
offered installation link therefore selects both the verified target account and repository.

**Installation appears without the repository:** the form closes and one case B form opens, at most
once per request.

**Form plumbing.** `PrototypeQuestion` gains `links?: Array<{ label; href }>`, at most two.
`DecisionQuestions.tsx:88` draws them, which covers the window, the column and the sheet.
`prototypeQuestionsSchema` stays `.strict()` (`src/lib/prototypeReview/input.ts:15-26`), so
`publish_prototype_review` refuses them and only this builder sets them. Telegram prints each as its
own `[label](<url>)` line after the question block, as `telegramPost.ts:33` does, and as `label: url`
in plain text; they survive the fallback that cuts question text to 80 characters
(`telegramPost.ts:40`). Polls keep text and options (`src/lib/telegram/bot/reviewPolls.ts:28-43`).

**Closing a form Delegatus resolved.** No server-side retire exists. `mutateSeatRound`
(`seatRounds.ts:112-123`) records a decision of kind agent, delivery already `sent`, with the outcome
as comment; the notice read then drops it (`read.ts:143`) and a late Telegram reply finds it decided.
The sent message's link stays harmless, because an installation made later needs a new request.

## 5. After the click

### 5.1 Polling

`src/lib/forge/appConnect.ts` holds the service and poller, started beside the loaders at
`src/lib/viewerInstrumentation.ts:391-403`; `src/lib/pipelines/**` stays untouched for the other open
lanes. Rows live in one `SqliteStateCollection`, shaped like `seatRounds.ts:18-23`.

- **Idle:** no work. A timer is armed only while an open row exists, as at
  `src/lib/orchestrator/seatChannel.ts:350-359`, each run checking `viewerReleaseOwnsTraffic()`
  (`:361`).
- **Active:** one helper child at a time, at most four rows per pass, async under
  `withViewerOperation("forge.app-connect")`. No speed gain is claimed, so no measurement is owed.
- **Cadence:** 30 s for 15 minutes, then 5 minutes up to 24 hours: at most 315 checks per request.

**Each check** makes at most five GETs: `repos/<owner>/<name>/installation`; on 404 the account's
installation; on 404 up to three pages of `app/installation-requests` matching `account.id`. A network
error or 5xx leaves the state unchanged and is reported as `lastError`. «Не підключати» on the row's
round ends it as `cancelled`.

| Discovery option | Verdict |
|---|---|
| `GET /repos/{owner}/{repo}/installation` | **Chosen.** One request answers the question; strangers' installations never enter. |
| `GET /app/installations` | Pages grow once the App is public, and repositories need a second read. |
| Setup URL | An App setting; spoofable per GitHub's warning; proper verification needs a user token flow; gains seconds. |
| Webhook | The App was registered without one (setup record, 2026-10-03); `src/app/api` has no GitHub receiver. |

### 5.2 What counts as confirmed

`confirmed = a person chose «Підключити» on the row's round` **or** one of the two verified own-repository
transitions below occurred.

- The person's choice reuses `issueReportDecisionApproves` (`approvalForm.ts:70-76`) with its question
  id made a parameter: a recommendation sweep, «Інше», a note or an agent's decision does not count.
- Own means GitHub resolves the seat project's recorded remote (`src/lib/projects/aliases.ts:310`) and
  the requested repository to the same verified numeric repository id. A changed canonical name for
  that id preserves own-repository confirmation; a different id or an unavailable lookup does not.
  The operator's own session counts as own.
- A repository that was uncovered at request time becomes confirmed when coverage appears. A covered
  own repository requested for missing permissions becomes confirmed only when every requested key
  recorded in `missingPermissionsAtRequest` is now granted by that installation. This evidence is
  persisted with the request, so restart does not ask for a second answer. App-registration grants alone
  do not count; the installation must report the requested permissions too. Another project's install
  or permission transition still needs the person's explicit form choice.

A click is invisible to the API; Delegatus sees only that an installation appeared. For another
project's repository the form still goes out and the person's yes decides.

### 5.3 Storing and proving

One new helper entry: `bin/forge-app-token.mjs app-connect --repository <o/n> --from <declared,…>
[--store <installation-id>]`. It runs like `token` (`src/lib/forge/appWrite.ts:80-89`), prints JSON with
no secret, and reads only without `--store`. Once confirmed, in order:

1. **Source:** the first declared repository whose item parses and holds `id` and `pem` (`:172`).
2. **Verify:** `repos/<o/n>/installation` has the same id, this App, the account, no suspension and the
   permissions (the guard at `:203-207`).
3. **Store:** a copy of the source with only `installation_id` replaced, through `secret-tool store
   --label=… service delegatus-github-app repository <full_name>`, secret on stdin with no trailing
   newline. Its manual page: "If the attributes match an already existing item, it will be updated".
4. **Prove:** `mintInstallationToken`, then revoke: the agents' own path, including the check that the
   token reaches exactly this repository (`:217-220`).
5. **Declare:** new `declareForgeAppRepository`, under `withFileTransactionAsync`, case-insensitive,
   atomic; a corrupt file refuses as the reader does (`agentForgeCredentials.ts:40-45`). The transfer
   importer's write (`src/lib/transfer/sections.ts:275`) takes the same lock.
6. **Finish:** row `connected`, form closed, seat told.

A crash at any step is repaired by the next pass. An item without a declaration affects nobody, which
is why the declaration follows the proof. If step 4 refuses, the row reads `verification_failed` and
nothing is declared.

**Read path fix.** `readCredential` (`:657-663`) tries the exact spelling, then the origin's. A declared
`Owner/Repo` named `owner/repo` from a lower-case remote misses both. It gains the declared spelling
from `FORGE_REPOSITORIES_ENV` as a third lookup.

**Report.** One message per state change, keyed `forge-connect:<requestId>:<state>`, through the send
at `src/lib/prototypeReview/decision.ts:173-176`, to `currentSeat(project)` at send time
(`seatChannel.ts:25-28`), so a rotation does not lose it. With no seat, the state waits for the next
call.

**Later changes.** A reinstall or a rename makes the mint refuse (`:203`); a re-call repairs both by the
same path. A connected row re-checks read-only and writes nothing while the id matches.

### 5.4 A click that never comes

At `expiresAt` the row becomes `expired`, the form closes, nothing is stored or declared, and the seat
gets: "No installation of the App on `<owner>` covers `<owner/name>` after 24 hours; the operator's form
is closed. Call github_app_connect again to ask again." A re-call checks first: if the seat's own
repository is now covered, it connects with no second form, because the operator already saw that one.
Otherwise a new form opens.

## 6. What stays manual

- **One click on GitHub:** Install, or adding the repository under Repository access.
- **Permission grant:** On the calling project's own repository, the GitHub grant is the confirmation;
  the form and Telegram copy say Delegatus completes after verifying it. A different project's request
  still requires the person's explicit choice in the form.
- **Once ever, if the App is private and the account is not its owner:** Make public. This is the
  operator's setting and Delegatus never performs it. It is effectively one-way once another account
  has the App. Moving the App to the other account is not offered: a private App would then install
  only there, which puts this repository's own installation at risk.
- **If the clicker is not an owner of the account:** GitHub shows **Request**, and an owner approves
  there. Delegatus reports `awaiting_owner` and keeps watching.

**To expect after `connected`:**

- Running agents keep their launch environment; new launches and the engine's writes use the App.
- Run reruns stay outside the App rule (`bin/forge-app-token.mjs:239-247`, `CONTRIBUTING.md:102-107`),
  so the raising seat's reruns still go out as a person. Covering them is a separate decision about the
  App's permissions.
- The repository's pushes now go only through the App, so a push changing workflow files needs the
  installation's `workflows: write`.

## 7. Threat cases

| Threat | Held by |
|---|---|
| A stranger installs the now-public App | Discovery reads named repositories only; no item or declaration exists, so no token is minted. |
| A forged `installation_id` | Nothing reads one; the id comes from the JWT read. |
| An agent answers the form, or adds a link | `decidedBy` must be a person; the strict schema; hrefs are server-built and checked for `https://github.com/` at publish, an API `html_url` included. |
| A hostile `repository` | `parseRepository` plus the `.`/`..` refusal; `execFile` with no shell; forms print only the validated slug. |
| The private key leaks | It stays in the helper; stdout is allow-listed JSON; the store takes it on stdin; a test searches every answer, form, message and log for a sentinel. |
| A test seam leaks an App JWT | No environment override of the API base, since an agent could set it and capture a JWT. Tests inject ports. |

The helper runs under the agents' uid, as today. An item alone opens no new route, because only the
Viewer route writes the declaration and the form.

## 8. Test plan

Fake GitHub: one route table behind `ports.request` (`bin/forge-app-token.mjs:664-679`), bodies in the
REST `Installation` shape, the item in the manifest-conversion shape, and a test RSA key so JWTs are
really signed and checked. A fake `secret-tool` on `PATH` writes to a temp file (pattern at
`src/lib/forge/appWrite.test.ts:158`); the helper child runs under `bun --preload` with the fake `fetch`.
Isolation: `LLV_STATE_DIR`, private `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, `LLV_VIEWER_CONTROL_URL` on
port 1, spawn capability variable removed before bindings load, one file per call through
`scripts/gate-slot.sh`.

| # | Case | Must hold |
|---|---|---|
| 1 | **Second repository on a different installation** | Item holds the second id; the first item is byte-identical; the declaration holds both; both mint with their own ids. |
| 2 | **Private App** | Anonymous 404, account not owner: `app_private`, two links in order, nothing stored. Fake flips to public and installed: `connected`, no second form. |
| 3 | Private App on its owner account | One link, `prerequisite: none`. |
| 4 | **Installation does not cover the repository** | `missing_repository`; nothing stored or declared; one case B form; adding it connects. A token reaching more than this repository leaves it undeclared. |
| 5 | **A click that never comes** | Fake clock past 24 h: `expired`, at most 315 checks, form closed, one seat message, no item or declaration. Re-call after a late install connects with no second form; otherwise a new form. |
| 6 | Idempotence | Replay returns the first receipt; a new id while open gives the same round; form and Telegram post counts stay 1; a crash after each of steps 3, 4, 5 completes with one report. |
| 7 | Member without install rights | Pending `app/installation-requests` entry: `awaiting_owner`; nothing stored. |
| 8 | Cancel | `cancelled`; a later installation does not connect. |
| 9 | Another project's repository | An installation alone does not connect; a person's yes does; a recommendation sweep and an agent's decision do not. A stage caller is refused. |
| 10 | Link safety | Unreadable repository id gives the exact plain link, never `suggested_target_id` without `repository_ids`. `publish_prototype_review` with `links` is refused. Forms at 39/100-character names pass the schema. |
| 11 | Read path | A declared mixed-case repository named in lower case mints. |
| 12 | Refusals and secrets | Keyring locked, no source item, GitHub down: each named code; the key sentinel appears nowhere. |
| 13 | **End to end** | An SDK client over the real MCP server and tool service, into the exported route on a port-0 loopback server. |

Tests assert structure and state, never wording. Mutate production before review to show cases 1, 2, 4
and 5 go red.

**Rendered evidence:** a links case in the existing drivers,
`src/components/kanban/kanbanBoard.browser.test.tsx` (column, 1440 and 1000 px) and
`src/components/mobile/issue1671Evidence.browser.test.tsx` (phone sheet, 390 px), cases C and D, en and
uk, light and dark. The Telegram copy is tested at `renderPrototypeTelegram`; the fences keep a real
Telegram render out of the lane.

**Checks:** the pre-push hook and CI required checks.

## 9. Build order and overlaps

Helper and read path fix; form links; service, declaration writer and poller; route and MCP tool;
tests and evidence; then `CONTRIBUTING.md`'s declaration paragraph (`:93-100`). Open PRs #3552, #3485,
#3415 touch `server.ts` and `bindings.ts`; #3473 and #3263 touch `server.ts`. No open PR touches the
helper, the form or the credentials file. Merge `origin/main` before building.

## Addendum: permissions on an existing installation (2026-11-01)

The same `github_app_connect` request accepts `permissions`, a map of repository permission keys
to `read` or `write`. The proof includes `metadata: read`, matching the existing issue/write token
policies, so callers may name only the additional keys they need.
Omitting the map requests the existing forge-write set. Permission requests do not
expand the kinds of agent commands routed through the App.

Observed in current GitHub documentation:

- [Modifying a GitHub App registration, “Changing the permissions of a GitHub App”](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration#changing-the-permissions-of-a-github-app)
  requires changing **Permissions & events** and saving the registration. Additional repository
  permissions then require approval by each installed account. The documented registration update
  is a settings-page operation; the REST App API supplies reads, with no registration-permission
  update operation.
- [Approving updated permissions for a GitHub App](https://docs.github.com/en/apps/using-github-apps/approving-updated-permissions-for-a-github-app)
  says an installation retains its previous permissions until the additional permissions are
  accepted. A registration change alone therefore cannot prove the installation has them.

The helper compares the JWT `GET /app` permissions with the requested set, separately from the
repository installation's permissions. The same form contains only the remaining steps, in order:
the App settings link when its registration lacks keys, then the installation's verified `html_url`
to accept the update. Each link states which keys and levels to set or accept. No settings change,
installation action or permission update is performed through GitHub's API.

After confirmation (an explicit person-authored choice, or the eligible own-repository grant transition),
the existing bounded poll checks until all requested keys are granted, proves a token restricted to that
repository and permission set, and reports completion to the project's current seat. Expiration retains
and reports validated missing permission keys, including keys lost between discovery and credential
storage. `mintInstallationToken` separately refuses missing permission keys and an invalid installation;
GitHub's response message never becomes the refusal text.

The live App and signed-in settings pages were not inspected or changed in this lane. Verification
uses a fake GitHub with registration-only grants, installation approval, eventual grants and timeout.

## Deferred — not currently justified

- **Setup URL callback and `state` parameter:** an App setting change to save seconds; `state` is only
  useful with a setup URL.
- **Webhook receiver:** a new inbound route and an App setting.
- **A second private App per organization (manifest flow):** two clicks and a second App to look after.
  It stays open if the operator refuses Make public, because each item already holds its own App id.
- **Run reruns and other kinds as the App:** a decision about the App's permissions.
- **A disconnect tool, a Keys row:** the requirement asks for neither; a form carries the whole flow.
- **Editing the sent Telegram message on resolve:** the form closes and the link stays harmless.

## Validation against the requirement

| Requirement | Design |
|---|---|
| Agent sends the request | The seat makes one call (§3). |
| Operator confirms the request | One form; one click usually; two the very first time on a private App, because GitHub offers no combined action (§4, §6). |
| Target account and repository already selected | `suggested_target_id` and `repository_ids[]` as documented; verification holds if GitHub ignores them (§1, §5). |
| Delegatus proves the rest by itself | §5.3, with the agents' own mint path as the proof. |
| Reports done to the requesting seat | §5.3, rotation-safe. |
| Prerequisite stated, never performed | Case D (§4). |
| Refusal names the missing installation | `expired` and `missing_repository` (§3, §5.4). |
