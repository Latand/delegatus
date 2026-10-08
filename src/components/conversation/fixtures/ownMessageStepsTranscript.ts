/*
 * The conversation the own-message step row is measured over
 * (docs/design/own-message-steps.md). All text is invented.
 */

const TEXT = {
  en: {
    own: [
      "Start the day: what on the board is waiting for me, and where exactly?",
      "Show me the list of cards that have not moved for over a week, then close them.",
      "What is going on with the release? Why is the main branch red for the second day?",
      "Put a separate analyst on the slow opening of long conversations. I want the cause, with evidence.",
      "I did not follow the part about collecting documentation. Why is it being removed from the checks? Is it needed or not?",
      "Cards on the phone jump when I drag them between columns. Make a task and a pipeline.",
      "Why are so few agents working? The limits are free.",
      "Show me what is left of the reviewer's findings on the search lane.",
      "Fine. Merge the search lane when the browser check passes, and tell me when it is deployed.",
    ],
    replies: [
      "Two cards are waiting for you, the rest move without you.",
      "Found eleven cards with no movement for over a week; the list is below, nothing is closed yet.",
      "The main branch is red because of one check: the privacy test outlives its time budget.",
      "Started an analyst on a separate lane with one requirement: measure the time to the first row on the phone and on the desktop.",
      "Collecting documentation stays; only its repeat in the check before the merge is removed.",
      "Created the card for the jumping phone cards and bound a pipeline to it.",
      "Three lanes are running out of three allowed; the limits are free, the ceiling on parallel lanes is what holds it.",
      "Two findings are left on the search lane, both second priority.",
      "Agreed: the search lane merges as soon as the browser check passes, and I will write here once it is deployed.",
    ],
    detail: [
      "What changed since last time: one lane moved from waiting into work, one card went back for rework after the review, and a third is waiting for the browser check. None of them needs your decision right now.",
      "Next I do this myself and come back with the result: rerun the check on a fresh branch, read the frames at 390 px and only then merge. If the check fails again I open a separate lane for the cause and write here in one message.",
      "I checked this against the board and the lane's journal; nothing here is from memory. The lane's last record is twelve minutes old, the review stage ended with no first-priority findings, and the next step is already assigned.",
      "One answer is needed from you, and it does not block the rest: whether to keep the ceiling at three parallel lanes. My recommendation is to keep it until the end of the day, because two lanes touch the same files and a fourth would add conflicts.",
    ],
    wake: [
      "Orchestrator seat wake. Reason: scheduled board check, fifteen minutes since the last one.",
      "Orchestrator seat wake. Reason: the lane for fast opening of long conversations has not written to its journal for twenty minutes.",
      "Orchestrator seat wake. Reason: a stage finished and its verdict is waiting to be read.",
    ],
    wakeReply: [
      "Checked the board: three lanes in work, no new blocks. Changed nothing.",
      "The lane is alive, the agent is waiting on a long type check. Left it as is and will look again on the next wake.",
      "Read the verdict, moved the card on and started the next stage.",
    ],
    notice: [
      "Agent finished: review of the search lane. Verdict: no findings. The turn ended after 6 min 12 s.",
      "Agent finished: builder of the report log lane. Verdict: pass, two notes. The turn ended after 21 min 40 s.",
    ],
    noticeReply: "Took the agent's result, moved its conclusion into the card and started the fix stage with two findings.",
    pipeline: "Pipeline for the search lane: the fix stage returned the branch to review.",
    pipelineReply: "The search lane is back in review; nothing is needed from you.",
    harness: "<environment_context>\n  <cwd>/workspace/delegatus</cwd>\n  <shell>bash</shell>\n</environment_context>",
  },
  uk: {
    own: [
      "Почни день: що на дошці чекає на мене, а що їде саме?",
      "Покажи список старих карток, які висять без руху понад тиждень, потім закрий їх.",
      "Що зараз із релізом? Чому головна гілка червона другий день?",
      "Запусти окремого аналітика на повільне відкриття довгих розмов. Хочу причину з доказами.",
      "Не зрозумів про збирання документації. Чому воно прибирається з перевірок? Це треба чи ні?",
      "Картки на телефоні стрибають, коли я перетягую їх між колонками. Зроби задачу і пайплайн.",
      "Чому так мало агентів працює? Ліміти ж вільні.",
      "Покажи, що лишилося з зауважень рецензента по лінії з пошуком.",
      "Добре. Зливай лінію пошуку, коли пройде перевірка в браузері, і напиши, коли викотиш.",
    ],
    replies: [
      "На вас чекають дві картки, решта рухається без вашої участі.",
      "Знайшов одинадцять карток без руху понад тиждень; список нижче, нічого ще не закрито.",
      "Головна гілка червона через одну перевірку: тест приватності перевищує відведений час.",
      "Запустив аналітика окремою лінією з однією вимогою: виміряти час до першого рядка на телефоні й на десктопі.",
      "Збирання документації лишається, прибирається тільки його повтор у перевірці перед злиттям.",
      "Створив картку про стрибки карток на телефоні й прив'язав до неї пайплайн.",
      "Працюють три лінії з дозволених трьох; ліміти справді вільні, обмежує стеля одночасних ліній.",
      "По лінії пошуку лишилося два зауваження, обидва другого пріоритету.",
      "Домовилися: лінія пошуку зливається, щойно пройде перевірка в браузері, і я напишу сюди після викочування.",
    ],
    detail: [
      "Що змінилося від попереднього разу: одну лінію переведено з очікування в роботу, одна картка повернулася на доопрацювання після рецензії, а третя чекає на перевірку в браузері. Жодна з них не потребує вашого рішення просто зараз.",
      "Далі я роблю це сам і повернуся з результатом: перезапускаю перевірку на свіжій гілці, читаю знімки на 390 px і лише після цього зливаю. Якщо перевірка знову впаде, відкрию окрему лінію на причину й напишу сюди одним повідомленням.",
      "Перевірив це по стану дошки й по журналу лінії, з пам'яті нічого не брав. Останній запис лінії зроблено дванадцять хвилин тому, етап рецензії завершився без зауважень першого пріоритету, і наступний крок уже призначено.",
      "Від вас потрібна одна відповідь, і вона не блокує решту роботи: чи лишати стелю в три одночасні лінії. Моя рекомендація: лишити до кінця дня, бо дві лінії торкаються тих самих файлів і четверта додала б конфліктів.",
    ],
    wake: [
      "Пробудження місця оркестратора. Причина: планова перевірка дошки, з попередньої минуло п'ятнадцять хвилин.",
      "Пробудження місця оркестратора. Причина: лінія «Швидке відкриття довгих розмов» не писала в журнал двадцять хвилин.",
      "Пробудження місця оркестратора. Причина: етап завершився, його вердикт чекає на прочитання.",
    ],
    wakeReply: [
      "Перевірив дошку: три лінії в роботі, нових блокувань немає. Нічого не змінював.",
      "Лінія жива, агент чекає на довгу перевірку типів. Залишив як є й перевірю на наступному пробудженні.",
      "Прочитав вердикт, пересунув картку далі й запустив наступний етап.",
    ],
    notice: [
      "Агент завершив: рецензія лінії «Пошук по розмовах». Вердикт: без зауважень. Хід завершено, працював 6 хв 12 с.",
      "Агент завершив: виконавець лінії «Журнал звітів». Вердикт: пройдено, дві примітки. Хід завершено, працював 21 хв 40 с.",
    ],
    noticeReply: "Узяв результат агента, переніс висновок у картку й запустив етап виправлення з двома зауваженнями.",
    pipeline: "Пайплайн «Пошук по розмовах»: етап «виправлення» повернув гілку на рецензію.",
    pipelineReply: "Лінія пошуку знову на рецензії; від вас нічого не потрібно.",
    harness: "<environment_context>\n  <cwd>/workspace/delegatus</cwd>\n  <shell>bash</shell>\n</environment_context>",
  },
} as const;

/** How many machine-sent turns follow each own message, oldest first. */
const MACHINE_AFTER = [4, 5, 3, 4, 5, 4, 6, 4, 2] as const;
/** Own messages in the page that is not loaded when the conversation opens. */
export const OWN_STEPS_UNLOADED = 2;
export const OWN_STEPS_TOTAL = 9;

/**
 * A Codex transcript of an orchestrator's day: nine messages the operator
 * typed among thirty-seven machine-sent turns (seat wakes, finished-agent
 * notices, a pipeline message), each answered. Every record carries the
 * structured-user marker a real delivery writes, which is what the feed
 * parser reads the sender from. `loadedFrom` is the line where the loaded
 * window starts. `round` tells one copy of the day from the next, for a
 * conversation many days long. All text is invented.
 */
export function ownStepsTranscript(lang: "en" | "uk", total: number = OWN_STEPS_TOTAL, round = 0): { lines: string[]; loadedFrom: number } {
  const text = TEXT[lang];
  const lines: string[] = [];
  const day = round ? `_day${round}` : "";
  let clock = Date.parse("2026-09-28T06:00:00.000Z") + round * 86_400_000;
  const at = (minutes: number) => new Date(clock += minutes * 60_000).toISOString();
  const user = (marker: string, body: string, minutes: number) => lines.push(JSON.stringify({
    timestamp: at(minutes), type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker ? `${marker}\n${body}` : body }] },
  }));
  const agent = (body: string) => lines.push(JSON.stringify({ timestamp: at(1), type: "event_msg", payload: { type: "agent_message", message: body } }));
  const tool = (id: string) => {
    lines.push(JSON.stringify({ timestamp: at(0.2), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "git status --short"] }), call_id: id } }));
    lines.push(JSON.stringify({ timestamp: at(0.2), type: "response_item", payload: { type: "function_call_output", call_id: id, output: "clean" } }));
  };
  const machine = (role: string) => `<!-- llv:structured-user origin=agent sender=${role} -->`;
  let loadedFrom = 0;
  user("", text.harness, 0);
  for (let own = 0; own < Math.min(total, OWN_STEPS_TOTAL); own += 1) {
    if (own === OWN_STEPS_UNLOADED) loadedFrom = lines.length;
    user("<!-- llv:structured-user origin=operator -->", text.own[own]!, 7);
    tool(`call_own_${own}${day}`);
    agent([text.replies[own]!, text.detail[own % 4]!, text.detail[(own + 1) % 4]!, text.detail[(own + 2) % 4]!].join("\n\n"));
    for (let turn = 0; turn < MACHINE_AFTER[own]!; turn += 1) {
      const kind = (own + turn) % 5;
      if (kind === 3) {
        user(machine(turn % 2 ? "reviewer" : "builder"), text.notice[turn % 2]!, 11);
        agent(`${text.noticeReply}\n\n${text.detail[(own + turn) % 4]!}`);
      } else if (kind === 4) {
        user(machine("pipeline"), text.pipeline, 9);
        agent(text.pipelineReply);
      } else {
        user(machine("seat-tick"), text.wake[kind]!, 15);
        tool(`call_wake_${own}_${turn}${day}`);
        agent(kind === 1 ? `${text.wakeReply[kind]!}\n\n${text.detail[turn % 4]!}` : text.wakeReply[kind]!);
      }
    }
  }
  return { lines, loadedFrom };
}

/**
 * What arrives at the end of that conversation while it is being read, one
 * call's worth; `seq` keeps the calls apart. `work` is a long turn of the
 * agent's (a tool call, its output and a line about it, `count` times),
 * `replies` is `count` short answers and `turn` is one more message of the
 * operator's with its answer.
 */
export type OwnStepsArrival = "work" | "replies" | "turn" | "voice";
export function ownStepsArrival(lang: "en" | "uk", kind: OwnStepsArrival, count: number, seq: number): string[] {
  const text = TEXT[lang];
  const lines: string[] = [];
  let clock = Date.parse("2026-11-01T06:00:00.000Z") + seq * 3_600_000;
  const at = () => new Date(clock += 1_000).toISOString();
  const agent = (body: string) => lines.push(JSON.stringify({ timestamp: at(), type: "event_msg", payload: { type: "agent_message", message: body } }));
  if (kind === "turn" || kind === "voice") {
    lines.push(JSON.stringify({
      timestamp: at(), type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: kind === "voice" ? `<realtime_delegation><input>${text.own[seq % text.own.length]!}</input><transcript_delta>${text.own[seq % text.own.length]!}</transcript_delta></realtime_delegation>` : `<!-- llv:structured-user origin=operator -->\n${text.own[seq % text.own.length]!}` }] },
    }));
    agent(text.pipelineReply);
    return lines;
  }
  for (let index = 0; index < count; index += 1) {
    if (kind === "replies") { agent(`${text.wakeReply[index % 3]!} (${seq}.${index})`); continue; }
    const id = `call_arrival_${seq}_${index}`;
    lines.push(JSON.stringify({ timestamp: at(), type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", `git log -1 --format=%h -- file${index}`] }), call_id: id } }));
    lines.push(JSON.stringify({ timestamp: at(), type: "response_item", payload: { type: "function_call_output", call_id: id, output: "clean" } }));
    agent(`${text.wakeReply[index % 3]!} (${seq}.${index})`);
  }
  return lines;
}
