/* Workspaces prototype (docs/design/workspaces.md §9). Static HTML/CSS/JS, no
   product code. One page per variant (variant-N.html) sets data-variant; the
   query string picks ?lang=en|uk, ?theme=light|dark, and ?story for the
   storyboard the PNG frames are taken from. Without ?story the page is the
   clickable prototype: one screen, the controls work, and a small bar at the
   bottom right jumps between the numbered states. */
(() => {
  const Q = new URLSearchParams(location.search);
  const V = Number(document.documentElement.dataset.variant || Q.get("v") || 1);
  const L = Q.get("lang") === "uk" ? "uk" : "en";
  const THEME = Q.get("theme") === "dark" ? "dark" : "light";
  const STORY = Q.has("story");
  document.documentElement.lang = L;
  document.documentElement.dataset.theme = THEME;

  // ── Copy ──────────────────────────────────────────────────────────────
  const T = {
    en: {
      variant: "Variant {n}",
      level: "level {n}",
      stateBar: "States",
      "rail.filter": "Filter projects…", "rail.overview": "Overview", "rail.projects": "Projects", "rail.menu": "More",
      "rail.hide": "Hide the projects sidebar (B)", "rail.createProject": "Create project",
      "ws.label": "Workspace", "ws.all": "All workspaces", "ws.new": "New workspace", "ws.manage": "Manage workspaces",
      "ws.settings": "Workspace settings", "ws.unassigned": "Unassigned", "ws.moveTo": "Move to…", "ws.heading": "Workspaces",
      "ws.onlyOwner": "Only you see these until you place them.",
      "board.working": "{n} working", "board.needs": "{n} needs you",
      "col.inbox": "Inbox", "col.assigned": "In progress", "col.blocked": "Waiting", "col.done": "Done",
      "team.title": "Team", "team.subtitle": "Who is on this Delegatus, what each person did, and where they are signed in.",
      "team.subtitleAt": "Who is on this Delegatus ({ws}), what each person did, and where they are signed in.",
      "team.back": "Board", "team.signOut": "Sign out · {name}",
      "tab.members": "Members", "tab.workspaces": "Workspaces", "tab.activity": "Activity", "tab.sessions": "Sessions",
      "team.invite": "Invite", "team.approveDevice": "Approve a device", "team.you": "you",
      "role.owner": "owner", "role.manager": "manager", "role.member": "member",
      "presence.online": "online · desktop", "presence.seen": "seen {age}", "presence.never": "never signed in",
      "noWs": "no workspace",
      "wsList.lead": "Each workspace is a set of projects and the people who may see them.",
      "wsList.manager": "manager {name}", "wsList.unassignedTitle": "Unassigned projects",
      "create.title": "New workspace", "create.step": "New workspace · step {a} of {b}", "create.name": "Name", "create.colour": "Colour",
      "create.projects": "Projects", "create.projectsHint": "A project belongs to one workspace. Only the people in this workspace will see it.",
      "create.manager": "Manager", "create.managerHint": "Adds projects and invites people into this workspace.",
      "create.submit": "Create workspace", "create.next": "Next", "create.back": "Back", "cancel": "Cancel", "close": "Close",
      "create.inWs": "in {ws}", "create.unassigned": "unassigned", "create.youOwner": "You (owner)",
      "def.accounts": "Agent accounts", "def.accountsHint": "Agents in this workspace use only the ticked accounts. Nothing ticked means any account.",
      "def.chat": "Report chat", "def.chatHint": "Reports from these projects go here, and directives are accepted from this chat.",
      "def.share": "Worker share", "def.shareLine": "Up to {n} of the {total} workers on this Delegatus at once",
      "def.fence": "Agents started in this workspace see and change only its projects through Delegatus tools. They still run as this computer's user, so a shell command can read other folders.",
      "acct.claudeA": "Claude · account A", "acct.claudeB": "Claude · account B", "acct.codexA": "Codex · account A", "acct.codexB": "Codex · account B",
      "chat.client": "Telegram · client work reports", "chat.design": "Telegram · design chat",
      "create.unfenced": "This limits what people see. Agents of every workspace still reach every project through Delegatus tools and their shell.",
      "wsp.sub": "Workspace · {p} · {m}", "wsp.addProject": "Add project", "wsp.usage": "Usage this week", "wsp.fence": "Agent fence",
      "wsp.hours": "Agent hours", "wsp.hoursV": "41 h", "wsp.share": "{h} h · {p}% of hours", "wsp.workersNow": "Workers now", "wsp.workersNowV": "5 of 8",
      "wsp.refused": "Refused this week", "wsp.refusedEx": "A worker in shop-app asked for the relay-bridge board · 12 min ago",
      "inv.title": "Invite someone", "inv.name": "Their name (optional)", "inv.ws": "Workspace", "inv.noWs": "No workspace: Team page only",
      "inv.role": "Role in the workspace", "inv.member": "Member", "inv.memberSub": "works on its boards and agents",
      "inv.manager": "Manager", "inv.managerSub": "also adds projects and invites",
      "inv.note": "Works once and expires in 7 days. Whoever opens it joins {ws} as a member. You will not see this link again.",
      "inv.noteInst": "Works once and expires in 7 days. Whoever opens it joins this Delegatus, {ws}, as a member. Other workspaces have their own teams and invites.",
      "inv.create": "Create link",
      "na.title": "You are not in this workspace", "na.body": "This link opens a project in {ws}. Its manager, {name}, can add you.",
      "na.back": "Back to {ws}", "na.foot": "Its boards, conversations and agents stay hidden from you.",
      "nw.title": "You are not in a workspace yet", "nw.body": "{name}, the owner, adds you to one. Until then you see only the team.",
      "nw.signedIn": "Signed in as {name}", "nw.team": "Open Team", "nw.signOut": "Sign out",
      "inst.heading": "Workspaces on this computer", "inst.port": "port {p}", "inst.signedIn": "signed in", "inst.signIn": "sign-in needed",
      "inst.note": "Each workspace is its own Delegatus. It opens in a new tab, with its own sign-in.",
      "inst.overview": "Workspaces overview", "inst.newOnMain": "New workspace…",
            "hub.title": "Workspaces", "hub.sub": "Separate Delegatus installations on this computer, linked through Linked installs.",
      "hub.subUsers": "Separate Delegatus installations, each under its own computer user, linked through Linked installs.",
      "hub.ws": "Workspace", "hub.addr": "Address", "hub.team": "Team", "hub.working": "Working", "hub.needs": "Needs you", "hub.link": "Link", "hub.user": "Computer user", "hub.logins": "CLI logins",
      "hub.linked": "linked", "hub.thisOne": "this one", "hub.open": "Open", "hub.people": "{n}",
      "hub.loginsOk": "Claude ✓ · Codex ✓", "hub.loginsNone": "not signed in",
      "hub.loginsFix": "{ws} cannot start agents: {u} is not signed in to Claude or Codex. Sign in to each CLI as that user:",
      "hub.footer": "Agents of every row run as the same computer user and can read each other's checkouts.",
      "hub.footerUsers": "An agent of one row cannot read another row's home folder, checkouts or logins.",
      "ci.title": "New workspace", "ci.port": "Port", "ci.state": "State folder", "ci.cmd": "Run this in a terminal on this computer",
      "ci.steps1": "Run the command. It starts a new, empty Delegatus.", "ci.steps2": "Open the new address and set up its team.", "ci.steps3": "Pair it here from ⋯ → Linked installs.",
      "ci.note": "Delegatus does not start other installations itself.", "ci.copy": "Copy command", "ci.done": "Done",
      "cu.user": "Computer user", "cu.cmd": "Run these lines yourself; Delegatus never runs sudo",
      "cu.after": "The new user starts with no Claude or Codex login and no checkouts. Sign in to each CLI and clone the repositories again as that user.",
      "mv.title": "Move shop-app to Research", "mv.body": "Research runs as another computer user, so the project cannot move in place. The move takes two steps.",
      "mv.s1": "1 · Clone the repository as {u}", "mv.s1Hint": "Run this yourself; Delegatus never runs sudo.",
      "mv.s2": "2 · Move the tasks and history", "mv.s2Hint": "Delegatus checks that the clone exists, imports the tasks and history of shop-app into Research, and removes shop-app from Client work.",
      "mv.go": "Move tasks and history",
      "mv.warn": "Uncommitted changes, local branches and running agents stay behind in the old checkout.", "mv.show": "Show the commands", "mv.remote": "the shop-app remote",
            "cu.steps1": "Run the lines. The last one starts a new, empty Delegatus as that user.",
      "si.tg": "Continue with Telegram", "si.pk": "Use a passkey", "si.ap": "Approve from another device",
      "si.hint": "Got an invite link? Open that link on this device.",
      "fs.title": "{ws} has its own team", "fs.body": "This link opens a project in {ws}, a separate Delegatus. Only its team can sign in, and you are not signed in to it. Its manager, {name}, can invite you.",
      "fs.or": "On its team? Sign in", "fs.back": "Back to {ws}",
      "ph.projects": "Projects", "ph.overview": "Overview", "ph.quiet": "quiet · {age}", "ph.working": "{n} working",
      "ph.wsRow": "Workspace", "ph.move": "Move", "ph.hidden": "Project hidden",
      "ph.moveChoose": "Choosing where to move", "ph.moveDialog": "The move dialog",
      "acct.plan.max": "Max", "acct.plan.pro": "Pro", "acct.plan.plus": "Plus",
    },
    uk: {
      variant: "Варіант {n}",
      level: "рівень {n}",
      stateBar: "Стани",
      "rail.filter": "Фільтр проєктів…", "rail.overview": "Огляд", "rail.projects": "Проєкти", "rail.menu": "Ще",
      "rail.hide": "Сховати бічну панель проєктів (B)", "rail.createProject": "Створити проєкт",
      "ws.label": "Простір", "ws.all": "Усі простори", "ws.new": "Новий простір", "ws.manage": "Керувати просторами",
      "ws.settings": "Налаштування простору", "ws.unassigned": "Без простору", "ws.moveTo": "Перенести в…", "ws.heading": "Простори",
      "ws.onlyOwner": "Їх бачите лише ви, доки не розподілите.",
      "board.working": "{n} працює", "board.needs": "{n} чекає на вас",
      "col.inbox": "Вхідні", "col.assigned": "У роботі", "col.blocked": "Очікують", "col.done": "Готові",
      "team.title": "Команда", "team.subtitle": "Учасники цього Delegatus, хто що зробив і на яких пристроях вони увійшли.",
      "team.subtitleAt": "Учасники цього Delegatus («{ws}»), хто що зробив і на яких пристроях вони увійшли.",
      "team.back": "Дошка", "team.signOut": "Вийти · {name}",
      "tab.members": "Учасники", "tab.workspaces": "Простори", "tab.activity": "Дії", "tab.sessions": "Сеанси",
      "team.invite": "Запросити", "team.approveDevice": "Підтвердити пристрій", "team.you": "ви",
      "role.owner": "власник", "role.manager": "керівник", "role.member": "учасник",
      "presence.online": "онлайн · комп’ютер", "presence.seen": "був(ла) {age}", "presence.never": "ще не входив(ла)",
      "noWs": "без простору",
      "wsList.lead": "Простір — це набір проєктів і людей, які можуть їх бачити.",
      "wsList.manager": "керівник: {name}", "wsList.unassignedTitle": "Проєкти без простору",
      "create.title": "Новий простір", "create.step": "Новий простір · крок {a} з {b}", "create.name": "Назва", "create.colour": "Колір",
      "create.projects": "Проєкти", "create.projectsHint": "Проєкт належить одному простору. Його бачитимуть лише учасники цього простору.",
      "create.manager": "Керівник", "create.managerHint": "Додає проєкти й запрошує людей у цей простір.",
      "create.submit": "Створити простір", "create.next": "Далі", "create.back": "Назад", "cancel": "Скасувати", "close": "Закрити",
      "create.inWs": "у «{ws}»", "create.unassigned": "без простору", "create.youOwner": "Ви (власник)",
      "def.accounts": "Акаунти агентів", "def.accountsHint": "Агенти цього простору користуються лише позначеними акаунтами. Якщо нічого не позначено, підходить будь-який.",
      "def.chat": "Чат для звітів", "def.chatHint": "Сюди надходять звіти цих проєктів, і звідси приймаються вказівки.",
      "def.share": "Частка воркерів", "def.shareLine": "Одночасно до {n} із {total} воркерів цього Delegatus",
      "def.fence": "Агенти, запущені в цьому просторі, через інструменти Delegatus бачать і змінюють лише його проєкти. Вони й далі працюють від користувача цього комп’ютера, тож команда в оболонці може прочитати інші теки.",
      "acct.claudeA": "Claude · акаунт A", "acct.claudeB": "Claude · акаунт B", "acct.codexA": "Codex · акаунт A", "acct.codexB": "Codex · акаунт B",
      "chat.client": "Telegram · звіти клієнтів", "chat.design": "Telegram · чат дизайну",
      "create.unfenced": "Це обмежує лише те, що бачать люди. Агенти будь-якого простору й далі досягають усіх проєктів через інструменти Delegatus і свою оболонку.",
      "wsp.sub": "Простір · {p} · {m}", "wsp.addProject": "Додати проєкт", "wsp.usage": "Використання за тиждень", "wsp.fence": "Огорожа для агентів",
      "wsp.hours": "Години агентів", "wsp.hoursV": "41 год", "wsp.share": "{h} год · {p}% годин", "wsp.workersNow": "Воркерів зараз", "wsp.workersNowV": "5 з 8",
      "wsp.refused": "Відмовлено за тиждень", "wsp.refusedEx": "Воркер у shop-app запитав дошку relay-bridge · 12 хв тому",
      "inv.title": "Запросити когось", "inv.name": "Ім’я (необов’язково)", "inv.ws": "Простір", "inv.noWs": "Без простору: лише сторінка команди",
      "inv.role": "Роль у просторі", "inv.member": "Учасник", "inv.memberSub": "дошки й агенти простору",
      "inv.manager": "Керівник", "inv.managerSub": "ще й проєкти та запрошення",
      "inv.note": "Діє один раз і спливає через 7 днів. Хто відкриє, приєднається до простору «{ws}» як учасник. Більше це посилання не покажеться.",
      "inv.noteInst": "Діє один раз і спливає через 7 днів. Хто відкриє, приєднається до цього Delegatus («{ws}») як учасник. Інші простори мають власні команди й запрошення.",
      "inv.create": "Створити посилання",
      "na.title": "Ви не в цьому просторі", "na.body": "Посилання веде до проєкту в просторі «{ws}». Додати вас може його керівник, {name}.",
      "na.back": "Назад до простору «{ws}»", "na.foot": "Його дошки, розмови й агенти для вас приховані.",
      "nw.title": "Ви ще не в жодному просторі", "nw.body": "Власник, {name}, додасть вас до простору. Доти ви бачите лише команду.",
      "nw.signedIn": "Ви увійшли як {name}", "nw.team": "Відкрити команду", "nw.signOut": "Вийти",
      "inst.heading": "Простори на цьому комп’ютері", "inst.port": "порт {p}", "inst.signedIn": "ви увійшли", "inst.signIn": "потрібен вхід",
      "inst.note": "Кожен простір — окремий Delegatus. Він відкривається в новій вкладці зі своїм входом.",
      "inst.overview": "Огляд просторів", "inst.newOnMain": "Новий простір…",
            "hub.title": "Простори", "hub.sub": "Окремі інсталяції Delegatus на цьому комп’ютері, пов’язані через «Пов’язані інсталяції».",
      "hub.subUsers": "Окремі інсталяції Delegatus, кожна під власним користувачем комп’ютера, пов’язані через «Пов’язані інсталяції».",
      "hub.ws": "Простір", "hub.addr": "Адреса", "hub.team": "Команда", "hub.working": "Працюють", "hub.needs": "Чекають на вас", "hub.link": "Зв’язок", "hub.user": "Користувач", "hub.logins": "Входи в CLI",
      "hub.linked": "пов’язано", "hub.thisOne": "цей", "hub.open": "Відкрити", "hub.people": "{n}",
      "hub.loginsOk": "Claude ✓ · Codex ✓", "hub.loginsNone": "вхід не виконано",
      "hub.loginsFix": "«{ws}» не може запускати агентів: {u} не ввійшов у Claude чи Codex. Увійдіть у кожен CLI від імені цього користувача:",
      "hub.footer": "Агенти всіх рядків працюють від того самого користувача комп’ютера й можуть читати робочі копії одне одного.",
      "hub.footerUsers": "Агент одного рядка не може прочитати домашню теку, робочі копії чи входи іншого рядка.",
      "ci.title": "Новий простір", "ci.port": "Порт", "ci.state": "Тека стану", "ci.cmd": "Запустіть це в терміналі на цьому комп’ютері",
      "ci.steps1": "Запустіть команду. Вона стартує новий, порожній Delegatus.", "ci.steps2": "Відкрийте нову адресу й налаштуйте там команду.", "ci.steps3": "Під’єднайте його тут: ⋯ → Пов’язані інсталяції.",
      "ci.note": "Delegatus сам не запускає інші інсталяції.", "ci.copy": "Скопіювати команду", "ci.done": "Готово",
      "cu.user": "Користувач комп’ютера", "cu.cmd": "Запустіть ці рядки самі; Delegatus ніколи не виконує sudo",
      "cu.after": "Новий користувач починає без входу в Claude чи Codex і без робочих копій. Увійдіть у кожен CLI та знову клонуйте репозиторії від його імені.",
      "mv.title": "Перенести shop-app у «Дослідження»", "mv.body": "«Дослідження» працює від іншого користувача комп’ютера, тож проєкт не можна перенести на місці. Перенесення має два кроки.",
      "mv.s1": "1 · Клонуйте репозиторій від імені {u}", "mv.s1Hint": "Запустіть це самі; Delegatus ніколи не виконує sudo.",
      "mv.s2": "2 · Перенесіть завдання й історію", "mv.s2Hint": "Delegatus перевіряє, що клон існує, імпортує завдання й історію shop-app у «Дослідження» та прибирає shop-app з простору «Клієнти».",
      "mv.go": "Перенести завдання й історію",
      "mv.warn": "Незакомічені зміни, локальні гілки й запущені агенти лишаються в старій робочій копії.", "mv.show": "Показати команди", "mv.remote": "віддалений репозиторій shop-app",
            "cu.steps1": "Запустіть ці рядки. Останній стартує новий, порожній Delegatus від імені цього користувача.",
      "si.tg": "Продовжити через Telegram", "si.pk": "Увійти з ключем доступу", "si.ap": "Підтвердити з іншого пристрою",
      "si.hint": "Маєте посилання-запрошення? Відкрийте це посилання на цьому пристрої.",
      "fs.title": "«{ws}» має власну команду", "fs.body": "Посилання веде до проєкту в просторі «{ws}» — окремому Delegatus. Увійти може лише його команда, а ви в ньому не входили. Запросити вас може його керівник, {name}.",
      "fs.or": "Ви в його команді? Увійдіть", "fs.back": "Назад до «{ws}»",
      "ph.projects": "Проєкти", "ph.overview": "Огляд", "ph.quiet": "тихо · {age}", "ph.working": "{n} працює",
      "ph.wsRow": "Простір", "ph.move": "Перенести", "ph.hidden": "Проєкт приховано",
      "ph.moveChoose": "Вибір, куди перенести", "ph.moveDialog": "Діалог перенесення",
      "acct.plan.max": "Max", "acct.plan.pro": "Pro", "acct.plan.plus": "Plus",
    },
  };
  const t = (key, vars = {}) => {
    const raw = T[L][key] ?? T.en[key] ?? key;
    return raw.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
  };
  const ukForm = (n, one, few, many) => {
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return one;
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
    return many;
  };
  const nProjects = (n) => (L === "uk" ? `${n} ${ukForm(n, "проєкт", "проєкти", "проєктів")}` : `${n} ${n === 1 ? "project" : "projects"}`);
  const nPeople = (n) => (L === "uk" ? `${n} ${ukForm(n, "учасник", "учасники", "учасників")}` : `${n} ${n === 1 ? "person" : "people"}`);
  const nWorking = (n) => (L === "uk" ? `${n} ${ukForm(n, "працює", "працюють", "працюють")}` : `${n} working`);
  const nNeeds = (n) => (L === "uk" ? `${n} ${ukForm(n, "чекає", "чекають", "чекають")} на вас` : `${n} ${n === 1 ? "needs" : "need"} you`);
  const age = (v) => {
    const m = /^(\d+)([smhd])$/.exec(v);
    if (!m) return v;
    if (L === "en") return v;
    return `${m[1]} ${{ s: "с", m: "хв", h: "год", d: "д" }[m[2]]}`;
  };
  const tx = (o) => (typeof o === "string" ? o : o[L]);

  // ── Fixture ───────────────────────────────────────────────────────────
  const COLORS = { coral: "#e07a5f", amber: "#d9a400", lime: "#7cb342", teal: "#1a9e8f", sky: "#3d7fd6", violet: "#8a63d2", pink: "#d64f8a", slate: "#7b8a99" };
  const INK = { coral: "#1f2328", amber: "#1f2328", lime: "#1f2328", teal: "#1f2328", sky: "#ffffff", violet: "#ffffff", pink: "#1f2328", slate: "#1f2328" };
  const PEOPLE = {
    roman: { name: { en: "Roman", uk: "Роман" }, ini: { en: "R", uk: "Р" }, color: "violet", seen: "online" },
    ira: { name: { en: "Ira", uk: "Іра" }, ini: { en: "I", uk: "І" }, color: "teal", seen: "8m" },
    taras: { name: { en: "Taras", uk: "Тарас" }, ini: { en: "T", uk: "Т" }, color: "sky", seen: "2h" },
    lev: { name: { en: "Lev", uk: "Лев" }, ini: { en: "L", uk: "Л" }, color: "amber", seen: "1d" },
    dana: { name: { en: "Dana", uk: "Дана" }, ini: { en: "D", uk: "Д" }, color: "pink", seen: "never" },
    marta: { name: { en: "Marta", uk: "Марта" }, ini: { en: "M", uk: "М" }, color: "lime", seen: "never" },
  };
  const WS = {
    core: { name: { en: "Delegatus core", uk: "Ядро Delegatus" }, color: "violet", projects: ["delegatus", "delegatus-site", "relay-bridge"], people: { roman: "manager", lev: "member" }, port: 8898, user: "ws-core" },
    client: { name: { en: "Client work", uk: "Клієнти" }, color: "teal", projects: ["shop-backend", "shop-app", "crm-sync"], people: { ira: "manager", taras: "member" }, port: 8901, user: "ws-client" },
    research: { name: { en: "Research", uk: "Дослідження" }, color: "amber", projects: ["voice-lab", "eval-harness"], people: { lev: "manager" }, port: 8902, user: "ws-research" },
  };
  /* The workspace every create dialog makes: a name no other frame lists. */
  const NEW = { name: { en: "Design", uk: "Дизайн" }, color: "pink", port: 8903, user: "ws-design", dir: "~/.config/delegatus-design" };
  const UNASSIGNED = ["scratch-notes", "bench-tmp"];
  const PROJ = {
    delegatus: { needs: 2, live: 4, age: "1m" }, "delegatus-site": { needs: 0, live: 0, age: "3h" }, "relay-bridge": { needs: 0, live: 1, age: "9m" },
    "shop-backend": { needs: 1, live: 3, age: "2m" }, "shop-app": { needs: 0, live: 1, age: "14m" }, "crm-sync": { needs: 0, live: 0, age: "2d" },
    "voice-lab": { needs: 1, live: 0, age: "40m" }, "eval-harness": { needs: 0, live: 0, age: "5h" },
    "scratch-notes": { needs: 0, live: 0, age: "6d" }, "bench-tmp": { needs: 0, live: 0, age: "3d" },
  };
  const wsName = (id) => tx(WS[id].name);
  const pname = (id) => tx(PEOPLE[id].name);

  const TASKS = {
    "shop-backend": {
      inbox: [
        { t: { en: "Add refunds to the order API", uk: "Додати повернення коштів в API замовлень" }, m: { en: "Ira · 1h", uk: "Іра · 1 год" } },
        { t: { en: "Rate limit for the partner webhook", uk: "Обмеження частоти для вебхука партнера" }, m: { en: "Taras · 3h", uk: "Тарас · 3 год" } },
      ],
      assigned: [
        { t: { en: "Move payments to the new provider", uk: "Перевести платежі на нового провайдера" }, e: "claude", m: { en: "Opus · working 4m", uk: "Opus · працює 4 хв" }, live: true },
        { t: { en: "Fix duplicate order emails", uk: "Виправити дублікати листів про замовлення" }, e: "codex", m: { en: "Sol · review round 2", uk: "Sol · рев’ю, раунд 2" }, live: true },
        { t: { en: "Index orders by customer and date", uk: "Індекс замовлень за клієнтом і датою" }, e: "codex", m: { en: "Sol · working 11m", uk: "Sol · працює 11 хв" }, live: true },
      ],
      blocked: [
        { t: { en: "Choose the refund window", uk: "Обрати строк для повернень" }, e: "claude", m: { en: "Opus · asks you", uk: "Opus · питає вас" }, needs: true },
      ],
      done: [
        { t: { en: "Nightly export to the CRM", uk: "Нічний експорт у CRM" }, m: { en: "merged · yesterday", uk: "злито · вчора" } },
        { t: { en: "Cache product search", uk: "Кешувати пошук товарів" }, m: { en: "merged · 2d", uk: "злито · 2 д" } },
      ],
    },
    /* Agrees with its header: one working, nothing asks you. */
    "shop-app": {
      inbox: [
        { t: { en: "Show refunds in the order screen", uk: "Показати повернення на екрані замовлення" }, m: { en: "Ira · 2h", uk: "Іра · 2 год" } },
      ],
      assigned: [
        { t: { en: "Offline cart for weak connections", uk: "Офлайн-кошик для слабкого зв’язку" }, e: "claude", m: { en: "Opus · working 14m", uk: "Opus · працює 14 хв" }, live: true },
      ],
      blocked: [
        { t: { en: "Release the 2.4 build to testers", uk: "Випустити збірку 2.4 для тестувальників" }, e: "codex", m: { en: "Sol · waits for the refunds API", uk: "Sol · чекає на API повернень" } },
      ],
      done: [
        { t: { en: "Dark theme for the checkout", uk: "Темна тема для оформлення замовлення" }, m: { en: "merged · yesterday", uk: "злито · вчора" } },
      ],
    },
    "scratch-notes": {
      inbox: [{ t: { en: "Notes from the planning call", uk: "Нотатки з планувального дзвінка" }, m: { en: "Roman · 6d", uk: "Роман · 6 д" } }],
      assigned: [], blocked: [],
      done: [{ t: { en: "Benchmark scratch run", uk: "Пробний прогін бенчмарку" }, m: { en: "done · 6d", uk: "готово · 6 д" } }],
    },
  };

  // ── Icons (lucide geometry) ────────────────────────────────────────────
  const P = {
    chevD: '<path d="m6 9 6 6 6-6"/>', chevL: '<path d="m15 18-6-6 6-6"/>', chevR: '<path d="m9 18 6-6-6-6"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    folderPlus: '<path d="M12 10v6M9 13h6M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
    layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
    folders: '<path d="M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z"/><path d="M2 8v11a2 2 0 0 0 2 2h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>', x: '<path d="M18 6 6 18M6 6l12 12"/>', plus: '<path d="M5 12h14M12 5v14"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    person: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    arrowL: '<path d="m12 19-7-7 7-7M19 12H5"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    move: '<path d="m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>',
    sliders: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    send: '<path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/>',
    key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  };
  const I = (name, cls = "") => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name]}</svg>`;
  const dot = (color, cls = "") => `<span class="dot ${cls}" style="background:${COLORS[color]}" aria-hidden="true"></span>`;
  const av = (id, size = 28) => {
    const p = PEOPLE[id];
    return `<span class="av" aria-hidden="true" style="width:${size}px;height:${size}px;background:${COLORS[p.color]};color:${INK[p.color]};font-size:${Math.max(10, Math.round(size * 0.5))}px">${tx(p.ini)}</span>`;
  };
  const wsq = (id) => `<span class="wsq" aria-hidden="true" style="background:${COLORS[WS[id].color]};color:${INK[WS[id].color]}">${wsName(id).slice(0, 1)}</span>`;

  // ── Desktop pieces ─────────────────────────────────────────────────────
  const instVariant = V >= 3;

  function railRow(id, selected, opts = {}) {
    const p = PROJ[id];
    return `<div style="position:relative"><button class="rrow ${selected ? "on" : ""}" data-act="project" data-id="${id}" ${selected ? 'aria-current="page"' : ""}>
      <span class="nm">${id}</span>
      <span class="slot-n" ${opts.move ? 'style="opacity:0"' : ""}>${p.needs ? `<span class="needs">${I("person", "s12")}${p.needs}</span>` : ""}</span>
      <span class="slot-l" ${opts.move ? 'style="opacity:0"' : ""}>${p.live ? `<span class="live-m">${p.live}</span>` : ""}</span>
      <span class="age" ${opts.move ? 'style="opacity:0"' : ""}>${age(p.age)}</span>
    </button>${opts.move ? `<button class="rowbtn" data-act="move" data-id="${id}" aria-expanded="${opts.moveOpen ? "true" : "false"}">${I("move", "s12")}${t("ph.move")}</button>` : ""}</div>`;
  }

  function railHeader(st) {
    const canSwitch = st.who === "roman" || instVariant;
    const cur = st.ws === "all" ? null : st.ws;
    const label = cur ? wsName(cur) : t("ws.all");
    const lead = cur ? dot(WS[cur].color) : I("folders", "s12");
    const chip = canSwitch
      ? `<button class="wsw" data-act="switch" aria-haspopup="menu" aria-expanded="${st.overlay === "switch"}" aria-label="${t("ws.label")}: ${label}">${lead}<span class="nm">${label}</span>${I("chevD", "s12")}</button>`
      : `<span class="wsw static" aria-label="${t("ws.label")}: ${label}">${lead}<span class="nm">${label}</span></span>`;
    return `<header class="rail-head"><img class="mark" src="assets/delegatus-mark.svg" alt="">${chip}
      <button class="hsq" title="${t("rail.hide")}" aria-label="${t("rail.hide")}">${I("chevL")}</button>
      <button class="hsq" title="${t("rail.menu")}" aria-label="${t("rail.menu")}">${I("more")}</button></header>`;
  }

  function rail(st) {
    let rows = "";
    const sel = st.project;
    if (st.ws === "all") {
      for (const id of Object.keys(WS)) {
        rows += `<div class="slabel ws">${dot(WS[id].color, "sm")}<span>${wsName(id)}</span><span class="c">${WS[id].projects.length}</span></div>`;
        rows += WS[id].projects.map((p) => railRow(p, p === sel)).join("");
      }
      rows += `<div class="slabel ws"><span>${t("ws.unassigned")}</span><span class="c">${UNASSIGNED.length}</span></div>`;
      rows += UNASSIGNED.map((p) => railRow(p, p === sel, { move: p === sel, moveOpen: st.overlay === "move" })).join("");
      rows += `<p class="note" style="padding:4px 11px 0">${t("ws.onlyOwner")}</p>`;
    } else {
      const list = WS[st.ws].projects;
      rows += `<div class="slabel"><span>${t("rail.projects")}</span><span class="c">${list.length}</span></div>`;
      rows += list.map((p) => railRow(p, p === sel, st.moveFrom && p === sel ? { move: true, moveOpen: true } : {})).join("");
    }
    const overviewOn = !sel;
    return `<aside class="rail">${railHeader(st)}
      <div class="rail-filter"><label class="field">${I("search")}<span>${t("rail.filter")}</span></label><button class="sqbtn" title="${t("rail.createProject")}" aria-label="${t("rail.createProject")}">${I("folderPlus")}</button></div>
      <nav class="rail-nav" aria-label="${t("rail.projects")}">
        <button class="rrow ${overviewOn ? "on" : ""}" style="margin-bottom:4px"><span class="nm" style="flex:none">${t("rail.overview")}</span>${I("grid", "s12")}<span style="flex:1"></span></button>
        ${rows}
      </nav></aside>`;
  }

  function switchPop(st) {
    const rows = [];
    if (instVariant) {
      rows.push(`<div class="plabel">${t("inst.heading")}</div>`);
      /* Name and sign-in status only; ports and computer users live on the owner's overview. */
      for (const id of Object.keys(WS)) {
        const here = id === st.ws;
        const status = here ? "" : `<span class="meta">${id === "research" ? t("inst.signIn") : t("inst.signedIn")}</span>`;
        rows.push(`<button class="mrow ${here ? "cur" : ""}" data-act="ws" data-id="${id}" role="menuitem">${dot(WS[id].color)}<span class="nm one">${wsName(id)}</span>${status}${here ? `<span class="ck">${I("check")}</span>` : `<span class="meta">${I("ext", "s12")}</span>`}</button>`);
      }
      rows.push("<hr>");
      rows.push(`<button class="mrow" data-act="hub" role="menuitem">${I("folders", "s12")}<span class="nm one">${t("inst.overview")}</span>${I("ext", "s12")}</button>`);
      rows.push(`<p class="pnote">${t("inst.note")}</p>`);
    } else {
      rows.push(`<div class="plabel">${t("ws.heading")}</div>`);
      rows.push(`<button class="mrow ${st.ws === "all" ? "cur" : ""}" data-act="ws" data-id="all" role="menuitem">${I("folders", "s12")}<span class="nm">${t("ws.all")}</span><span class="meta">${nProjects(10)}</span>${st.ws === "all" ? `<span class="ck">${I("check")}</span>` : `<span style="width:14px"></span>`}</button>`);
      for (const id of Object.keys(WS)) {
        const cur = id === st.ws;
        rows.push(`<button class="mrow ${cur ? "cur" : ""}" data-act="ws" data-id="${id}" role="menuitem">${dot(WS[id].color)}<span class="nm">${wsName(id)}</span><span class="meta">${nProjects(WS[id].projects.length)}</span>${cur ? `<span class="ck">${I("check")}</span>` : `<span style="width:14px"></span>`}</button>`);
      }
      rows.push("<hr>");
      if (V === 2) rows.push(`<button class="mrow" data-act="wspage" role="menuitem">${I("sliders", "s12")}<span class="nm">${t("ws.settings")}</span></button>`);
      rows.push(`<button class="mrow" data-act="create" role="menuitem">${I("plus", "s12")}<span class="nm">${t("ws.new")}</span></button>`);
      rows.push(`<button class="mrow" data-act="manage" role="menuitem">${I("users", "s12")}<span class="nm">${t("ws.manage")}</span></button>`);
    }
    return `<div class="pop" role="menu" aria-label="${t("ws.label")}" style="top:36px;left:32px;width:${instVariant ? 300 : 272}px">${rows.join("")}</div>`;
  }

  function movePop() {
    const rows = Object.keys(WS).map((id) => `<button class="mrow" data-act="${V === 4 ? "moveproj" : "close"}" role="menuitem">${dot(WS[id].color)}<span class="nm">${wsName(id)}</span></button>`).join("");
    return `<div class="pop" role="menu" aria-label="${t("ws.moveTo")}" data-anchor=".rowbtn[aria-expanded='true']" style="top:0;left:252px;width:236px"><div class="plabel">${t("ws.moveTo")}</div>${rows}</div>`;
  }

  function card(task) {
    const eng = task.e ? `<span class="eng ${task.e}">${task.e === "claude" ? "Claude" : "Codex"}</span>` : "";
    const lead = task.live ? `<span class="live-m" style="font-weight:600"></span>` : task.needs ? `<span class="needs">${I("person", "s12")}1</span>` : "";
    return `<div class="card"><div class="t">${tx(task.t)}</div><div class="m">${lead}${eng}<span>${tx(task.m)}</span></div></div>`;
  }

  function board(project) {
    const data = TASKS[project] ?? TASKS["shop-backend"];
    const p = PROJ[project];
    const cols = ["inbox", "assigned", "blocked", "done"].map((c) => `<section class="col"><h3>${t(`col.${c}`)} <span class="tnum">${data[c].length}</span></h3>${data[c].map(card).join("")}</section>`).join("");
    return `<div class="bhead"><h2>${project}</h2>${p.live ? `<span class="live-m" style="font-size:12px">${nWorking(p.live)}</span>` : ""}${p.needs ? `<span class="pill-warn">${I("person", "s12")}${nNeeds(p.needs)}</span>` : ""}<span class="grow"></span>
      <span class="chip"><span class="eng claude">Claude</span>${I("chevD", "s12")}</span><span class="chip"><span class="eng codex">Codex</span>${I("chevD", "s12")}</span>
      <button class="ico-btn" aria-label="${t("rail.menu")}">${I("more")}</button></div>
      <div class="cols">${cols}</div>`;
  }

  function noAccessCard(phone) {
    return `<div class="auth-card" role="region" aria-label="${t("na.title")}"><div class="lockc">${I("lock", "s20")}</div>
      <h1>${t("na.title")}</h1>
      <p class="body">${t("na.body", { ws: wsName("core"), name: pname("roman") })}</p>
      <div class="acts"><button class="btn pri full" data-act="back">${t("na.back", { ws: wsName("client") })}</button></div>
      <p class="foot">${t("na.foot")}</p></div>`;
  }

  function appDesktop(st) {
    let main;
    if (st.page === "noaccess") {
      main = `<div class="main"><div class="inmain">${noAccessCard(false)}</div></div>`;
    } else {
      main = `<div class="main">${board(st.project)}</div>`;
    }
    if (st.overlay === "moveproj") return behind(`<div class="app">${rail(st)}${main}</div>`, moveDialog(false));
    const over = st.overlay === "switch" ? switchPop(st) : st.overlay === "move" ? movePop() : "";
    return `<div class="app">${rail(st)}${main}${over}</div>`;
  }

  // ── Team page and its dialogs ─────────────────────────────────────────
  function memberRow(id, role, extra = "") {
    const p = PEOPLE[id];
    const pres = p.seen === "online" ? `<span style="color:var(--success)">${t("presence.online")}</span>` : p.seen === "never" ? t("presence.never") : t("presence.seen", { age: L === "uk" ? `${age(p.seen)} тому` : `${p.seen} ago` });
    const wsOf = Object.keys(WS).filter((w) => WS[w].people[id]);
    const wsLine = instVariant ? "" : role === "owner" ? `<span>${t("ws.all")}</span>` : wsOf.length ? wsOf.map((w) => `<span style="display:inline-flex;align-items:center;gap:4px">${dot(WS[w].color, "sm")}${wsName(w)} · ${t(`role.${WS[w].people[id]}`)}</span>`).join("") : `<span style="color:var(--warning)">${t("noWs")}</span>`;
    return `<li>${av(id, 32)}<div class="who"><div class="l1"><span class="nm">${pname(id)}</span>${id === "roman" ? `<span class="muted" style="font-size:11px">${t("team.you")}</span>` : ""}<span class="role ${role === "owner" ? "owner" : ""}">${t(role === "owner" ? "role.owner" : "role.member")}</span></div>
      <div class="l2">${pres}${wsLine}${extra}</div></div><button class="ico-btn" aria-label="${t("rail.menu")}">${I("more", "s16")}</button></li>`;
  }

  function membersTab(st) {
    const ids = instVariant ? ["roman", "ira", "taras"] : ["roman", "ira", "taras", "lev", "dana"];
    return `<div class="tbar"><button class="btn sec sm">${I("phone")}${t("team.approveDevice")}</button><button class="btn pri sm" data-act="invite">${I("userPlus")}${t("team.invite")}</button></div>
      <ul class="list" aria-label="${t("tab.members")}">${ids.map((id) => memberRow(id, id === "roman" ? "owner" : "member")).join("")}</ul>`;
  }

  function workspacesTab() {
    const shown = Object.keys(WS);
    const unassigned = UNASSIGNED;
    const rows = shown.map((id) => {
      const w = WS[id];
      const people = Object.keys(w.people);
      const mgr = people.find((p) => w.people[p] === "manager");
      return `<li>${wsq(id)}<div class="who"><div class="l1"><span class="nm">${wsName(id)}</span></div>
        <div class="l2"><span>${nProjects(w.projects.length)} · ${w.projects.join(", ")}</span><span>${t("wsList.manager", { name: pname(mgr) })}</span></div></div>
        <span class="avs">${people.map((p) => av(p, 24)).join("")}</span>
        <button class="ico-btn" aria-label="${t("rail.menu")}">${I("more", "s16")}</button></li>`;
    }).join("");
    const un = unassigned.map((p) => `<li>${I("folder", "s16")}<div class="who"><div class="l1"><span class="nm">${p}</span></div><div class="l2"><span>${age(PROJ[p].age)}</span></div></div><button class="btn sec sm">${I("move", "s12")}${t("ws.moveTo")}</button></li>`).join("");
    return `<div class="tbar"><span class="lead">${t("wsList.lead")}</span><button class="btn pri sm" data-act="create">${I("plus")}${t("ws.new")}</button></div>
      <ul class="list" aria-label="${t("tab.workspaces")}">${rows}</ul>
      ${V === 1 ? `<div class="notice warn">${I("alert")}<span>${t("create.unfenced")}</span></div>` : ""}
      <div><h2 class="h2">${t("wsList.unassignedTitle")} · ${unassigned.length}</h2><ul class="list">${un}</ul><p class="note" style="padding:6px 4px 0">${t("ws.onlyOwner")}</p></div>`;
  }

  function teamPage(st, phone) {
    const tabs = instVariant ? ["members", "activity", "sessions"] : ["members", "workspaces", "activity", "sessions"];
    const tab = st.tab || "members";
    const body = tab === "workspaces" ? workspacesTab() : membersTab(st);
    const subtitle = instVariant ? t("team.subtitleAt", { ws: wsName(st.ws) }) : t("team.subtitle");
    return `<div class="page"><div class="page-in">
      <header class="phead"><button class="back" data-act="back">${I("arrowL", "s12")}${t("team.back")}</button>
        <div class="ttl"><h1>${t("team.title")}</h1>${phone ? "" : `<p>${subtitle}</p>`}</div>
        <button class="btn txt" aria-label="${t("team.signOut", { name: pname("roman") })}">${I("logout", phone ? "s16" : "")}${phone ? "" : t("team.signOut", { name: pname("roman") })}</button></header>
      <div class="tabs" role="tablist" aria-label="${t("team.title")}">${tabs.map((k) => `<button class="tab" role="tab" data-act="tab" data-id="${k}" aria-selected="${k === tab}">${t(`tab.${k}`)}</button>`).join("")}</div>
      ${body}</div></div>`;
  }

  function dialog(title, body, phone, wide = false) {
    const head = `<div class="dlg-h"><h2>${title}</h2><button class="ico-btn" data-act="close" aria-label="${t("close")}">${I("x", "s16")}</button></div>`;
    if (phone) {
      return `<div class="sheet-scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${title}"><div class="grab"><span></span></div>${head.replace("dlg-h", "sheet-h")}<div class="dlg-b">${body}</div></div></div>`;
    }
    return `<div class="scrim"><div class="dlg ${wide ? "w560" : ""}" role="dialog" aria-modal="true" aria-label="${title}">${head}<div class="dlg-b">${body}</div></div></div>`;
  }

  const fld = (label, inner, hint = "") => `<div class="fld"><span class="lb">${label}</span>${inner}${hint ? `<span class="hint">${hint}</span>` : ""}</div>`;
  const inp = (value, opts = {}) => `<div class="inp ${opts.focus ? "focus" : ""}">${opts.lead ?? ""}<span class="grow">${value}</span>${opts.select ? I("chevD", "s12") : ""}</div>`;
  const chk = (on, name, meta) => `<div class="chk"><span class="box ${on ? "on" : ""}">${on ? I("check", "s12") : ""}</span><span class="nm">${name}</span>${meta ? `<span class="meta">${meta}</span>` : ""}</div>`;

  function createStep1(phone) {
    const sw = Object.keys(COLORS).map((c) => `<span class="sw ${c === NEW.color ? "on" : ""}" style="background:${COLORS[c]}" role="radio" aria-checked="${c === NEW.color}" aria-label="${c}"></span>`).join("");
    const projects = [
      chk(true, "scratch-notes", t("create.unassigned")), chk(true, "bench-tmp", t("create.unassigned")),
      chk(false, "voice-lab", t("create.inWs", { ws: wsName("research") })), chk(false, "shop-app", t("create.inWs", { ws: wsName("client") })),
    ].join("");
    const body = fld(t("create.name"), inp(tx(NEW.name), { focus: true }))
      + fld(t("create.colour"), `<div class="swatches" role="radiogroup" aria-label="${t("create.colour")}">${sw}</div>`)
      + fld(t("create.projects"), `<div class="checks">${projects}</div>`, t("create.projectsHint"))
      + fld(t("create.manager"), inp(`${av("lev", 20)} ${pname("lev")}`, { select: true }), t("create.managerHint"))
      + (V === 1 ? `<div class="notice warn">${I("alert")}<span>${t("create.unfenced")}</span></div>` : "")
      + `<div class="dlg-f"><button class="btn sec" data-act="close">${t("cancel")}</button><button class="btn pri" data-act="${V === 2 ? "step2" : "close"}">${V === 2 ? t("create.next") : t("create.submit")}</button></div>`;
    return dialog(V === 2 ? t("create.step", { a: 1, b: 2 }) : t("create.title"), body, phone);
  }

  function accountRows(selected) {
    return [
      chk(selected.includes("claudeA"), t("acct.claudeA"), t("acct.plan.max")), chk(selected.includes("claudeB"), t("acct.claudeB"), t("acct.plan.pro")),
      chk(selected.includes("codexA"), t("acct.codexA"), t("acct.plan.pro")), chk(selected.includes("codexB"), t("acct.codexB"), t("acct.plan.plus")),
    ].join("");
  }

  function createStep2(phone) {
    const body = fld(t("def.accounts"), `<div class="checks">${accountRows(["claudeB", "codexB"])}</div>`, t("def.accountsHint"))
      + fld(t("def.chat"), inp(`${I("send", "s12")} ${t("chat.design")}`, { select: true }), t("def.chatHint"))
      + fld(t("def.share"), `<div style="display:flex;align-items:center;gap:10px"><span class="num">4</span><span class="sec" style="font-size:12px">${t("def.shareLine", { n: 4, total: 30 })}</span></div>`)
      + `<div class="notice info">${I("shield")}<span>${t("def.fence")}</span></div>`
      + `<div class="dlg-f"><button class="btn sec" data-act="create">${t("create.back")}</button><button class="btn pri" data-act="close">${t("create.submit")}</button></div>`;
    return dialog(t("create.step", { a: 2, b: 2 }), body, phone);
  }

  function inviteDialog(phone) {
    const pieces = [fld(t("inv.name"), inp(pname("marta")))];
    if (!instVariant) {
      pieces.push(fld(t("inv.ws"), inp(`${dot(WS.client.color)} ${wsName("client")}`, { select: true, focus: true })));
      pieces.push(fld(t("inv.role"), `<div class="seg" role="group" aria-label="${t("inv.role")}"><button aria-pressed="true">${t("inv.member")}<span class="sub">${t("inv.memberSub")}</span></button><button aria-pressed="false">${t("inv.manager")}<span class="sub">${t("inv.managerSub")}</span></button></div>`));
      pieces.push(`<p class="note">${t("inv.note", { ws: wsName("client") })}</p>`);
    } else {
      pieces.push(`<p class="note">${t("inv.noteInst", { ws: wsName("client") })}</p>`);
    }
    pieces.push(`<button class="btn pri full" data-act="close">${t("inv.create")}</button>`);
    return dialog(t("inv.title"), pieces.join(""), phone);
  }

  // ── Variant 2: the workspace page ──────────────────────────────────────
  function wsPage(phone) {
    const w = WS.client;
    const people = ["ira", "taras"];
    const sect = (title, body, action = "") => `<section class="sect"><div class="sect-h"><h3>${title}</h3>${action}</div><div class="sect-b">${body}</div></section>`;
    const projects = w.projects.map((p) => `<div class="srow">${I("folder")}<span class="nm">${p}</span><span class="meta">${PROJ[p].live ? nWorking(PROJ[p].live) : age(PROJ[p].age)}</span></div>`).join("");
    const ppl = [["roman", "owner"], ...people.map((p) => [p, w.people[p]])].map(([p, r]) => `<div class="srow">${av(p, 24)}<span class="nm">${pname(p)}</span><span class="role ${r === "owner" ? "owner" : r === "manager" ? "mgr" : ""}">${t(`role.${r}`)}</span></div>`).join("");
    const usage = `<div class="srow"><span class="nm">${t("wsp.hours")}</span><span class="meta">${t("wsp.hoursV")}</span></div>
      <div class="srow"><span class="nm" style="flex:none;width:150px">${t("acct.claudeA")}</span><span class="bar"><span style="width:62%"></span></span><span class="meta tnum">${t("wsp.share", { h: 25, p: 62 })}</span></div>
      <div class="srow"><span class="nm" style="flex:none;width:150px">${t("acct.codexA")}</span><span class="bar"><span style="width:38%"></span></span><span class="meta tnum">${t("wsp.share", { h: 16, p: 38 })}</span></div>
      <div class="srow"><span class="nm">${t("wsp.workersNow")}</span><span class="meta">${t("wsp.workersNowV")}</span></div>`;
    const left = sect(t("create.projects"), projects, `<button class="btn sec sm">${I("plus", "s12")}${t("wsp.addProject")}</button>`)
      + sect(t("tab.members"), ppl, `<button class="btn pri sm" data-act="invite">${I("userPlus", "s12")}${t("team.invite")}</button>`)
      + sect(t("wsp.usage"), usage);
    const right = sect(t("def.accounts"), `<div class="checks">${accountRows(["claudeA", "codexA"])}</div><span class="note">${t("def.accountsHint")}</span>`)
      + sect(t("def.chat"), `${inp(`${I("send", "s12")} ${t("chat.client")}`, { select: true })}<span class="note">${t("def.chatHint")}</span>`)
      + sect(t("def.share"), `<div style="display:flex;align-items:center;gap:10px"><span class="num">8</span><span class="sec" style="font-size:12px">${t("def.shareLine", { n: 8, total: 30 })}</span></div>`)
      + sect(t("wsp.fence"), `<div class="notice info">${I("shield")}<span>${t("def.fence")}</span></div><div class="srow"><span class="nm">${t("wsp.refused")}</span><span class="meta tnum">2</span></div><span class="note">${t("wsp.refusedEx")}</span>`);
    return `<div class="page"><div class="page-in wide">
      <header class="phead"><button class="back" data-act="back">${I("arrowL", "s12")}${t("team.back")}</button>
        <div class="ttl"><h1>${dot(w.color)}${wsName("client")}</h1><p>${t("wsp.sub", { p: nProjects(3), m: nPeople(3) })}</p></div></header>
      <div class="grid2"><div style="display:flex;flex-direction:column;gap:16px">${left}</div><div style="display:flex;flex-direction:column;gap:16px">${right}</div></div>
    </div></div>`;
  }

  // ── Variants 3 and 4: installations ───────────────────────────────────
  function hubPage(phone) {
    const rows = Object.keys(WS).map((id) => {
      const w = WS[id];
      const live = w.projects.reduce((n, p) => n + PROJ[p].live, 0);
      const needs = w.projects.reduce((n, p) => n + PROJ[p].needs, 0);
      const team = Object.keys(w.people).length + 1;
      return { id, w, live, needs, team };
    });
    /* Level 4: a workspace whose computer user has no CLI login cannot start agents; say so in words. */
    const logins = (id) => (id === "research" ? `<span class="wrnt" style="display:inline-flex;align-items:center;gap:4px">${I("alert", "s12")}${t("hub.loginsNone")}</span>` : `<span class="okt">${t("hub.loginsOk")}</span>`);
    const loginsFix = V === 4
      ? `<div class="notice warn">${I("alert")}<div style="display:flex;flex-direction:column;gap:8px;min-width:0;flex:1"><span>${t("hub.loginsFix", { ws: wsName("research"), u: `<span class="mono">${WS.research.user}</span>` })}</span><div class="code">sudo -iu ${WS.research.user} claude\nsudo -iu ${WS.research.user} codex login</div></div></div>`
      : "";
    /* Below 1100 px the table's nine columns do not fit; the rows become the list the phone shows. */
    if (phone || window.innerWidth < 1100) {
      const items = rows.map(({ id, w, live, needs, team }) => `<li>${wsq(id)}<div class="who"><div class="l1"><span class="nm">${wsName(id)}</span>${id === "core" ? `<span class="role">${t("hub.thisOne")}</span>` : ""}</div>
        <div class="l2"><span>${t("inst.port", { p: w.port })}</span>${V === 4 ? `<span class="mono">${w.user}</span>` : ""}<span>${nPeople(team)}</span></div>
        <div class="l2">${V === 4 ? logins(id) : ""}${live ? `<span class="okt">${nWorking(live)}</span>` : ""}${needs ? `<span class="wrnt">${nNeeds(needs)}</span>` : ""}</div></div>
        ${id === "core" ? "" : `<button class="ico-btn" aria-label="${t("hub.open")} ${wsName(id)}">${I("ext", "s16")}</button>`}</li>`).join("");
      return `<div class="page"><div class="page-in"><header class="phead"><button class="back" data-act="back">${I("arrowL", "s12")}${t("team.back")}</button><div class="ttl"><h1>${t("hub.title")}</h1></div></header>
        <p class="note" style="font-size:12px">${V === 4 ? t("hub.subUsers") : t("hub.sub")}</p>
        <div class="tbar"><button class="btn pri sm" data-act="create">${I("plus")}${t("ws.new")}</button></div>
        <ul class="list">${items}</ul>${loginsFix}
        <div class="notice ${V === 4 ? "info" : "warn"}">${I(V === 4 ? "shield" : "alert")}<span>${V === 4 ? t("hub.footerUsers") : t("hub.footer")}</span></div></div></div>`;
    }
    const head = [t("hub.ws"), t("hub.addr"), ...(V === 4 ? [t("hub.user"), t("hub.logins")] : []), t("hub.team"), t("hub.working"), t("hub.needs"), t("hub.link"), ""];
    const trs = rows.map(({ id, w, live, needs, team }) => `<tr><td><span style="display:inline-flex;align-items:center;gap:10px">${wsq(id)}<span class="nm">${wsName(id)}</span>${id === "core" ? `<span class="role">${t("hub.thisOne")}</span>` : ""}</span></td>
      <td class="tnum">${t("inst.port", { p: w.port })}</td>
      ${V === 4 ? `<td class="mono">${w.user}</td><td>${logins(id)}</td>` : ""}
      <td>${nPeople(team)}</td><td>${live ? `<span class="okt">${live}</span>` : `<span class="muted">0</span>`}</td><td>${needs ? `<span class="needs">${I("person", "s12")}${needs}</span>` : `<span class="muted">0</span>`}</td>
      <td>${id === "core" ? "<span class=\"muted\">—</span>" : `<span class="okt">${t("hub.linked")}</span>`}</td>
      <td style="text-align:right">${id === "core" ? "" : `<button class="btn sec sm">${t("hub.open")}${I("ext", "s12")}</button>`}</td></tr>`).join("");
    return `<div class="page"><div class="page-in wide hubw">
      <header class="phead"><button class="back" data-act="back">${I("arrowL", "s12")}${t("team.back")}</button><div class="ttl"><h1>${t("hub.title")}</h1><p>${V === 4 ? t("hub.subUsers") : t("hub.sub")}</p></div>
        <button class="btn pri sm" data-act="create">${I("plus")}${t("ws.new")}</button></header>
      <div class="list" style="padding:0"><table class="tbl"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${trs}</tbody></table></div>${loginsFix}
      <div class="notice ${V === 4 ? "info" : "warn"}">${I(V === 4 ? "shield" : "alert")}<span>${V === 4 ? t("hub.footerUsers") : t("hub.footer")}</span></div>
    </div></div>`;
  }

  function createInstDialog(phone) {
    /* Every line fits a 390 px sheet; a long command continues with a backslash, never mid-word. */
    const cmd3 = `LLV_STATE_DIR=${NEW.dir} \\\n  bunx delegatus-cli --port ${NEW.port}`;
    const cmd4 = `sudo useradd --create-home ${NEW.user}\nsudo loginctl enable-linger ${NEW.user}\nsudo -iu ${NEW.user} \\\n  bunx delegatus-cli --port ${NEW.port}`;
    const fields = fld(t("create.name"), inp(tx(NEW.name)))
      + `<div style="display:grid;grid-template-columns:${phone ? "1fr" : "120px 1fr"};gap:10px">${fld(t("ci.port"), inp(String(NEW.port)))}${V === 4 ? fld(t("cu.user"), inp(`<span class="mono">${NEW.user}</span>`)) : fld(t("ci.state"), inp(`<span class="mono">${NEW.dir}</span>`))}</div>`
      + fld(t(V === 4 ? "cu.cmd" : "ci.cmd"), `<div class="code">${V === 4 ? cmd4 : cmd3}</div>`)
      + `<ol class="steps"><li>${t(V === 4 ? "cu.steps1" : "ci.steps1")}</li><li>${t("ci.steps2")}</li><li>${t("ci.steps3")}</li></ol>`
      + (V === 4 ? `<div class="notice warn">${I("alert")}<span>${t("cu.after")}</span></div>` : "")
      + `<p class="note">${t("ci.note")}</p>`
      + `<div class="dlg-f"><button class="btn sec" data-act="close">${I("copy", "s12")}${t("ci.copy")}</button><button class="btn pri" data-act="close">${t("ci.done")}</button></div>`;
    return dialog(t("ci.title"), fields, phone, true);
  }

  function moveDialog(phone) {
    const cmd = `sudo -iu ${WS.research.user} \\\n  git clone &lt;${t("mv.remote")}&gt;`;
    /* Two numbered steps, like the create dialogs; the primary action is step 2, the one that completes the move. */
    const user = `<span class="mono">${WS.research.user}</span>`;
    const body = `<p class="sec" style="margin:0;font-size:12px;line-height:1.55">${t("mv.body")}</p>`
      + `<div class="notice warn">${I("alert")}<span>${t("mv.warn")}</span></div>`
      + fld(t("mv.s1", { u: user }), `<div class="code">${cmd}</div><div style="display:flex;align-items:center;gap:10px"><button class="btn sec sm" style="flex:none">${I("copy", "s12")}${t("ci.copy")}</button><span class="note">${t("mv.s1Hint")}</span></div>`)
      + fld(t("mv.s2"), "", t("mv.s2Hint"))
      + `<div class="dlg-f"><button class="btn sec" data-act="close">${t("cancel")}</button><button class="btn pri" data-act="close">${I("move", "s12")}${t("mv.go")}</button></div>`;
    return dialog(t("mv.title"), body, phone, true);
  }

  /* Level 3 and 4: a link into another installation meets that installation's sign-in, which says whose team it is. */
  function foreignSignInCard() {
    return `<div class="auth-card" role="region" aria-label="${t("fs.title", { ws: wsName("core") })}"><div class="lockc">${I("lock", "s20")}</div>
      <h1>${t("fs.title", { ws: wsName("core") })}</h1>
      <p class="body">${t("fs.body", { ws: wsName("core"), name: pname("roman") })}</p>
      <div class="acts"><button class="btn pri full" data-act="back">${t("fs.back", { ws: wsName("client") })}</button>
      <div class="or">${t("fs.or")}</div>
      <button class="btn sec full">${I("send")}${t("si.tg")}</button><button class="btn sec full">${I("key")}${t("si.pk")}</button><button class="btn sec full">${I("phone")}${t("si.ap")}</button></div>
      <p class="foot">${t("si.hint")}</p></div>`;
  }

  function noWorkspaceCard() {
    return `<div class="auth-card"><img class="badge" src="assets/delegatus-badge.svg" alt=""><h1>${t("nw.title")}</h1><p class="sub">${t("nw.signedIn", { name: pname("dana") })}</p>
      <p class="body">${t("nw.body", { name: pname("roman") })}</p>
      <div class="acts"><button class="btn sec full">${I("users")}${t("nw.team")}</button><button class="btn txt" style="align-self:center">${I("logout", "s12")}${t("nw.signOut")}</button></div></div>`;
  }

  const localeSwitch = () => `<span class="locale" role="group" aria-label="Language"><span class="${L === "en" ? "on" : ""}">EN</span><span class="${L === "uk" ? "on" : ""}">UK</span></span>`;
  const authShell = (inner, phone) => phone
    ? `<div class="auth ph-auth"><div class="ph-top-loc">${localeSwitch()}</div><main class="auth-main">${inner}</main></div>`
    : `<div class="auth"><main class="auth-main">${inner}</main><div class="auth-foot">${localeSwitch()}</div></div>`;

  function desktop(st) {
    let body;
    if (st.page === "board" || st.page === "noaccess") return appDesktop(st);
    if (st.page === "team") body = teamPage(st, false);
    else if (st.page === "wspage") body = wsPage(false);
    else if (st.page === "hub") body = hubPage(false);
    else if (st.page === "noworkspace") return authShell(noWorkspaceCard(), false);
    else if (st.page === "signin") return authShell(foreignSignInCard(), false);
    return behind(body, overlay(st, false));
  }

  /* While a dialog or sheet is open, what is behind it takes no focus and no taps. */
  const behind = (body, over) => (over ? `<div inert style="display:contents;min-height:inherit">${body}</div>${over}` : body);

  function overlay(st, phone) {
    if (st.overlay === "create") return instVariant ? createInstDialog(phone) : createStep1(phone);
    if (st.overlay === "step2") return createStep2(phone);
    if (st.overlay === "invite") return inviteDialog(phone);
    if (st.overlay === "moveproj") return moveDialog(phone);
    return "";
  }

  // ── Phone ─────────────────────────────────────────────────────────────
  /* The board header names the workspace above the project, so the first screen says where you are. */
  function phoneBar(title, opts = {}) {
    const ws = opts.ws ? `<span class="ws">${opts.ws === "all" ? I("folders", "s12") : dot(WS[opts.ws].color, "sm")}<span>${opts.ws === "all" ? t("ws.all") : wsName(opts.ws)}</span></span>` : "";
    return `<header class="ph-bar">${opts.back ? `<button class="ph-ico" data-act="back" aria-label="${L === "uk" ? "Назад" : "Back"}">${I("chevL", "s20")}</button>` : ""}
      ${title ? `<button class="ph-title" data-act="sheet" aria-haspopup="dialog"><span class="tt">${ws}<span class="nm">${title}</span></span>${I("chevD", "s16")}</button>` : '<span style="flex:1"></span>'}
      ${opts.needs ? `<span class="pill-warn" style="height:28px;margin:0 6px">${I("alert", "s12")}${opts.needs}</span>` : ""}
      <button class="ph-ico" aria-label="${L === "uk" ? "Знайти ваші повідомлення" : "Find your messages"}">${I("search", "s20")}</button>
      <button class="ph-ico" aria-label="${L === "uk" ? "Більше дій" : "More actions"}">${I("more", "s20")}</button></header>`;
  }

  function phoneBoard(project) {
    const data = TASKS[project] ?? TASKS["shop-backend"];
    let html = "";
    for (const c of ["blocked", "assigned", "inbox"]) {
      if (!data[c].length) continue;
      html += `<div class="ph-sec">${t(`col.${c}`)} <span class="c">${data[c].length}</span></div>${data[c].map(card).join("")}`;
    }
    return `<div class="ph-body">${html}</div>`;
  }

  function sheetRow(icon, label, trailing = "", attrs = "", cls = "") {
    return `<button class="srw ${cls}" ${attrs}><span class="ic">${icon}</span><span class="nm">${label}</span>${trailing ? `<span class="tr">${trailing}</span>` : ""}</button>`;
  }

  function projectSheetRow(id, selected, move = false, pressed = false) {
    const p = PROJ[id];
    const tr = (p.live ? `<span class="live-m">${nWorking(p.live)}</span>` : `<span>${t("ph.quiet", { age: age(p.age) })}</span>`)
      + (p.needs ? `<span class="needs">${I("alert", "s12")}${p.needs}</span>` : "")
      + (move ? `<span class="btn sec sm ${pressed ? "on" : ""}" style="height:32px;padding:0 10px">${I("move", "s12")}${t("ph.move")}</span>` : "")
      + (selected ? `<span style="color:var(--accent)">${I("check", "s18")}</span>` : "");
    return sheetRow(I("folder", "s18"), id, tr, `data-act="project" data-id="${id}"`, selected ? "sel" : "");
  }

  function projectSheet(st) {
    const parts = [];
    const cur = st.ws;
    const canSwitch = st.who === "roman" || instVariant;
    const wsLabel = cur === "all" ? t("ws.all") : wsName(cur);
    const wsIcon = cur === "all" ? I("folders", "s18") : `<span class="dot" style="background:${COLORS[WS[cur].color]};width:12px;height:12px"></span>`;
    const expanded = st.overlay === "switch";
    parts.push(sheetRow(wsIcon, `${wsLabel}<span class="sub">${t("ph.wsRow")}</span>`, canSwitch ? I(expanded ? "chevD" : "chevR", "s16") : "", `data-act="switch" aria-expanded="${expanded}"`, "ws"));
    if (expanded) {
      const sub = [];
      if (instVariant) {
        for (const id of Object.keys(WS)) {
          const here = id === cur;
          const tr = here ? `<span style="color:var(--accent)">${I("check", "s18")}</span>` : `<span>${id === "research" ? t("inst.signIn") : t("inst.signedIn")}</span>${I("ext", "s16")}`;
          sub.push(sheetRow(`<span class="dot" style="background:${COLORS[WS[id].color]};width:12px;height:12px"></span>`, wsName(id), tr, `data-act="ws" data-id="${id}"`));
        }
        sub.push(sheetRow(I("folders", "s18"), t("inst.overview"), I("ext", "s16"), 'data-act="hub"'));
      } else {
        sub.push(sheetRow(I("folders", "s18"), t("ws.all"), `<span>${nProjects(10)}</span>${cur === "all" ? `<span style="color:var(--accent)">${I("check", "s18")}</span>` : ""}`, 'data-act="ws" data-id="all"'));
        for (const id of Object.keys(WS)) {
          sub.push(sheetRow(`<span class="dot" style="background:${COLORS[WS[id].color]};width:12px;height:12px"></span>`, wsName(id), `<span>${nProjects(WS[id].projects.length)}</span>${id === cur ? `<span style="color:var(--accent)">${I("check", "s18")}</span>` : ""}`, `data-act="ws" data-id="${id}"`));
        }
        if (V === 2) sub.push(sheetRow(I("sliders", "s18"), t("ws.settings"), "", 'data-act="wspage"'));
        sub.push(sheetRow(I("plus", "s18"), t("ws.new"), "", 'data-act="create"'));
      }
      parts.push(`<div class="indent">${sub.join("")}</div>`);
    }
    parts.push('<div class="divider"></div>');
    parts.push(sheetRow(I("layers", "s18"), t("ph.overview"), `<span>${nProjects(cur === "all" ? 10 : WS[cur].projects.length)}</span>`));
    if (cur === "all") {
      for (const id of Object.keys(WS)) {
        parts.push(`<div class="ph-sec" style="padding:6px 16px 0">${dot(WS[id].color, "sm")}${wsName(id)} <span class="c">${WS[id].projects.length}</span></div>`);
        parts.push(WS[id].projects.map((p) => projectSheetRow(p, false)).join(""));
      }
      parts.push(`<div class="ph-sec" style="padding:6px 16px 0">${t("ws.unassigned")} <span class="c">${UNASSIGNED.length}</span></div>`);
      parts.push(UNASSIGNED.map((p) => projectSheetRow(p, false, true)).join(""));
    } else if (!expanded) {
      for (const p of WS[cur].projects) {
        parts.push(projectSheetRow(p, p === st.project, st.moveFrom && p === st.project, st.moveOpen));
        if (st.moveOpen && p === st.project) {
          const to = Object.keys(WS).filter((id) => id !== cur).map((id) => sheetRow(`<span class="dot" style="background:${COLORS[WS[id].color]};width:12px;height:12px"></span>`, wsName(id), I("chevR", "s16"), `data-act="moveproj"`, id === "research" ? "hl" : "")).join("");
          parts.push(`<div class="indent"><div class="ph-sec" style="padding:4px 16px 0">${t("ws.moveTo")}</div>${to}</div>`);
        }
      }
    }
    return `<div class="sheet-scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${t("ph.projects")}"><div class="grab"><span></span></div>
      <div class="sheet-h"><h2>${t("ph.projects")}</h2><button class="ph-ico" data-act="close" aria-label="${t("close")}">${I("x", "s20")}</button></div>
      <div class="sheet-b">${parts.join("")}</div></div></div>`;
  }

  function phone(st) {
    if (st.page === "board") {
      const p = PROJ[st.project];
      const board = phoneBar(st.project, { needs: p.needs, ws: st.ws }) + phoneBoard(st.project);
      if (st.overlay === "moveproj") return `<div class="ph">${behind(behind(board, projectSheet(st)), moveDialog(true))}</div>`;
      return `<div class="ph">${behind(board, st.sheet ? projectSheet(st) : "")}</div>`;
    }
    if (st.page === "noaccess") {
      /* The header still names the workspace he is in; the project the link pointed at stays hidden. */
      return `<div class="ph">${phoneBar(`${I("lock", "s12")} ${t("ph.hidden")}`, { back: true, ws: "client" })}<div class="auth-main">${noAccessCard(true)}</div></div>`;
    }
    if (st.page === "noworkspace") return authShell(noWorkspaceCard(), true);
    if (st.page === "signin") return authShell(foreignSignInCard(), true);
    let body = "";
    if (st.page === "team") body = teamPage(st, true);
    else if (st.page === "wspage") body = wsPage(true);
    else if (st.page === "hub") body = hubPage(true);
    return `<div class="ph">${behind(body, overlay(st, true))}</div>`;
  }

  // ── States per variant (numbered as on the frames) ─────────────────────
  const C = (en, uk) => ({ en, uk });
  const base = { who: "roman", ws: "client", project: "shop-backend", page: "board", overlay: null, sheet: false, tab: "members" };
  const S = (o) => ({ ...base, ...o });
  const where = S({ cap: C("Where the current workspace is shown", "Де видно поточний простір"),
    note: C("Owner, in Client work. Desktop: the rail header names the workspace and the rail lists only its projects. Phone: the board header names the workspace above the project.",
      "Власник у просторі «Клієнти». Комп’ютер: заголовок бічної панелі називає простір, а панель показує лише його проєкти. Телефон: заголовок дошки називає простір над назвою проєкту.") });
  const sw = S({ sheet: true, overlay: "switch", cap: C("Switching workspaces", "Перемикання просторів"),
    note: C("The switcher is the account switch's chip; on the phone it is the first row of the project sheet. The owner also sees All workspaces; a member with one workspace sees no switcher.",
      "Перемикач — це чип, як у перемикачі акаунтів; на телефоні це перший рядок аркуша проєктів. Власник бачить ще й «Усі простори»; учасник з одним простором перемикача не бачить.") });
  const all = S({ ws: "all", project: "scratch-notes", sheet: true, overlay: "move", cap: C("The owner's All view, with Unassigned", "Огляд «Усі простори» у власника, з проєктами без простору"),
    note: C("Every project grouped by workspace. A newly found project lands in Unassigned, visible to the owner only, with Move on its row.",
      "Усі проєкти згруповано за просторами. Новий знайдений проєкт потрапляє в «Без простору»; його бачить лише власник, а в рядку є «Перенести».") });
  const create1 = S({ page: "team", tab: "workspaces", overlay: "create", cap: C("Creating a workspace", "Створення простору"),
    note: C("Team → Workspaces → New workspace. Name, colour, projects from Unassigned or another workspace, and a manager. The dialog says that agents are not fenced.",
      "Команда → Простори → Новий простір. Назва, колір, проєкти без простору чи з іншого простору, керівник. Діалог каже, що агентів не обмежено.") });
  const create2 = S({ page: "team", tab: "workspaces", overlay: "step2", cap: C("Creating a workspace: its defaults", "Створення простору: налаштування за замовчуванням"),
    note: C("Step 2 of 2: allowed accounts, report chat and worker share, and what the agent fence does and does not stop. Step 1 is variant 1's dialog.",
      "Крок 2 з 2: дозволені акаунти, чат для звітів, частка воркерів і що огорожа для агентів зупиняє, а що ні. Крок 1 — діалог варіанта 1.") });
  const invite = S({ page: "team", tab: "members", overlay: "invite", cap: C("Inviting a member into a workspace", "Запрошення учасника в простір"),
    note: C("The existing invite dialog with two added fields: the workspace and the role in it.",
      "Наявний діалог запрошення з двома новими полями: простір і роль у ньому.") });
  const noaccess = S({ who: "taras", page: "noaccess", project: "relay-bridge", cap: C("A member without access", "Учасник без доступу"),
    note: C("Taras, a member of Client work, opens a link to a Delegatus core project. His rail header, and on the phone the board header, names his one workspace without a switcher.",
      "Тарас, учасник простору «Клієнти», відкриває посилання на проєкт простору «Ядро Delegatus». Заголовок його бічної панелі, а на телефоні заголовок дошки, називає його єдиний простір без перемикача.") });
  const nows = S({ who: "dana", page: "noworkspace", cap: C("A member in no workspace", "Учасник без простору"),
    note: C("Dana joined from a plain invite and has not been placed yet: Team page only.",
      "Дана приєдналася за звичайним запрошенням і ще не має простору: лише сторінка команди.") });
  const wsp = S({ page: "wspage", cap: C("The workspace page", "Сторінка простору"),
    note: C("Projects, people, allowed accounts, report chat, worker share, usage, and the agent fence with what it refused.",
      "Проєкти, учасники, дозволені акаунти, чат для звітів, частка воркерів, використання та огорожа для агентів із тим, що вона відхилила.") });
  const instWhere = S({ cap: C("Where the current workspace is shown", "Де видно поточний простір"),
    note: C("This Delegatus is the Client work installation; the rail header names it, and on the phone the board header. Every project here belongs to it.",
      "Цей Delegatus — інсталяція «Клієнти»; її називає заголовок бічної панелі, а на телефоні — заголовок дошки. Усі проєкти тут належать їй.") });
  const instSw = S({ sheet: true, overlay: "switch", cap: C("Switching workspaces", "Перемикання просторів"),
    note: C("The switcher lists the installations on this computer and whether you are signed in to each. Choosing another opens its own address in a new tab, with its own sign-in.",
      "Перемикач показує інсталяції на цьому комп’ютері й чи ви в кожну ввійшли. Вибір іншої відкриває її власну адресу в новій вкладці, з окремим входом.") });
  const hub = S({ ws: "core", page: "hub", cap: C("The owner's overview of all workspaces", "Огляд усіх просторів у власника"),
    note: V === 4
      ? C("On the owner's main installation: one row per linked installation, from the existing Linked installs pairing, with its computer user and CLI logins. A user with no login is named with the lines that fix it.",
        "На головній інсталяції власника: рядок на кожну пов’язану інсталяцію, через наявне з’єднання «Пов’язані інсталяції», з її користувачем комп’ютера та входами в CLI. Користувача без входу названо разом із рядками, що це виправляють.")
      : C("On the owner's main installation: one row per linked installation, from the existing Linked installs pairing.",
        "На головній інсталяції власника: рядок на кожну пов’язану інсталяцію, через наявне з’єднання «Пов’язані інсталяції».") });
  const instCreate = S({ ws: "core", page: "hub", overlay: "create", cap: C("Creating a workspace", "Створення простору"),
    note: V === 4
      ? C("Nothing is created in the browser: the dialog prints the lines that create a computer user and start Delegatus as that user.", "У браузері нічого не створюється: діалог показує рядки, що створюють користувача комп’ютера й запускають Delegatus від його імені.")
      : C("Nothing is created in the browser: the dialog prints the command that starts a new installation with its own state folder and port.", "У браузері нічого не створюється: діалог показує команду, що запускає нову інсталяцію з власною текою стану й портом.") });
  const instInvite = S({ page: "team", tab: "members", overlay: "invite", cap: C("Inviting a member into a workspace", "Запрошення учасника в простір"),
    note: C("The Team page of the Client work installation, unchanged: its invite joins this installation only.",
      "Сторінка команди інсталяції «Клієнти» без змін: запрошення додає лише до цієї інсталяції.") });
  const instNoaccess = S({ who: "taras", page: "signin", cap: C("A member without access", "Учасник без доступу"),
    note: C("Taras opens a Delegatus core link. That is another installation with its own team, so he meets its sign-in page, which names its team and who invites into it, and offers the way back to the linked installation he came from.",
      "Тарас відкриває посилання на «Ядро Delegatus». Це інша інсталяція з власною командою, тож він бачить її сторінку входу: вона називає команду й того, хто до неї запрошує, і пропонує повернутися до пов’язаної інсталяції, звідки він прийшов.") });
  const move = S({ project: "shop-app", moveFrom: true, overlay: "moveproj", phoneSub: "ph.moveDialog", phoneBefore: S({ project: "shop-app", moveFrom: true, moveOpen: true, sheet: true, phoneSub: "ph.moveChoose" }), cap: C("Moving a project to another workspace", "Перенесення проєкту в інший простір"),
    note: C("Opened from Move on the project's row, then Research. Each workspace is a different computer user, so a move is two steps: a fresh clone, then Move tasks and history, which exports and imports them. That export and import tool does not exist yet; this variant would add it.",
      "Відкривається кнопкою «Перенести» в рядку проєкту, далі «Дослідження». Кожен простір — інший користувач комп’ютера, тож перенесення має два кроки: нове клонування, а потім «Перенести завдання й історію», що їх експортує та імпортує. Такого інструменту експорту й імпорту ще немає; цей варіант його додасть.") });

  const STATES = {
    1: [where, sw, all, create1, invite, noaccess, nows],
    2: [where, sw, create2, wsp, invite, noaccess, nows],
    3: [instWhere, instSw, hub, instCreate, instInvite, instNoaccess],
    4: [instWhere, instSw, hub, instCreate, move, instInvite, instNoaccess],
  }[V];

  const NAMES = {
    1: C("Workspace as a rail filter · level 1: views and permissions", "Простір як фільтр бічної панелі · рівень 1: перегляд і права"),
    2: C("Workspace with its own settings and an agent fence · level 2 (recommended)", "Простір із власними налаштуваннями й огорожею для агентів · рівень 2 (рекомендовано)"),
    3: C("One Delegatus per workspace, same computer user · level 3", "Окремий Delegatus для кожного простору, той самий користувач комп’ютера · рівень 3"),
    4: C("One computer user per workspace · level 4", "Окремий користувач комп’ютера для кожного простору · рівень 4"),
  };
  const LEADS = {
    1: C("People see and act only inside the workspaces they were added to. Agents are not fenced: an agent still reaches every project through Delegatus tools and its shell.",
      "Люди бачать і діють лише в просторах, куди їх додали. Агентів не обмежено: агент і далі досягає будь-якого проєкту через інструменти Delegatus і свою оболонку."),
    2: C("Variant 1, plus: agents started in a workspace reach only its projects through Delegatus tools, and each workspace has its allowed accounts, report chat and worker share. Agents still run as this computer's user.",
      "Варіант 1, а також: агенти, запущені в просторі, через інструменти Delegatus досягають лише його проєктів, а кожен простір має свої дозволені акаунти, чат для звітів і частку воркерів. Агенти й далі працюють від користувача цього комп’ютера."),
    3: C("Each workspace is its own installation with its own address, state, team, accounts and bot; the owner links them for one overview. Agents of every workspace still share one computer user's files.",
      "Кожен простір — окрема інсталяція з власною адресою, станом, командою, акаунтами й ботом; власник пов’язує їх для спільного огляду. Агенти всіх просторів і далі мають доступ до файлів одного користувача комп’ютера."),
    4: C("Variant 3, with each installation under its own computer user: its own home folder, checkouts and CLI logins. The only variant in which an agent cannot read another workspace's files. Setting one up needs sudo, run by hand.",
      "Варіант 3, де кожна інсталяція працює від власного користувача комп’ютера: своя домашня тека, робочі копії та входи в CLI. Лише тут агент не може прочитати файли іншого простору. Налаштування потребує sudo, яке ви запускаєте вручну."),
  };

  // ── Rendering ─────────────────────────────────────────────────────────
  /* A popover with data-anchor opens level with the control that opened it. */
  const anchor = (root) => {
    for (const pop of root.querySelectorAll(".pop[data-anchor]")) {
      const host = pop.closest(".screen") ?? root;
      const at = host.querySelector(pop.dataset.anchor);
      if (!at) continue;
      const hb = host.getBoundingClientRect(), ab = at.getBoundingClientRect();
      pop.style.top = `${Math.round(ab.top - hb.top - 6)}px`;
    }
  };
  const isPhone = () => window.innerWidth < 640;
  const render = (st) => (isPhone() ? phone(st) : desktop(st));
  const fixedPage = (st) => st.page === "board" || st.page === "noaccess";

  if (STORY) {
    const phoneMode = isPhone();
    const vw = window.innerWidth;
    const vh = phoneMode ? 844 : 900;
    document.body.className = `story vw-${vw}`;
    const head = `<div class="story-head"><h1>${t("variant", { n: V })} · ${tx(NAMES[V])}</h1><p>${tx(LEADS[V])}</p></div>`;
    const screen = (st, n) => {
      const fixed = phoneMode ? st.page === "board" || st.page === "noaccess" : fixedPage(st);
      const size = fixed ? `height:${vh}px` : `min-height:${vh}px`;
      return `<div class="screen" data-state="${n}" style="width:${vw}px;${size}">${render(st)}</div>`;
    };
    /* A phone sheet covers the sheet that opened it, so the phone draws that step first as its own screen, each with its own caption. */
    const subCap = (n, key) => `<div class="cap"><span class="n">${n}</span><b>${t(key)}</b></div>`;
    const frames = STATES.map((st, i) => {
      const n = i + 1, split = phoneMode && st.phoneBefore;
      return `<div class="cap"><span class="n">${n}</span><b>${tx(st.cap)}</b> <span>${tx(st.note)}</span></div>
        ${split ? `${subCap(`${n}a`, st.phoneBefore.phoneSub)}${screen(st.phoneBefore, `${n}a`)}${subCap(`${n}b`, st.phoneSub)}` : ""}${screen(st, split ? `${n}b` : n)}`;
    }).join("");
    document.body.innerHTML = head + frames;
    anchor(document);
    return;
  }

  // Clickable prototype.
  let idx = Math.max(0, Math.min(STATES.length - 1, Number(location.hash.replace("#s", "")) - 1 || 0));
  let cur = { ...STATES[idx] };
  document.body.className = "live";
  const draw = () => {
    const fixed = fixedPage(cur);
    const bar = `<nav aria-label="${t("stateBar")}" style="position:fixed;right:12px;bottom:12px;z-index:99;display:flex;gap:4px;align-items:center;background:var(--raised);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-2);padding:6px;font-size:11px">
      <span class="muted" style="padding:0 4px">${t("stateBar")}</span>${STATES.map((s, i) => `<button class="btn sm ${i === idx ? "pri" : "sec"}" style="height:28px;padding:0 9px" data-act="state" data-id="${i}" title="${tx(s.cap)}">${i + 1}</button>`).join("")}</nav>`;
    document.body.innerHTML = `<div class="screen ${fixed ? "fixed" : ""}">${render(cur)}</div>${bar}`;
    anchor(document);
  };
  document.addEventListener("click", (event) => {
    /* A tap on the scrim closes the dialog or sheet above it, as TeamDialog and MobileSheet do. */
    if (event.target.classList?.contains("scrim") || event.target.classList?.contains("sheet-scrim")) {
      cur = { ...cur, overlay: null, sheet: false };
      draw();
      return;
    }
    const el = event.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    const reset = () => ({ ...base, who: cur.who, ws: cur.ws, project: cur.project });
    switch (act) {
      case "state": idx = Number(id); cur = { ...STATES[idx] }; location.hash = `s${idx + 1}`; break;
      case "switch": if (cur.who === "roman" || instVariant) cur = { ...cur, overlay: cur.overlay === "switch" ? null : "switch" }; break;
      case "ws": cur = { ...reset(), ws: id, project: id === "all" ? "scratch-notes" : WS[id].projects[0], sheet: cur.sheet }; break;
      case "project": cur = { ...cur, project: id, overlay: null, sheet: false }; break;
      case "sheet": cur = { ...cur, sheet: true, overlay: null }; break;
      case "move": cur = { ...cur, overlay: cur.overlay === "move" ? null : "move" }; break;
      case "create": cur = instVariant ? { ...cur, page: cur.page === "board" ? "hub" : cur.page, ws: "core", overlay: "create", sheet: false } : { ...cur, page: "team", tab: "workspaces", overlay: "create", sheet: false }; break;
      case "step2": cur = { ...cur, overlay: "step2" }; break;
      case "moveproj": cur = { ...cur, overlay: "moveproj", moveFrom: true, sheet: isPhone() }; break;
      case "manage": cur = { ...cur, page: "team", tab: "workspaces", overlay: null, sheet: false }; break;
      case "wspage": cur = { ...cur, page: "wspage", overlay: null, sheet: false }; break;
      case "hub": cur = { ...cur, ws: "core", page: "hub", overlay: null, sheet: false }; break;
      case "invite": cur = { ...cur, overlay: "invite" }; break;
      case "tab": cur = { ...cur, tab: id }; break;
      case "back": cur = { ...reset(), ws: cur.who === "taras" ? "client" : cur.ws === "all" ? "client" : cur.ws, project: cur.who === "taras" || !cur.project ? "shop-backend" : cur.project }; if (!WS[cur.ws]?.projects.includes(cur.project)) cur.project = WS[cur.ws].projects[0]; break;
      case "close": cur = { ...cur, overlay: null, sheet: cur.overlay ? cur.sheet : false }; break;
      default: return;
    }
    if (cur.project && !PROJ[cur.project]) cur.project = "shop-backend";
    draw();
  });
  window.addEventListener("resize", draw);
  draw();
})();
