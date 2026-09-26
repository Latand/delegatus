# 1. Positioning in one line

**EN:** A local orchestrator that turns a software request into agent work, review loops, and reports—with human decisions kept visible.

**UK:** Локальний оркестратор, який перетворює запит на роботу агентів, перевірки та звіти й показує, де потрібне твоє рішення.

| Hero copy | English | Українська |
|---|---|---|
| Headline | **Delegate everything.** | **Делегуй усе.** |
| Sub-line | Tell your orchestrator what to ship. It runs Claude Code and Codex through development and checks, then reports back. | Скажи оркестратору, що зробити. Він запускає Claude Code і Codex, організовує розробку та перевірки й звітує про результат. |
| Primary action | Install with your agent | Встановити через агента |
| Supporting line | Runs on your machine. Uses your agent accounts. | Працює на твоєму комп’ютері. Використовує твої облікові записи агентів. |

**The design decision:** lead with the handoff, not with a dashboard or a catalogue of integrations. The first image must contain the user's instruction and the orchestrator's reports. The board is the way to inspect the work, not the product's entire identity.

**Scope and evidence.** This is a specification for a separate static landing page, written against the supplied brief and the repository read on 26 September 2026. The inspected [`package.json`](https://github.com/Latand/delegatus/blob/main/package.json) reports `delegatus-cli` **1.5.0**, Bun **≥1.4.0**, Node.js **≥20.9.0**, and an MIT licence. The Node.js prerequisite is a repository-derived addition to the brief, not an assumed feature. The [README](https://github.com/Latand/delegatus#readme) and [launcher](https://github.com/Latand/delegatus/blob/main/bin/cli.mjs) support the installation and runtime decisions below.

Repository qualifications that must survive copy editing:

- **Autonomy is conditional, not a quality guarantee.** Automatic merging is off by default; when enabled, it requires passed reviews and green checks. Review budgets can be exhausted, and the README describes a final fix that may not be re-reviewed. Do not promise that every completed change has passed an independent review.
- **Engine support is not identical.** Claude Code and Codex run pipelines and the orchestrator. Copilot can run individual agents and appears in conversation/account views, but cannot run the orchestrator. Claude/Codex usage windows and Copilot's monthly allowance must not be presented as identical.
- **Local does not mean offline.** The UI and runtime are local; agent providers and optional connectors still communicate with their services. A git worktree is not a security sandbox. Telegram account reading and bot posting are separate permissions.

**Inspection limitation.** The supplied SVGs could not be rendered in this environment. Their subjects come from the brief and README; crop instructions below use named UI boundaries rather than invented source coordinates. Reference-site content and structure were inspected, not their live animation implementations. New screenshots are explicitly production requirements, not assets claimed to exist.

# 2. Section-by-section structure

Use **four sections**, in this order: the handoff; the review loop; inspection and access; installation. Navigation and footer sit outside them. No additional feature grid, FAQ section, testimonial band, or closing sales section.

## Shared layout and behaviour

At a 1440 px viewport, use a **1200 px content width**, centred, with a 24 px internal gutter. From 768–1279 px, use 32 px side margins; below 768 px, use 20 px. At **390 px**, the content width is **350 px**. Break multi-column compositions at 960 px. Section separation is 112 px on desktop and 64 px on phones; neither section height nor body-copy height is fixed.

All captions below are one sentence without editorial line breaks. They may wrap on a phone: “one line” must not become clipped text or a horizontal scroller. Allow Ukrainian labels to be longer; never shrink their font to match English.

Use `/en/` and `/uk/` static pages, `lang="en"` and `lang="uk"`, and language links that preserve the current section anchor. Show one language at a time. Preserve engine names, commands, and filenames literally. Use the supplied English screenshots in both versions, with translated descriptions and a single explicit disclosure in the hero. Do not paint Ukrainian words over English screenshots.

Gallery navigation belongs to the landing page and stays **outside** screenshot boundaries. App controls pictured inside screenshots are not clickable. The only click on an image opens its full-size source in an accessible image viewer. Do not pretend this static page is connected to a running Delegatus instance.

## Navigation

**Desktop:** a 72 px, opaque, sticky header. Existing outlined on-dark lockup at left, approximately 148 px wide; at right, README, GitHub, a language switch, and the install anchor. No product dropdown or hamburger menu.

**390 px:** a 64 px header with a 124 px-wide mark-and-wordmark lockup, one language-switch control, and a compact install anchor. Move README and GitHub links to the footer rather than adding a drawer. The install control reads “Install” / “Встановити”; reserve sufficient width for the Ukrainian label.

| Element | EN | UK |
|---|---|---|
| Skip link | Skip to content | Перейти до вмісту |
| Documentation link | README | README |
| Repository link | GitHub | GitHub |
| Desktop install link | Install | Встановити |
| Language choices | English · Українська | English · Українська |

**Motion:** none on arrival. Anchor activation scrolls to its section over at most 240 ms; reduced motion jumps immediately. Give anchored headings a scroll margin greater than the sticky-header height. The header neither shrinks nor hides while scrolling.

## Section A — The handoff

**Heading EN:** Delegate everything.  
**Heading UK:** Делегуй усе.

Use the hero sub-line, action, and supporting line from part 1. The action links to `#install`; it does not copy a prompt before the visitor has selected an engine.

**Desktop layout.** Use a two-column opening row: headline on the left, sub-line and action on the right, approximately 7:5. Place the supporting line beneath the action. Under this row, give the actual product image the full content width. The image is the dominant object, not a small decoration beside a large paragraph.

Default image: **`orchestrator.svg`**. Export a crop that retains the complete user instruction, the orchestrator's response, the Reports heading and visible entries, and enough of the board header to establish context. Cut navigation or empty board space before cutting conversation or report text. Do not assemble a report from one task beside a request from another.

A quiet two-choice gallery control above the image offers **Orchestrator / Board**. The second state uses **`board.svg`** and retains the project name, Inbox/Assigned/Blocked headings, one complete pipeline row, the stopped decision card, and **Needs you 1 · Next**. The missing Done column must not be invented. Show its full source in the image viewer.

**390 px layout.** Stack headline, sub-line, action, supporting line, gallery control, then media. For the default state, export two legible crops from `orchestrator.svg`: the request/answer region, then the Reports region. Stack them as two pictures in one figure, separated by 12 px. They are not a fabricated narrow-screen app. For the Board state, substitute **`phone-board.svg`**, cropped after the complete first decision card and its actions; the viewer contains the uncropped phone screen. Do not shrink the entire desktop dashboard into 350 px.

**Motion.** The first screen is present immediately. Manual gallery changes crossfade for 160 ms; no automatic switching, fake typing, changing task counts, or looping status dots. Reduced motion replaces the image immediately. The currently visible caption changes with the image.

| Copy | EN | UK |
|---|---|---|
| Gallery choices | Orchestrator · Board | Оркестратор · Дошка |
| Orchestrator caption | One request, with progress and questions reported beside it. | Один запит, а поруч — звіти про роботу й запитання. |
| Board caption | Tasks move through the board; decisions collect under Needs you. | Завдання рухаються дошкою; потрібні рішення зібрані в Needs you. |
| Demo disclosure | Demo project with synthetic data; screenshots are in English. | Демопроєкт із синтетичними даними; знімки екрана англійською. |
| Orchestrator image description | An orchestrator conversation beside timestamped reports, above the project's board. | Розмова з оркестратором поруч зі звітами з часовими позначками над дошкою проєкту. |
| Board image description | A task board with agent stages and a highlighted task awaiting a decision. | Дошка завдань з етапами роботи агентів і виділеним завданням, що очікує рішення. |

## Section B — The review loop

**Heading EN:** One agent builds. Another reviews.  
**Heading UK:** Один агент пише. Інший перевіряє.

**Desktop layout.** A left-aligned heading, followed by a full-width **`pipeline.svg`**. Retain the complete Build → Review → Verify graph, the dashed Review → Build return edge, and both conversation headings. Keep engine names visible. Crop empty lower conversation space, not the verdict or the fail edge.

Under the figure, place the caption and the merge qualification. Beside the caption, offer a text button **“See agents exchange a message”** / **“Як агенти обмінюються повідомленням”**. It switches the same media area to the new messaging capture described below; its return label is **“Back to the pipeline”** / **“Повернутися до етапів роботи”**. This demonstrates actual communication rather than implying that two engine logos constitute interoperability.

**390 px layout.** Stack three source crops from the same pipeline: the complete stage graph; the relevant builder message; the complete reviewer verdict. Fit the graph to 350 px, but keep the readable conversation crops at approximately native text scale. Preserve stage names and the return arrow even when model names require two lines. In the messaging state, stack sender then recipient; do not put two microscopic chats side by side.

**Motion.** On the first occasion the pipeline figure is at least 50% visible, highlight its existing fail edge once for 450 ms, then leave it in its normal state. The overlay must follow the actual edge and must not conceal it. It illustrates a route; it does not change verdicts or simulate execution. The messaging control crossfades for 140 ms. Reduced motion has a static visible edge and immediate image changes.

| Copy | EN | UK |
|---|---|---|
| Pipeline caption | Fresh, read-only reviewers check the diff; failed reviews return work within the round budget. | Нові агенти без права редагування перевіряють зміни; невдала перевірка повертає роботу в межах ліміту раундів. |
| Merge qualification | Auto-merge is optional: passed reviews and green CI required. Off by default. | Автозлиття необов’язкове: потрібні успішні перевірки й зелений CI. Типово вимкнене. |
| Messaging caption | Claude Code and Codex exchange messages through the bundled MCP server. | Claude Code і Codex обмінюються повідомленнями через вбудований MCP-сервер. |
| Pipeline image description | Build, Review and Verify stages, a return path to Build, and separate agent conversations. | Етапи Build, Review і Verify, повернення до Build та окремі розмови агентів. |
| Messaging image description | A message sent by a Claude Code agent and received by a Codex agent. | Повідомлення, яке агент Claude Code надіслав, а агент Codex отримав. |

**New capture required — `agent-message.svg`.** In the synthetic demo project, run one Claude Code agent and one Codex agent. Have the first send a benign message through the actual bundled MCP tool; capture its expanded successful tool call and the corresponding received message in the other conversation. Keep sender, recipient, engine identity, message text and success state visible. Use actual displayed tool names, not invented `send_message` labels. Do not imply that a read-only reviewer is editing files. Export separate sender/recipient crops for phones. Capture at a readable desktop scale of at least 1280 CSS px wide; export at 2× if raster output is required.

## Section C — Inspection and access

**Heading EN:** Open the work. Not just the result.  
**Heading UK:** Дивись на роботу, а не лише на результат.

**Desktop layout.** One editorial gallery, not four cards. A 260 px text rail on the left contains four feature choices with their short descriptions always visible. A 32 px gap separates it from the 908 px media area. Each choice has a text label and a 2 px selected marker; no feature icons, coloured card backgrounds, or decorative shadows. Default to **Conversations & search**. The rail exposes all four capabilities even before the visitor changes the image.

**390 px layout.** Render the same content as four native disclosure rows in document order. Each summary contains the label and description; open Conversations & search initially. Allow multiple rows to remain open so comparison does not depend on remembering hidden content. Keep labels at least 44 px high. Changing between desktop tabs and phone disclosures must preserve the last selected/open subject without losing keyboard focus.

| Feature choice | EN description | UK label and description |
|---|---|---|
| Conversations & search | Open any agent's conversation. Search across projects. | **Розмови й пошук.** Відкривай розмову будь-якого агента. Шукай у всіх проєктах. |
| Accounts | See limits. Choose the account an agent uses. | **Облікові записи.** Переглядай ліміти. Обирай обліковий запис для агента. |
| Telegram | Read permitted chats. Post through an allowlisted bot. | **Telegram.** Читай дозволені чати. Надсилай через бота лише в дозволені чати. |
| Phone | Answer decisions over your own Tailscale network. | **Телефон.** Відповідай на запитання через власну мережу Tailscale. |

**Conversations & search.** Use **`conversation.svg`** as the main image, cropped around the complete diff card, test command/output, and final answer. Show the new global-search capture as a second image below it, not pasted inside its chat. Search must visibly cross conversation/project boundaries. On a phone, stack one complete tool card and the search-results crop. The caption identifies support for sessions started outside Delegatus.

**Accounts.** Use **`accounts.svg`** at a size where account names, usage periods and reset times remain readable. Retain both accounts and the active-account indicator. Do not animate the limits dropping, invent automatic failover, or imply pooled subscriptions. On a phone, fit the full popover within 350 px and keep its natural aspect ratio.

**Telegram.** Use the new actual Telegram setup/connector captures described below. Present account reading first, then bot posting, with the permission captions adjacent to the respective images. They are two different channels, not a bidirectional capability automatically granted by scanning a QR code.

**Phone.** Desktop: show **`phone-board.svg`** and **`phone-conversation.svg`** side by side, each approximately 300 px wide, using only their own app boundaries. Keep the first decision card and the expanded test output visible. Phone: use an explicit **Board / Conversation** selector and display one crop at a time, preserving the complete relevant card. The caption states the Tailscale prerequisite and that the computer must remain running and reachable; do not imply a hosted mobile app.

**Motion.** Desktop selection changes the media with a 140 ms crossfade; account values, search results and Telegram statuses stay static. Phone disclosures expand without height animation to avoid moving the reading position. No timed carousel, drag-only controls, or autoplay videos. Reduced motion uses immediate replacement everywhere.

| Caption / description | EN | UK |
|---|---|---|
| Conversation caption | Claude Code, Codex and Copilot sessions—including those started outside Delegatus. | Сесії Claude Code, Codex і Copilot, зокрема запущені поза Delegatus. |
| Search caption | Press / in the app to search conversations across projects. | Натисни / у застосунку, щоб шукати в розмовах усіх проєктів. |
| Accounts caption | Separate logins, visible limits, and a choice of active account. | Окремі входи, видимі ліміти та вибір активного облікового запису. |
| Telegram account caption | QR sign-in gives agents read access only to the chats you permit. | Вхід за QR-кодом дає агентам доступ лише до читання дозволених тобою чатів. |
| Telegram bot caption | A separate bot token enables posting only to allowlisted chats. | Окремий токен бота дозволяє надсилати повідомлення лише в дозволені чати. |
| Phone caption | Through your Tailscale network, while your computer stays on and reachable. | Через твою мережу Tailscale, доки комп’ютер увімкнений і доступний. |
| Phone notification line | Turn on push notifications for agent questions. | Увімкни push-сповіщення про запитання агентів. |
| Phone image choices | Board · Conversation | Дошка · Розмова |
| Conversation image description | An agent conversation with a file diff and an expanded test command and output. | Розмова з агентом зі змінами у файлі та розгорнутою командою тестування з результатом. |
| Search image description | Global search results from different conversations and projects. | Результати глобального пошуку з різних розмов і проєктів. |
| Accounts image description | Two Claude accounts with usage windows, remaining allowance and reset times. | Два облікові записи Claude з періодами лімітів, залишком і часом скидання. |
| Telegram image description | Separate controls for permitted account reading and allowlisted bot posting. | Окремі налаштування читання дозволених чатів і надсилання ботом у дозволені чати. |
| Phone image description | The phone board's decision card and a phone conversation with expanded test output. | Картка з потрібним рішенням на телефоні та розмова з розгорнутим результатом тестування. |

**New capture required — `search.svg`.** Seed the same harmless phrase into a user message in `harbor-api` and another synthetic project, `harbor-web`; the second project is proposed demo fixture data, not a claim about an existing screenshot. Open the actual global search with `/`, enter that phrase, and capture the query, current search scope, and at least one genuine result from each project. Preserve project/conversation identifiers and the real result count. Do not invent filters or claim that message search is source-code search. Capture the actual control for including agent-written messages only if it is visible in the current UI. Nothing on the landing page intercepts `/`.

**New captures required — `telegram-read.svg` and `telegram-post.svg`.** Use isolated demo Telegram identities and a private test group. For reading, capture the actual connected account and permitted-chat controls after QR sign-in; use a separate signed-out capture only if showing the QR step is necessary. For posting, capture the separate bot configuration, allowlisted destination, and a real synthetic report delivered to that destination. Keep tokens masked; never export a usable login QR, personal account number, private chat content, or an access key. Use the same demonstrated report on both sides. Do not invent a Telegram panel layout before capture. This gallery is a **launch dependency**, not permission to substitute a fabricated dashboard.

The Activity page and voice configuration do not receive landing-page space. They remain in the README. This is an editorial omission, not a statement that the features are unavailable.

## Section D — Installation

**Heading EN:** Let your agent install it.  
**Heading UK:** Доручи агенту й встановлення.

**Desktop layout.** A 760 px install box aligned with the main text edge; a quiet 160 px mascot area sits to its right. The remainder is whitespace, not another benefit panel. Inside: Claude Code/Codex tabs, a readable action summary, prompt disclosure, and one copy button. Keep the separate Bun disclosure below the box, divided by a 1 px rule. Parts 3 and 4 define both precisely.

**390 px layout.** One 350 px-wide column. Tabs share the width. The copy button is full width, 48 px high. Place the mascot beside the section heading at 64 px, never over the button or prompt. The Bun disclosure follows with a 24 px gap. Expanded prompts wrap; no nested horizontal scrolling.

**Screens:** none. This section demonstrates an actual action the visitor can take, not a screenshot of a terminal.

**Motion:** the copy label changes only after successful clipboard writing; the status remains for 2.5 seconds. No confetti, progress bar, or “installing” state: the landing page has copied text, not installed software. Reduced motion uses the same text feedback without transitions.

**Caption EN:** Paste this into a local agent on the computer that will run Delegatus.  
**Caption UK:** Встав цей запит у локального агента на комп’ютері, де працюватиме Delegatus.

## Footer

A 1 px rule, a text-only Delegatus wordmark, and README / GitHub / Licence links. Link Licence directly to the inspected [repository LICENSE file](https://github.com/Latand/delegatus/blob/main/LICENSE); do not create a new licence page. At 390 px, wrap into two rows with 44 px link targets.

**EN:** Open source. Formerly Agent Log Viewer.  
**UK:** Відкритий код. Раніше — Agent Log Viewer.

**Licence label:** Licence / Ліцензія. No counters, follower badges, newsletter form, or enormous sitemap. No footer animation.

# 3. The install box

## Visible content and interaction

Use a genuine two-tab component, initially **Claude Code**. A manual switch changes the displayed prompt and the copy label together. The visitor's selected page language chooses the matching prompt; copying never silently returns English from the Ukrainian page. Do not infer the agent from the browser or read local configuration from the site.

| Element | EN | UK |
|---|---|---|
| Action summary | Installs Delegatus 1.5.0, connects its MCP server, and starts it locally. | Встановить Delegatus 1.5.0, під’єднає його MCP-сервер і запустить локально. |
| Permission note | Reads local agent transcripts. Leaves project selection and sign-in to you. | Читає локальні записи розмов агентів. Проєкт і вхід в облікові записи обираєш ти. |
| Prompt disclosure, closed | Read the full prompt | Прочитати весь запит |
| Prompt disclosure, open | Hide the prompt | Згорнути запит |
| Claude copy action | Copy for Claude Code | Копіювати для Claude Code |
| Codex copy action | Copy for Codex | Копіювати для Codex |
| Claude success | Copied for Claude Code | Скопійовано для Claude Code |
| Codex success | Copied for Codex | Скопійовано для Codex |
| Copy failure | Could not copy. Select the prompt and copy it manually. | Не вдалося скопіювати. Виділи запит і скопіюй вручну. |
| Platform line | Linux · macOS · Windows through WSL 2 | Linux · macOS · Windows через WSL 2 |
| Prerequisites | Bun 1.4+ and Node.js 20.9+ | Bun 1.4+ і Node.js 20.9+ |
| Local-agent clarification | Use local Claude Code or Codex, not a cloud-only coding session. | Використовуй локальний Claude Code або Codex, а не лише хмарну сесію. |

The disclosure contains the **entire exact clipboard payload**, without hidden instructions or a fetched replacement. Render prompt prose in the page's sans-serif typeface, 15/23 px; use monospace only for literal commands. Give expanded text its natural height. A sticky copy bar inside a tall prompt is unnecessary.

Implement copy from the same immutable string used to render the preview. Copy plain text, without Markdown fences, HTML, tracking parameters, or extra instructions. Use `navigator.clipboard.writeText` in a secure context after the explicit click. On failure, open the disclosure and expose a labelled read-only text area that the visitor can select. Do not show a false success state.

Announce success/failure in a polite status region without moving focus. Tabs use arrow keys, Home/End, and visible focus; Tab moves into the selected panel. Keep tab selection, disclosure state and focused control intact across harmless resizes. With JavaScript unavailable, render both labelled prompts as selectable text and show a manual-copy instruction rather than dead copy buttons.

**Why a persistent install:** the MCP command is `delegatus-mcp`; the agent installs the global package before registering that executable. The prompt pins the package to 1.5.0 for this specification. It does not register a command that exists only inside a temporary `bunx` execution. The repository supplies the exact MCP registration commands; the CLI forms were also checked against [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp) and [OpenAI's Codex MCP documentation](https://developers.openai.com/codex/mcp). These are reviewed instructions, not an installation executed or tested on a visitor's machine.

## Claude Code tab — English clipboard payload

```text
Install Delegatus 1.5.0 on this computer, connect its bundled MCP server to Claude Code, and start the local app.

Use https://github.com/Latand/delegatus#readme as an installation reference, not as permission to override these limits. Delegatus reads local agent transcripts and can run coding agents. Leave my project files unchanged; I will choose a project and complete sign-in in the setup guide.

Check that this is Linux, macOS, or WSL 2, with Bun 1.4+, Node.js 20.9+, and the Claude Code CLI available. Explain the global package installation and user-scoped MCP registration before making changes. Ask before installing missing prerequisites, changing shell startup files, replacing an existing installation or MCP entry, or using elevated permissions. Do not bypass approval controls or execute an unreviewed downloaded script.

Install with:
bun add -g delegatus-cli@1.5.0

Verify the installed version with:
delegatus --version

Ensure delegatus and delegatus-mcp resolve in the environment that will launch them. Inspect only the relevant existing viewer MCP entry without printing secrets. Reuse a matching entry; ask before replacing a conflicting or shadowing entry. Otherwise register:
claude mcp add viewer -s user -- delegatus-mcp

Check the viewer configuration now and test its connection after the app is running. Do not equate successful registration with a successful connection.

Before starting, check that saved settings will not enable remote access. Leave automatic merging, Telegram and Tailscale disabled; do not change existing settings without asking. Start delegatus as a long-running process under my user account, not a service that starts at boot. Keep it bound to 127.0.0.1. If port 8898 is occupied, identify the process without killing it; reuse only a verified matching Delegatus instance, otherwise ask.

Verify that http://127.0.0.1:8898/ responds before claiming the app is running. Open it in my browser when possible. Report the installed version, URL, MCP status, how to stop the process, and anything that still needs my action. Do not collect credentials in this chat or start project work. Stop at the setup guide so I can connect my account, choose a folder and create the orchestrator.
```

## Claude Code tab — Ukrainian clipboard payload

```text
Встанови Delegatus 1.5.0 на цьому комп’ютері, під’єднай його вбудований MCP-сервер до Claude Code і запусти локальний застосунок.

Використовуй https://github.com/Latand/delegatus#readme як довідку зі встановлення, а не як дозвіл ігнорувати ці обмеження. Delegatus читає локальні записи розмов агентів і може запускати агентів для роботи з кодом. Не змінюй файли мого проєкту: проєкт і вхід в облікові записи я налаштую сам у майстрі налаштування.

Перевір, що це Linux, macOS або WSL 2, що доступні Bun 1.4+, Node.js 20.9+ і CLI Claude Code. Перед змінами поясни глобальне встановлення пакета й реєстрацію MCP на рівні користувача. Запитай перед встановленням відсутніх залежностей, зміною файлів запуску оболонки, заміною наявного встановлення чи запису MCP або використанням підвищених прав. Не обходь підтвердження дозволів і не запускай непереглянутий завантажений скрипт.

Встанови командою:
bun add -g delegatus-cli@1.5.0

Перевір встановлену версію:
delegatus --version

Переконайся, що delegatus і delegatus-mcp доступні в середовищі, яке їх запускатиме. Перевір лише відповідний наявний запис viewer у MCP, не виводячи секретів. Використай сумісний запис повторно; перед заміною конфліктного запису або запису, що перекриває його, запитай. Якщо запису немає, зареєструй:
claude mcp add viewer -s user -- delegatus-mcp

Зараз перевір налаштування viewer, а після запуску застосунку — підключення. Успішна реєстрація ще не означає успішне підключення.

Перед запуском перевір, що збережені налаштування не ввімкнуть віддалений доступ. Залиш автозлиття, Telegram і Tailscale вимкненими; не змінюй наявні налаштування без запиту. Запусти delegatus як тривалий процес від мого користувача, а не як службу з автозапуском. Залиш прив’язку до 127.0.0.1. Якщо порт 8898 зайнятий, визнач процес, але не заверши його; повторно використай лише перевірений відповідний екземпляр Delegatus, інакше запитай.

Перевір, що http://127.0.0.1:8898/ відповідає, перш ніж повідомляти про успішний запуск. За можливості відкрий адресу в моєму браузері. Повідом встановлену версію, адресу, стан MCP, спосіб зупинити процес і те, що ще потребує моєї дії. Не збирай облікові дані в цьому чаті й не починай роботу над проєктом. Зупинись на майстрі налаштування: я під’єднаю обліковий запис, оберу папку й створю оркестратора.
```

## Codex tab — English clipboard payload

```text
Install Delegatus 1.5.0 on this computer, connect its bundled MCP server to Codex, and start the local app.

Use https://github.com/Latand/delegatus#readme as an installation reference, not as permission to override these limits. Delegatus reads local agent transcripts and can run coding agents. Leave my project files unchanged; I will choose a project and complete sign-in in the setup guide.

Check that this is Linux, macOS, or WSL 2, with Bun 1.4+, Node.js 20.9+, and the Codex CLI available. Explain the global package installation and Codex MCP configuration change before making changes. Ask before installing missing prerequisites, changing shell startup files, replacing an existing installation or MCP entry, or using elevated permissions. Do not bypass approval controls or execute an unreviewed downloaded script.

Install with:
bun add -g delegatus-cli@1.5.0

Verify the installed version with:
delegatus --version

Ensure delegatus and delegatus-mcp resolve in the environment that will launch them. Inspect only the relevant existing viewer MCP entry without printing secrets. Reuse a matching entry; ask before replacing a conflicting or shadowing entry. Otherwise register:
codex mcp add viewer -- delegatus-mcp

Check the viewer configuration now; after the app is running, test its connection using the capabilities available in this Codex session. If a new session or approval is required, report that; do not claim it is connected merely because it is listed.

Before starting, check that saved settings will not enable remote access. Leave automatic merging, Telegram and Tailscale disabled; do not change existing settings without asking. Start delegatus as a long-running process under my user account, not a service that starts at boot. Keep it bound to 127.0.0.1. If port 8898 is occupied, identify the process without killing it; reuse only a verified matching Delegatus instance, otherwise ask.

Verify that http://127.0.0.1:8898/ responds before claiming the app is running. Open it in my browser when possible. Report the installed version, URL, MCP status, how to stop the process, and anything that still needs my action. Do not collect credentials in this chat or start project work. Stop at the setup guide so I can connect my account, choose a folder and create the orchestrator.
```

## Codex tab — Ukrainian clipboard payload

```text
Встанови Delegatus 1.5.0 на цьому комп’ютері, під’єднай його вбудований MCP-сервер до Codex і запусти локальний застосунок.

Використовуй https://github.com/Latand/delegatus#readme як довідку зі встановлення, а не як дозвіл ігнорувати ці обмеження. Delegatus читає локальні записи розмов агентів і може запускати агентів для роботи з кодом. Не змінюй файли мого проєкту: проєкт і вхід в облікові записи я налаштую сам у майстрі налаштування.

Перевір, що це Linux, macOS або WSL 2, що доступні Bun 1.4+, Node.js 20.9+ і CLI Codex. Перед змінами поясни глобальне встановлення пакета й зміну налаштувань MCP у Codex. Запитай перед встановленням відсутніх залежностей, зміною файлів запуску оболонки, заміною наявного встановлення чи запису MCP або використанням підвищених прав. Не обходь підтвердження дозволів і не запускай непереглянутий завантажений скрипт.

Встанови командою:
bun add -g delegatus-cli@1.5.0

Перевір встановлену версію:
delegatus --version

Переконайся, що delegatus і delegatus-mcp доступні в середовищі, яке їх запускатиме. Перевір лише відповідний наявний запис viewer у MCP, не виводячи секретів. Використай сумісний запис повторно; перед заміною конфліктного запису або запису, що перекриває його, запитай. Якщо запису немає, зареєструй:
codex mcp add viewer -- delegatus-mcp

Зараз перевір налаштування viewer; після запуску застосунку перевір підключення засобами, доступними в цій сесії Codex. Якщо потрібна нова сесія або підтвердження, повідом про це; наявність сервера в списку ще не означає, що він підключений.

Перед запуском перевір, що збережені налаштування не ввімкнуть віддалений доступ. Залиш автозлиття, Telegram і Tailscale вимкненими; не змінюй наявні налаштування без запиту. Запусти delegatus як тривалий процес від мого користувача, а не як службу з автозапуском. Залиш прив’язку до 127.0.0.1. Якщо порт 8898 зайнятий, визнач процес, але не заверши його; повторно використай лише перевірений відповідний екземпляр Delegatus, інакше запитай.

Перевір, що http://127.0.0.1:8898/ відповідає, перш ніж повідомляти про успішний запуск. За можливості відкрий адресу в моєму браузері. Повідом встановлену версію, адресу, стан MCP, спосіб зупинити процес і те, що ще потребує моєї дії. Не збирай облікові дані в цьому чаті й не починай роботу над проєктом. Зупинись на майстрі налаштування: я під’єднаю обліковий запис, оберу папку й створю оркестратора.
```

**Acceptance conditions.** Copying is the page's only installation action. A clean Linux/macOS/WSL test must establish that the pinned package is available, both executables resolve after installation, the registered MCP command connects, the app responds on loopback, and the process survives the installing agent's turn. Test an occupied port, an existing `viewer` entry, missing prerequisites, denied clipboard permission, and an unavailable package version. On any failure, report the blocker rather than silently changing version, killing a process or enabling broader permissions.

# 4. The legacy Bun install and the joke

The alternative is physically separate from the agent install box but remains inside Section D. Use a native disclosure with the summary **“The old-fashioned way: Bun”** / **“По-старому: через Bun”**. It is closed initially. This is a supported alternative, not a disabled or deprecated method; “legacy” is the joke, not a compatibility claim.

On opening, reveal a plain command strip with a 1 px border, 16 px padding and a 44 px copy control. No `$` prefix, fake prompt cursor or invented terminal output:

```sh
bunx delegatus-cli
```

**Instruction EN:** Run in a terminal, then open `http://127.0.0.1:8898/`.  
**Instruction UK:** Запусти в терміналі, потім відкрий `http://127.0.0.1:8898/`.

**Prerequisite line EN:** Requires Bun 1.4+ and Node.js 20.9+; on Windows, run inside WSL 2.  
**Prerequisite line UK:** Потрібні Bun 1.4+ і Node.js 20.9+; у Windows запускай у WSL 2.

Below it, a smaller disclosure **“Keep the command installed”** / **“Залишити команду встановленою”** contains:

```sh
bun add -g delegatus-cli
delegatus
```

Copy labels: **“Copy command” / “Копіювати команду”** for the first strip, **“Copy commands” / “Копіювати команди”** for the two-line alternative. Success: **“Copied” / “Скопійовано”**. Failure: **“Could not copy. Select the command and copy it manually.” / “Не вдалося скопіювати. Виділи команду й скопіюй вручну.”** The command remains selectable at all times.

**Mascot action.** On the visitor's first explicit opening of this disclosure, the bird turns toward the command, squints behind its glasses and performs two tiny chest bobs, as though stifling a laugh. Total duration **600 ms**, maximum translation **2 px**, maximum rotation **3°**. Its wing stays within its own illustration bounds. No sound or repeated loop. The joke is readable immediately; the command and copy button are never delayed.

**Joke EN:** Heh. Delegated the coding, kept the typing?  
**Joke UK:** Хе. Код делегував, а команди вводиш сам?

After a successful command copy, the optional illustration caption changes to **“Fine. That works too.” / “Гаразд. Так теж працює.”** It is not a second live announcement; the copy status is sufficient for assistive technology.

**Reduced motion:** show the static squinting pose and the same joke. No movement. At 390 px, keep the bird at 64 px above the joke; put the command beneath it at full width. The disclosure remains equally discoverable and accessible without the character.

The unpinned Bun commands are preserved exactly as requested and follow the registry's default version. The agent prompts are deliberately pinned to 1.5.0. Revalidate both paths when publishing a new release; do not describe the unpinned command as permanently installing 1.5.0.

# 5. The mascot

Use the shipped mark and outlined lockup, not a new interpretation of the character. Its identity is the round red body, cream belly, swept grey hair, bold dark-framed glasses and **no beak**. Keep the flat SVG construction and 64-unit base grid described in the brief.

**Placement rules.** The navigation uses the existing mark/lockup without animation. The install area gets one character instance, changing pose in response to the visitor's action. The footer is text-only. Do not place a bird on every section, a floating mascot over the viewport, or a character inside the app screenshots. At most two bird instances can be visible: navigation and installation.

**New pose 1 — handoff.** Same silhouette and face; one wing points gently toward the agent copy button. Use a static pose, not a recurring attention-grabbing gesture. Desktop size 112 px; phone size 64 px. The illustration cannot cross the interactive target or create a speech bubble covering text.

**New pose 2 — stifled laugh.** Eyes slightly narrowed behind unchanged glasses; one wing near the chest. Build the short legacy animation from separate torso/wing groups in this SVG. Do not add a beak, a new mouth shape that changes the face, a costume, a headset, a 3D surface or drop-shadow lighting.

The base pose returns when the Bun disclosure closes. Reopening does not replay the laugh during the same page visit. No mascot motion on scroll, hover, clipboard failure or installation error. Tease the decision to type commands, not the visitor's intelligence, age or ability.

Treat the animated character as decorative (`aria-hidden`); the joke remains ordinary selectable text. No speech bubble is required. The Latin etymology stays out of the landing-page copy: it is not needed to understand the product.

# 6. Visual direction

## Type

**Inter** for headings, body, navigation, tabs and prompt prose. Use weights 400, 500 and 600. Its [official specimen](https://rsms.me/inter/) explicitly lists Ukrainian under Cyrillic support; its [project licence](https://github.com/rsms/inter/blob/master/LICENSE.txt) is **SIL Open Font License 1.1**. This selection follows the coverage check, not an assumption based on the Latin specimen.

**JetBrains Mono** only for shell commands, URLs inside command instructions, and literal technical tokens. Use regular weight with ligatures disabled in copyable commands. The [official specimen and licence page](https://www.jetbrains.com/lp/mono/) lists Ukrainian, displays `Ґ Є І Ї ґ є і ї`, and specifies **SIL Open Font License 1.1**. Do not use monospace for decorative labels or feature descriptions.

Use the existing outlined wordmark as an SVG; it does not require loading Adwaita Sans. Retain font-licence notices with the site's self-hosted webfont assets. Use `font-display: swap`; do not make a third-party font request. Verify the deployed webfont subsets with **“Ґанок, Європа, Інструмент, Їжак — ґ є і ї”** in both regular and semibold. Family-level Cyrillic support is not proof that a Latin-only subset contains these glyphs.

| Role | Desktop | 390 px |
|---|---|---|
| Hero heading | 76/80 px, 600, −0.035 em | 44/47 px, 600, −0.025 em |
| Section heading | 42/48 px, 600, −0.025 em | 30/36 px, 600, −0.015 em |
| Hero sub-line | 20/30 px, 400 | 18/27 px, 400 |
| Body / descriptions | 16/25 px, 400 | 16/25 px, 400 |
| Captions / supporting notes | 14/21 px, 400 | 14/21 px, 400 |
| Controls | 15/20 px, 500 | 15/20 px, 500 |
| Literal commands | 14/22 px, 400 | 14/22 px, 400 |

No justified paragraphs, all-caps feature labels or manual line breaks in body copy. Use separate language-specific headline wrapping; do not force Ukrainian into English line lengths.

## Colour roles

Use a neutral dark page that belongs to the product, not a cream editorial page with a terracotta accent. The red bird supplies enough warmth; violet identifies interaction.

| Role | Hex | Use |
|---|---|---|
| Canvas | `#111218` | Entire page background |
| Surface | `#191B23` | Install box and restrained image backing |
| Decorative divider | `#292C36` | Non-interactive rules and screenshot keylines |
| Primary text | `#F4F1EC` | Headings and body |
| Secondary text | `#B8BBC8` | Captions, descriptions and prerequisites |
| Action / focus | `#B5A0FF` | Links, selected markers, focus rings and main button fill |
| Main-button text | `#111218` | On the violet fill |
| Interactive boundary | `#666B7C` | Boundaries needed to identify unfilled controls |
| Working | `#76D69A` | Only meaningful work status, paired with text |
| Needs attention | `#F0C674` | Only actual decision/attention references, paired with text |
| Mascot body | `#E0392B` | Illustration only; not small red text |
| Mascot belly | `#F7DCC6` | Illustration only |
| Mascot hair | `#7B6D68` | Illustration only |
| Brand slate / cream | `#262A36` / `#FBEBDD` | Existing brand assets, not a new page background pair |

Calculated against `#191B23`, primary text is approximately **15.25:1**, secondary text **8.98:1**, and action violet **7.72:1**. Dark text on the violet button is **8.40:1**. Interactive boundaries are approximately **3.24:1** against that surface. These are calculated palette contrasts, not a completed accessibility audit. The brand red reaches only about **3.92:1** against the surface, so it must not carry body text. The decorative divider is not a substitute for a visible input or focus boundary.

## Screenshot framing and assets

Use the supplied SVGs from `docs/media/readme/` as sources. The exact source URL pattern is:

```text
https://raw.githubusercontent.com/Latand/delegatus/main/docs/media/readme/<name>.svg
```

Here `<name>` is exactly `board`, `orchestrator`, `pipeline`, `conversation`, `accounts`, `phone-board`, or `phone-conversation`. The shipped brand files are [mark](https://raw.githubusercontent.com/Latand/delegatus/main/public/brand/delegatus-mark.svg), [badge](https://raw.githubusercontent.com/Latand/delegatus/main/public/brand/delegatus-badge.svg), and [lockup](https://raw.githubusercontent.com/Latand/delegatus/main/public/brand/delegatus-lockup.svg). For this dark page, use the [on-dark lockup referenced by the README](https://raw.githubusercontent.com/Latand/delegatus/main/public/brand/delegatus-lockup-on-dark.svg), rather than applying an invert filter.

Vendor the originals and approved derivatives into the static site's assets at build time; do not hotlink mutable `main` files in production. Record the repository commit used during implementation. Preserve every original as the full-size viewer source.

Use a 1 px keyline and 10 px corner radius around a full app boundary. Tight detail crops get a 6 px radius or remain square when placed together. Never add browser traffic lights, a URL bar, a MacBook shell, a phone notch, tilted perspective, bloom, texture or a blurry gradient mask. Preserve real window chrome only when it is already in the screenshot. Do not recolour screenshot UI to match the landing-page palette.

Crop by complete UI elements. Keep a minimum 12 px breathing margin around the content a crop is meant to prove. A crop is unacceptable if it cuts a verdict, hides the recipient of a message, removes an account's usage period, or hides the permissions that qualify Telegram access. Use explicit intrinsic dimensions to prevent layout shifts. Load the initial hero image eagerly and below-fold assets lazily. SVGs must be sanitized and referenced as images, not inserted as executable, untrusted markup.

The full-image viewer uses a labelled dialog, a clearly reachable close control, Escape to close, focus containment and focus return to the opener. Provide a normal source-image link as its non-JavaScript fallback. At high zoom, let the image scroll inside the viewer without forcing the page itself sideways.

| Shared viewer text | EN | UK |
|---|---|---|
| Open image action | Open full image | Відкрити повне зображення |
| Viewer title | Product screenshot | Знімок екрана застосунку |
| Close action | Close image | Закрити зображення |
| Source fallback | Open source image | Відкрити оригінал зображення |
| No-JavaScript instruction | Select and copy the prompt manually. | Виділи й скопіюй запит вручну. |

## Motion and accessibility acceptance

Animation explains a changed selection, the existing review return path, or the explicit Bun joke. It does not decorate every section. No scroll pinning, parallax, spring overshoot, perpetual typing or repeated entrance fades. Content remains fully available without animation. Apply reduced-motion handling to anchor scrolling, image crossfades, the review highlight and the mascot—not only one global transition rule.

Use one `h1`, followed by the three remaining page-section `h2`s. Provide an obvious 2 px focus ring with a 3 px offset, 44 px minimum interactive targets, and visible text labels for all controls. Status colours must have a textual equivalent. Demo pictures need the localized descriptions specified above; text necessary to understand a feature must also exist outside the image.

Before release, test keyboard-only navigation, a screen reader, reduced motion, clipboard denial, JavaScript disabled, 200% zoom, and 320/390/768/1440 px layouts in both languages. Read Ukrainian labels at their real length. Confirm no public page request reaches loopback, no third-party analytics receives prompt content, no login token appears in an asset, and no screenshot is mistaken for an interactive live application. Accessibility requirements originate in the brief; these implementation checks are proposed acceptance criteria.

# 7. References

The following sites were opened on **26 September 2026**. Notes refer to the returned live page content and hierarchy, not unobserved motion or a claimed pixel-level visual audit. They are selective references: do not combine their entire design systems.

| Site and URL | What to take | What to leave | Inspection status |
|---|---|---|---|
| **Linear — https://linear.app/** | Use recognizable work objects—issues, reviews, diffs and activity—as the evidence. Its concrete request-to-work examples are more useful here than abstract AI illustrations. | Its company proof, metrics, long multi-section sales structure, numbered figure labels and enterprise framing. | Homepage content inspected. |
| **Zed — https://zed.dev/** | Put an actual editor/agent workflow close to the product claim; make source and installation easy to reach. Borrow the confidence of specific examples. | Collaboration/team promises, unrelated performance assertions and an exhaustive editor feature tour. | Homepage content inspected. |
| **Raycast — https://www.raycast.com/** | Ground automation in a readable request, actual tool activity and an outcome. Keep action affordances recognizable rather than decorating them. | The extension catalogue, testimonial collection, keyboard showcase and broad “everything” platform story. | Homepage content inspected. |
| **Bun — https://bun.com/** | Keep installation explicit and inspectable; preserve access to what an install action will execute. A character-led developer brand need not turn every element into a joke. | Benchmark charts, comparative speed numbers, a command-first hero, and copying its mascot or typography. Here the terminal path is secondary. | Homepage content inspected; its current install block exposes the command and an install-script link. |
| **PocketBase — https://pocketbase.io/** | State what the tool is in ordinary language and bring the real interface/documentation close to that definition. Maintain a short route from understanding to trying. | Its four-feature taxonomy, SDK examples as hero content, and database-specific claims. | Homepage content inspected. |
| **Tailscale — https://tailscale.com/** | Explain remote access in terms of the user's devices and access boundaries. This is especially relevant to Delegatus's phone prerequisite. | Enterprise navigation, customer statistics, case studies and any implication that Delegatus itself supplies a hosted network service. | Homepage content inspected. |
| **Obsidian — https://obsidian.md/** | Make local ownership understandable without beginning with deployment terminology. Keep the product's real working environment central. | Knowledge-graph metaphors, plugin breadth, sync/publish products and claims that would turn “local” into “offline.” | Homepage content inspected. |
| **Ghostty — https://ghostty.org/ ; docs: https://ghostty.org/docs** | From the accessible documentation, take the direct paths to Download, Docs and source. Nothing more is needed for this footer. | Do not infer the current homepage composition, character treatment or animation from memory. | **Homepage opened but returned no inspectable content; not used as visual evidence. Documentation opened successfully.** |

Use **Linear and Zed for product evidence**, **Bun for install inspectability**, and **PocketBase for brevity**. The others are narrow references, not additional styles to combine.

# 8. What to avoid on this page

**A different product story.** Do not lead with “all your AI tools in one place,” a generic multi-agent dashboard, or the former log-viewer identity. Do not equate a kanban board with orchestration. Start with an instruction and show what happened to it.

**Unsupported promises.** No guaranteed correctness, quantified efficiency, instant results, automatic account rotation, pooled quotas, unrestricted Telegram access, native Windows without WSL 2, Copilot orchestration, offline operation, public hosting, team collaboration, autonomous deployments, or always-approved merges. Do not call a worktree a sandbox or call read-only Telegram access a property of the entire application.

**Generated-landing-page conventions.** No eyebrow labels above headings, visible section numbers, gradient text, uniform icon-card rows, hero statistics, glowing orbs, sparkles, decorative monospace, logo wall, fake window chrome, cream paper with terracotta decoration, or identical fade-ins on every block. The numbered parts in this specification are document organization, not website UI. There is no reason to make an exception to these prohibitions.

**Counterfeit evidence.** No hand-drawn “screenshot” of an unrecorded feature, invented search results, painted-over model names, fake GitHub stars, fake customer quotes or animated progress presented as live. The screenshot's seeded model labels are demo content, not a promise of current model availability. Missing captures are production tasks, not a reason to hallucinate UI.

**Installation theatre.** No “Installing…” after copy, auto-running code from the browser, clipboard writes on load, hidden prompt instructions, opaque installation shortlinks, credential requests, blind replacement of MCP configuration, or permission-bypass flags. Do not replace the user’s deliberate choice of agent with detection guesses.

**Small-screen punishment.** No 1280 px dashboard scaled into unreadable text, essential hover states, drag-only galleries, nested horizontal page scroll, or a joke that makes the supported terminal path hard to reach. Never reduce Ukrainian text size to make the English layout fit.

**Unnecessary breadth.** No pricing section, testimonials, fabricated usage figures, Activity screenshot placeholder, voice feature card, newsletter, roadmap promises or Latin-name essay. Let the README carry secondary detail.

# 9. Owner requirements mapped to the page

| Owner requirement | Where it is met | Concrete implementation / completion condition |
|---|---|---|
| **1. Introduce an orchestrator that receives work, handles it autonomously with checks, and reports.** | Section A; Section B; part 1 qualifications. | First image shows instruction beside Reports. The next shows the actual review loop. Needs you remains visible, and auto-merge is explicitly optional. No invented efficiency or quality guarantees. |
| **2. Show traceability, multiple accounts, cross-engine communication and native Telegram MCP.** | Section B messaging view; Section C's four visible feature choices. | Conversations plus a real cross-project search; both accounts in the actual popover; a recorded Claude Code → Codex message; separate Telegram read/post permission captures. Missing captures are specified and are launch dependencies. |
| **3. Minimum text, maximum pictures; three or four sections at most.** | The four-section architecture in part 2. | One concise introduction, screenshot captions instead of feature essays, and one gallery that exposes its topics without a card grid. Full prompts, safety detail and terminal alternatives are behind deliberate disclosures. No fifth section. |
| **4. Install through the visitor's own coding agent, with Claude Code and Codex tabs.** | Section D; part 3. | One tabbed box, four literal EN/UK clipboard payloads, readable preview, correct persistent MCP installation, truthful copy feedback and a local-agent prerequisite. |
| **5. A separate Bun installation with the mascot laughing at manual command entry.** | Part 4 inside Section D. | Separate Bun disclosure with the exact `bunx delegatus-cli` command, accessible copy action, 600 ms one-shot laugh and localized joke. The supported command works without watching the animation. |
| **6. Minimal, beautiful and unlike generated landing pages, using real references.** | Parts 5–8. | Neutral dark surfaces, actual product imagery, one restrained character moment, verified Cyrillic-capable type, purposeful motion and eight documented reference-site entries with the inaccessible homepage clearly marked. |
| **7. English and Ukrainian versions of all copy.** | Copy tables in parts 1–4 and 6; all four install payloads. | `/en/` and `/uk/`, localized headings, captions, navigation, controls, image descriptions, error states and joke. Original English screenshot language is disclosed rather than silently faked. Test both languages at 390 px. |
