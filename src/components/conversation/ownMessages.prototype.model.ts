/*
 * Design prototype, not product code: the model behind the "jump between my
 * own messages" variants (docs/design/own-message-navigation.md). Nothing in
 * the product imports it; only the conversation evidence fixture mounts the
 * prototype (`?case=own-messages&variant=1|2|3|4`).
 *
 * A conversation is read as turns. A turn opens with one user-side record and
 * holds the assistant's reply to it. `sender` is what the proposed build reads
 * off the record's author: no agent author means the operator, an agent author
 * names the machine sender by its role.
 */

export type ProtoSender = "operator" | "seat-tick" | "agent" | "pipeline";

export interface ProtoTurn {
  id: string;
  sender: ProtoSender;
  /** HH:MM, as the feed prints it. */
  at: string;
  text: string;
  reply: string[];
  /** How many tool calls the reply made, for the muted line under it. */
  tools: number;
}

export interface MachineRun {
  kind: "machine";
  turns: ProtoTurn[];
  wakes: number;
  notices: number;
  from: string;
  to: string;
}

export type ModeRow = { kind: "own"; turn: ProtoTurn } | MachineRun;

export interface OutlineEntry {
  id: string;
  at: string;
  message: string;
  reply: string;
  loaded: boolean;
}

export function isOwn(turn: ProtoTurn): boolean {
  return turn.sender === "operator";
}

export function ownTurns(turns: readonly ProtoTurn[]): ProtoTurn[] {
  return turns.filter(isOwn);
}

/** The own message a step lands on, or null at the edge of what is loaded. */
export function stepOwn(turns: readonly ProtoTurn[], activeId: string | null, direction: -1 | 1): ProtoTurn | null {
  const own = ownTurns(turns);
  if (own.length === 0) return null;
  const at = activeId ? own.findIndex((turn) => turn.id === activeId) : -1;
  if (at === -1) return direction === -1 ? own.at(-1)! : null;
  return own[at + direction] ?? null;
}

/** "3 / 7", with a plus while older history is not loaded: the total is then
    a floor, and the position counts from the oldest loaded message. */
export function ownCounter(turns: readonly ProtoTurn[], activeId: string | null, olderUnloaded: boolean): string {
  const own = ownTurns(turns);
  const at = activeId ? own.findIndex((turn) => turn.id === activeId) : -1;
  return `${at === -1 ? "–" : at + 1} / ${own.length}${olderUnloaded ? "+" : ""}`;
}

/** The "my messages" mode: own turns in full, each unbroken stretch of
    machine-sent turns folded into one row. */
export function modeRows(turns: readonly ProtoTurn[]): ModeRow[] {
  const rows: ModeRow[] = [];
  for (const turn of turns) {
    if (isOwn(turn)) {
      rows.push({ kind: "own", turn });
      continue;
    }
    const last = rows.at(-1);
    const run: MachineRun = last?.kind === "machine" ? last : { kind: "machine", turns: [], wakes: 0, notices: 0, from: turn.at, to: turn.at };
    if (run !== last) rows.push(run);
    run.turns.push(turn);
    run.to = turn.at;
    if (turn.sender === "seat-tick") run.wakes += 1;
    else run.notices += 1;
  }
  return rows;
}

export function firstLine(text: string, limit: number): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** The table of contents. It lists every own message of the conversation,
    loaded or not: the build reads it from the records' authors, which does
    not need the feed's window. */
export function outline(all: readonly ProtoTurn[], loadedFrom: number): OutlineEntry[] {
  return all.flatMap((turn, index) => isOwn(turn)
    ? [{ id: turn.id, at: turn.at, message: firstLine(turn.text, 96), reply: firstLine(turn.reply[0] ?? "", 110), loaded: index >= loadedFrom }]
    : []);
}

/* ---- the fixture conversation -------------------------------------------- */

const OWN: Array<{ text: string; lead: string }> = [
  { text: "Почни день: що на дошці чекає на мене, а що їде саме?", lead: "На вас чекають дві картки, решта рухається без вашої участі." },
  { text: "Закрий старі картки, які висять без руху понад тиждень, але спершу покажи список.", lead: "Знайшов одинадцять карток без руху понад сім днів; список нижче, нічого ще не закрито." },
  { text: "Що зараз із релізом? Чому головна гілка червона другий день?", lead: "Головна гілка червона через одну перевірку: тест приватності перевищує відведений час." },
  { text: "Запусти окремого аналітика на повільне відкриття довгих розмов. Хочу причину, а не здогадки.\nІ хай одразу поміряє на телефоні.", lead: "Запустив аналітика окремою лінією, з вимогою виміряти час до першого рядка на телефоні й на десктопі." },
  { text: "Не зрозумів про збирання документації. Чому воно прибирається з перевірок? Це треба чи ні?", lead: "Збирання документації лишається, прибирається тільки його повтор у перевірці перед злиттям." },
  { text: "Картки на телефоні стрибають, коли я перетягую їх між колонками. Зроби задачу і пайплайн.", lead: "Створив картку «Картки на телефоні стрибають під час перетягування» і прив'язав до неї пайплайн." },
  { text: "Чому так мало агентів працює? Ліміти ж вільні.", lead: "Працюють три лінії з дозволених трьох; ліміти справді вільні, обмежує стеля одночасних ліній." },
  { text: "Покажи, що лишилося з зауважень рецензента по лінії з пошуком.", lead: "По лінії пошуку лишилося два зауваження, обидва другого пріоритету." },
  { text: "Зроби реліз, якщо головна зелена.", lead: "Головна зелена, реліз зібрано й опубліковано." },
];

const OWN_BODY = [
  "Перевірив це по стану дошки й по журналу лінії, а не з пам'яті. Останній запис лінії зроблено дванадцять хвилин тому, етап рецензії завершився вердиктом без зауважень першого пріоритету, і наступний крок уже призначено.",
  "Що саме змінилося від попереднього разу: одну лінію переведено з очікування в роботу, одна картка повернулася на доопрацювання після рецензії, а третя чекає на перевірку в браузері. Жодна з них не потребує вашого рішення просто зараз.",
  "Далі я роблю це сам і повернуся з результатом: перезапускаю перевірку на свіжій гілці, читаю знімки на 390 px і лише після цього зливаю. Якщо перевірка знову впаде, відкрию окрему лінію на причину й напишу сюди одним повідомленням.",
  "Від вас потрібна одна відповідь, і вона не блокує решту роботи: чи лишати стелю в три одночасні лінії. Моя рекомендація — лишити до кінця дня, бо дві лінії торкаються тих самих файлів і четверта додала б конфліктів.",
];

const WAKES = [
  "Пробудження місця оркестратора. Причина: етап «рецензія» лінії «Пошук по розмовах» завершився, наступний етап не призначено.",
  "Пробудження місця оркестратора. Причина: планова перевірка дошки, з попередньої минуло п'ятнадцять хвилин.",
  "Пробудження місця оркестратора. Причина: лінія «Швидке відкриття довгих розмов» не писала в журнал двадцять хвилин.",
  "Пробудження місця оркестратора. Причина: перевірки на головній гілці змінили стан.",
];
const NOTICES = [
  "Агент завершив: Рецензія лінії «Пошук по розмовах». Вердикт: без зауважень. Хід завершено, працював 6 хв 12 с.",
  "Агент завершив: Аналіз повільного відкриття довгих розмов. Хід завершено, працював 18 хв 40 с.",
  "Агент завершив: Перевірка в браузері лінії «Картки на телефоні». Вердикт: потрібні зміни. Хід завершено, працював 4 хв 03 с.",
];
const PIPELINE = [
  "Пайплайн «Картки на телефоні стрибають під час перетягування»: етап «збирання» завершено, запущено «рецензію».",
  "Пайплайн «Пошук по розмовах»: етап «виправлення» повернув гілку на рецензію.",
];
const MACHINE_REPLY = [
  "Прочитав стан лінії. Етап завершився чисто, призначив наступний і оновив картку. Рішень від оператора не потрібно.",
  "Перевірив дошку: три лінії в роботі, нових блокувань немає. Нічого не змінював.",
  "Лінія жива, агент чекає на довгу перевірку типів. Залишив як є й перевірю на наступному пробудженні.",
  "Узяв результат агента, переніс висновок у картку й запустив етап виправлення з двома зауваженнями.",
];

/** Which turn indexes are the operator's, among 49 turns: nine own messages
    and forty machine-sent ones. The first ten turns are "older history". */
const OWN_AT = [0, 6, 10, 17, 22, 30, 36, 43, 48];
export const PROTO_TURNS = 49;
export const PROTO_OLDER = 10;

function clock(index: number): string {
  const minutes = 8 * 60 + 40 + index * 12;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function protoConversation(): ProtoTurn[] {
  const turns: ProtoTurn[] = [];
  let machine = 0;
  for (let index = 0; index < PROTO_TURNS; index++) {
    const own = OWN_AT.indexOf(index);
    if (own !== -1) {
      const message = OWN[own]!;
      turns.push({ id: `turn-${index}`, sender: "operator", at: clock(index), text: message.text,
        reply: [message.lead, ...[0, 1, 2].map((offset) => OWN_BODY[(own + offset) % OWN_BODY.length]!)], tools: 9 + own * 2 });
      continue;
    }
    /* Out of every ten machine turns: seven wakes, two agent notices, one
       pipeline message. */
    const slot = machine % 10;
    const sender: ProtoSender = slot === 3 || slot === 7 ? "agent" : slot === 9 ? "pipeline" : "seat-tick";
    const pool = sender === "agent" ? NOTICES : sender === "pipeline" ? PIPELINE : WAKES;
    turns.push({ id: `turn-${index}`, sender, at: clock(index), text: pool[machine % pool.length]!,
      reply: [MACHINE_REPLY[machine % MACHINE_REPLY.length]!, ...(machine % 3 === 0 ? [OWN_BODY[machine % OWN_BODY.length]!] : [])], tools: 3 + (machine % 5) });
    machine += 1;
  }
  return turns;
}
