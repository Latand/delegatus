/*
 * Prototype harness for docs/design/prototype-reject-and-critic-gate.md, Part A.
 *
 * Patches an export of the repository (never the worktree) so the real
 * prototype review draws one of three «Reject and redo» variants, chosen in
 * the page by `globalThis.__rejectVariant` (0 draws today's review). Every
 * patch starts from a saved pristine copy, so a rerun never applies twice.
 *
 *   bun docs/design/prototype-reject-prototype/patch.ts <export root>
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
if (!fs.existsSync(path.join(root, "package.json"))) throw new Error(`not an export: ${root}`);

type Swap = [from: string, to: string];
function patch(relative: string, swaps: Swap[]): void {
  const file = path.join(root, relative);
  const pristine = `${file}.pristine`;
  if (!fs.existsSync(pristine)) fs.copyFileSync(file, pristine);
  let text = fs.readFileSync(pristine, "utf8");
  for (const [from, to] of swaps) {
    const at = text.indexOf(from);
    if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`${relative}: expected exactly one match of ${JSON.stringify(from.slice(0, 80))}`);
    text = text.slice(0, at) + to + text.slice(at + from.length);
  }
  fs.writeFileSync(file, text);
}

/* The decision and the request learn the rejected kind. */
patch("src/lib/prototypeReview/types.ts", [
  ["  skipped?: true;\n  chosen: number[];", "  skipped?: true;\n  /** The operator took no variant and asked for a new round from the comment. */\n  rejected?: true;\n  chosen: number[];"],
  ["answers?: PrototypeAnswer[]; skip?: true }", "answers?: PrototypeAnswer[]; skip?: true; reject?: true }"],
]);

/* The fixture's decision route records a rejection as the Viewer would. */
patch("src/components/kanban/issue1695Evidence.fixture.tsx", [
  ["answers?: PrototypeAnswer[]; skip?: true };", "answers?: PrototypeAnswer[]; skip?: true; reject?: true };"],
  ["chosen: [...(body.chosen ?? [])].sort((a, b) => a - b), comment: body.comment ?? \"\",", "...(body.reject ? { rejected: true as const } : {}), chosen: [...(body.chosen ?? [])].sort((a, b) => a - b), comment: body.comment ?? \"\","],
  /* The reviewed task reads in the frame's language, as its round already does. */
  ["task(\"t-search\", \"assigned\", \"Restore search results after the index rebuild\", \"Results vanish for ten minutes after a rebuild. Keep the old index live until the new one answers.\",",
    "task(\"t-search\", \"assigned\", UK ? \"Повернути результати пошуку після перебудови індексу\" : \"Restore search results after the index rebuild\", UK ? \"Результати зникають на десять хвилин після перебудови. Тримати старий індекс, доки новий не відповість.\" : \"Results vanish for ten minutes after a rebuild. Keep the old index live until the new one answers.\","],
]);

const WORDS = `
/* Prototype only: which «Reject and redo» variant draws; 0 is today's review. */
const rejectVariant = () => Number((globalThis as { __rejectVariant?: number }).__rejectVariant ?? 0);
const REJECT_WORDS = {
  en: {
    reject: "Reject and redo", rejectShort: "Redo", modeChoose: "Take a variant", modeRedo: "Redo all", mode: "What to do with this round",
    none: "None fits", noneOn: "round {n} comes next", redoField: "Type or dictate what to redo in round {n}…", needsText: "Type or dictate what to redo first",
    rejected: "Rejected", nothingYet: "nothing yet", closest: "closest", sentRejected: "Corrections delivered · the orchestrator is making round {n}",
    savingRejected: "Rejected · delivering the corrections to the orchestrator", redoLine: "No variant is taken. Round {n} will be made from your corrections.",
    roundRejected: "rejected",
  },
  uk: {
    reject: "Відхилити й переробити", rejectShort: "Переробити", modeChoose: "Беру варіант", modeRedo: "Переробити все", mode: "Що зробити з цим раундом",
    none: "Жоден не підходить", noneOn: "далі раунд {n}", redoField: "Напишіть або надиктуйте, що переробити в раунді {n}…", needsText: "Спершу напишіть або надиктуйте, що переробити",
    rejected: "Відхилено", nothingYet: "поки нічого", closest: "найближчі", sentRejected: "Поправки доставлено · оркестратор готує раунд {n}",
    savingRejected: "Відхилено · поправки доставляються оркестратору", redoLine: "Жоден варіант не береться. Раунд {n} зроблять за вашими поправками.",
    roundRejected: "відхилено",
  },
} as const;
/* The rejection has its own kind: the caution tone, tinted while it is one of the actions and filled once it is the action. */
const REJECT_BASE = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control text-ui font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 [@media(pointer:coarse)]:h-11";
const REJECT_TINT = \`\${REJECT_BASE} border border-warning/50 bg-warning-soft px-3 text-warning hover:border-warning disabled:opacity-50\`;
const REJECT_FILL = \`\${REJECT_BASE} bg-warning px-3.5 text-canvas hover:opacity-90 disabled:opacity-45\`;
/* A save that cannot be pressed beside the rejection: an outline, no fill. */
const SAVE_QUIET = "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-control border border-border px-3.5 text-ui font-semibold text-muted [@media(pointer:coarse)]:h-11";
/* «Hide» beside two actions on the phone: a word, no box. */
const HIDE_PLAIN = "inline-flex h-11 shrink-0 items-center justify-center rounded-control px-2 text-ui font-semibold text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50";
`;

const C = "src/components/prototypeReview/PrototypeReview.tsx";
patch(C, [
  /* The icon for a rejected round. */
  ["import { Columns2, CornerDownRight,", "import { Columns2, CornerDownRight, RotateCcw,"],
  ["import { markPrototypeReviewSeen } from \"./prototypeReviewStore\";\n", `import { markPrototypeReviewSeen } from "./prototypeReviewStore";\n${WORDS}`],
  /* The draft remembers the reject mode (variants 2 and 3). */
  ["interface Draft { chosen: number[]; comment: string; answers: PrototypeAnswer[] }", "interface Draft { chosen: number[]; comment: string; answers: PrototypeAnswer[]; reject?: boolean }"],
  ["  const draft = (roundId && drafts[roundId]) || initialDraft(round);\n",
    `  const draft = (roundId && drafts[roundId]) || initialDraft(round);
  const RV = rejectVariant();
  const nextRound = round ? rounds.findIndex((entry) => entry.id === round.id) + 2 : 2;
  const rw = (key: keyof typeof REJECT_WORDS.en) => REJECT_WORDS[locale === "uk" ? "uk" : "en"][key].replace("{n}", String(nextRound));
  /* Variants 2 and 3 arm the rejection in the draft; variant 1 rejects from its own button. */
  const rejecting = (RV === 2 || RV === 3) && Boolean(draft.reject);
  /* The field is the corrections field: in the redo mode, and in variant 1 while no variant is ticked. */
  const redoField = RV === 1 ? Boolean(round?.variants.length) && draft.chosen.length === 0 : rejecting;
  /* Variant 1: corrections are written and nothing is ticked, so the rejection is the action. */
  const rejectReady = RV === 1 && draft.chosen.length === 0 && Boolean(draft.comment.trim());
  /* Variant 1: while no variant is ticked the save cannot be pressed, so it never outshines the rejection. */
  const saveQuiet = RV === 1 && redoField;
  const [needsText, setNeedsText] = useState(false);
`],
  /* Ticking a variant leaves the reject mode. */
  ["setDraft((held) => ({ ...held, chosen: held.chosen.includes(number)", "setDraft((held) => ({ ...held, reject: false, chosen: held.chosen.includes(number)"],
  /* The save learns the reject kind; a rejection without words asks for them. */
  ["  const save = async (skip = false) => {\n    if (!round || !(skip ? hasQuestions && canSend : savable) || saveInFlight.current) return;",
    `  const save = async (skip = false, reject = false) => {
    if (reject && !draft.comment.trim() && canSend) { setNeedsText(true); field.current?.focus(); return; }
    if (!round || !(reject ? canSend && hasVariants : skip ? hasQuestions && canSend : savable) || saveInFlight.current) return;`],
  ["      const result = await review.save({ reviewId: round.id, chosen: draft.chosen, comment: draft.comment,\n        ...(hasQuestions ? skip ? { skip: true as const } : { answers: draft.answers } : {}) });",
    `      const result = await review.save({ reviewId: round.id, chosen: reject && RV !== 1 ? [] : draft.chosen, comment: draft.comment,
        ...(reject ? { reject: true as const } : hasQuestions ? skip ? { skip: true as const } : { answers: draft.answers } : {}) });`],
  /* Variants 2 and 3: in the redo mode a variant cannot be ticked. The list's number fades, the phone's «Choose» leaves. */
  ["          aria-checked={chosen}\n          disabled={!open}", "          aria-checked={chosen}\n          disabled={!open || rejecting}"],
  ["focus-visible:ring-accent/40 disabled:cursor-default ${chosen ? \"border-accent bg-accent text-white\"", "focus-visible:ring-accent/40 disabled:cursor-default ${rejecting ? \"opacity-40 \" : \"\"}${chosen ? \"border-accent bg-accent text-white\""],
  ["      {open ? (\n        <button\n          type=\"button\"\n          role=\"checkbox\"\n          aria-checked={draft.chosen.includes(variant.number)}",
    "      {open && !rejecting ? (\n        <button\n          type=\"button\"\n          role=\"checkbox\"\n          aria-checked={draft.chosen.includes(variant.number)}"],
  /* A rejected round's mark in the round tabs. */
  ["          {entry.decision ? <Check className=\"h-3 w-3\" aria-label={t(\"proto.round.decided\")} />",
    "          {entry.decision?.rejected ? <RotateCcw data-prototype-round-rejected=\"\" className=\"h-3 w-3\" aria-label={REJECT_WORDS[locale === \"uk\" ? \"uk\" : \"en\"].roundRejected} />\n            : entry.decision ? <Check className=\"h-3 w-3\" aria-label={t(\"proto.round.decided\")} />"],
  /* The delivery line names the coming round for a rejection. */
  ["  const delivery = ({ state, retryable, phase }: NonNullable<PrototypeRoundView[\"decision\"]>[\"delivery\"]) => {",
    "  const delivery = ({ state, retryable, phase }: NonNullable<PrototypeRoundView[\"decision\"]>[\"delivery\"], rejected = false) => {"],
  ["          <span className=\"min-w-0\">{t(phase ? `proto.saved.${phase}` : `proto.delivery.${state}`)}</span>",
    "          <span className=\"min-w-0\">{rejected && (phase === \"delivered\" || (!phase && state === \"sent\")) ? rw(\"sentRejected\") : rejected && (phase === \"delivering\" || phase === \"saved\" || (!phase && state === \"pending\")) ? rw(\"savingRejected\") : t(phase ? `proto.saved.${phase}` : `proto.delivery.${state}`)}</span>"],
  /* The decided footer of a rejected round. */
  ["      <div className=\"flex flex-wrap items-center gap-1.5\">\n        <span {...(round.decision.skipped ? { \"data-prototype-skipped\": \"\" } : {})} className=\"text-label font-semibold text-secondary\">{t(!hasQuestions ? \"proto.chosen\" : round.decision.skipped ? \"proto.q.skipped\" : \"proto.q.answered\")}</span>\n        {chosenChips(round.decision.chosen)}",
    `      <div className="flex flex-wrap items-center gap-1.5">
        {round.decision.rejected ? <>
          <span data-prototype-rejected="" className="inline-flex items-center gap-1.5 text-label font-semibold text-primary"><RotateCcw className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden />{rw("rejected")}</span>
          {round.decision.chosen.length ? <span className="text-label text-muted">· {rw("closest")}</span> : null}
        </> : <span {...(round.decision.skipped ? { "data-prototype-skipped": "" } : {})} className="text-label font-semibold text-secondary">{t(!hasQuestions ? "proto.chosen" : round.decision.skipped ? "proto.q.skipped" : "proto.q.answered")}</span>}
        {chosenChips(round.decision.chosen)}`],
  ["      {delivery(round.decision.delivery)}\n", "      {delivery(round.decision.delivery, Boolean(round.decision.rejected))}\n"],
  /* The choice line: today's, variant 2's mode switch, or variant 3's «None fits». Ticked, «None fits» is the
     choice itself, so the words after it say only what comes next. */
  [`      {hasVariants && (!hasQuestions || draft.chosen.length > 0) ? <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <span className="text-label font-semibold text-secondary">{t("proto.chosen")}</span>
        {draft.chosen.length ? chosenChips(draft.chosen) : <span className="text-label text-muted">{t(phone ? "proto.chooseFirstPhone" : "proto.chooseFirst")}</span>}
      </div> : null}`,
  `      {hasVariants && RV === 2 ? <div data-prototype-reject-line="" className={\`flex min-h-6 gap-x-3 gap-y-1.5 \${phone ? "flex-col" : "flex-wrap items-center"}\`}>
        <span role="radiogroup" aria-label={rw("mode")} data-prototype-reject-modes="" className={\`inline-flex shrink-0 rounded-control border border-border bg-sunken p-0.5 \${phone ? "w-full" : ""}\`}>
          {(["choose", "redo"] as const).map((mode) => {
            const on = mode === "redo" ? rejecting : !rejecting;
            return <button key={mode} type="button" role="radio" aria-checked={on} data-prototype-reject-mode={mode} disabled={!canSend}
              className={\`inline-flex h-7 items-center justify-center gap-1.5 rounded-[5px] px-3 text-label font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 [@media(pointer:coarse)]:h-11 \${phone ? "flex-1" : ""} \${on ? "bg-card text-primary shadow-1" : "text-secondary hover:text-primary"}\`}
              onClick={() => { setNeedsText(false); setDraft((held) => ({ ...held, reject: mode === "redo", chosen: mode === "redo" ? [] : held.chosen })); }}>
              {mode === "redo" ? <RotateCcw className="h-3.5 w-3.5" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
              {rw(mode === "redo" ? "modeRedo" : "modeChoose")}
            </button>;
          })}
        </span>
        {rejecting ? phone ? null : <span data-prototype-redo-line="" className="min-w-0 text-label text-secondary">{rw("redoLine")}</span>
          : draft.chosen.length ? <span className="flex min-w-0 flex-wrap items-center gap-1.5"><span className="text-label font-semibold text-secondary">{t("proto.chosen")}</span>{chosenChips(draft.chosen)}</span> : null}
      </div>
      : hasVariants && (!hasQuestions || draft.chosen.length > 0) ? <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        <span className="text-label font-semibold text-secondary">{t("proto.chosen")}</span>
        {RV === 3 && rejecting ? null
          : draft.chosen.length ? chosenChips(draft.chosen) : <span className="text-label text-muted">{RV === 3 && phone ? rw("nothingYet") : t(phone ? "proto.chooseFirstPhone" : "proto.chooseFirst")}</span>}
        {RV === 3 ? <button type="button" role="checkbox" aria-checked={rejecting} data-prototype-reject-none="" disabled={!canSend}
          className={\`ml-1.5 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-control border px-2.5 text-label font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 [@media(pointer:coarse)]:h-11 \${rejecting ? "border-warning bg-warning-soft text-warning" : "border-strong bg-card text-primary hover:border-warning hover:text-warning"}\`}
          onClick={() => { setNeedsText(false); setDraft((held) => ({ ...held, reject: !held.reject, chosen: held.reject ? held.chosen : [] })); }}>
          <span aria-hidden className={\`grid h-4 w-4 place-items-center rounded-sm border \${rejecting ? "border-warning bg-warning text-canvas" : "border-strong bg-card"}\`}>{rejecting ? <Check className="h-3 w-3" /> : null}</span>
          {rw("none")}
        </button> : null}
        {RV === 3 && rejecting ? <span data-prototype-none-line="" className="text-label text-secondary">{rw("noneOn")}</span> : null}
      </div> : null}`],
  /* The field's words follow the reject mode. */
  ["            aria-label={t(\"proto.comment\")}\n            placeholder={t(hasQuestions ? \"proto.q.commentPlaceholder\" : \"proto.commentPlaceholder\")}",
    "            aria-label={redoField ? rw(\"redoField\") : t(\"proto.comment\")}\n            aria-invalid={needsText || undefined}\n            placeholder={redoField ? rw(\"redoField\") : t(hasQuestions ? \"proto.q.commentPlaceholder\" : \"proto.commentPlaceholder\")}"],
  /* The field and the actions keep their row; the «write first» words get the row under the field. */
  ["      <div className={\`flex gap-2 ${phone ? \"flex-col\" : \"items-end\"}\`}>\n        <div className={\`flex min-w-0 flex-1 rounded-control border border-border bg-canvas focus-within:border-accent/60 ",
    "      <div className={phone ? \"flex flex-col gap-2\" : RV ? \"grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-2 gap-y-1\" : \"flex items-end gap-2\"}>\n        <div data-prototype-field-box=\"\" className={\`flex min-w-0 flex-1 rounded-control border bg-canvas ${needsText ? \"border-warning ring-2 ring-warning/25\" : \"border-border focus-within:border-accent/60\"} "],
  /* In the corrections field the microphone reads as a control, at the text's contrast. */
  ["          <span className={recording ? \"self-end\" : \"shrink-0\"}>", "          <span data-prototype-mic=\"\" className={\`\${recording ? \"self-end\" : \"shrink-0\"} \${redoField ? \"[&_button]:text-primary\" : \"\"}\`}>"],
  ["            onChange={(event) => setDraft((held) => ({ ...held, comment: event.target.value }))}", "            onChange={(event) => { setNeedsText(false); setDraft((held) => ({ ...held, comment: event.target.value })); }}"],
  ["                event.preventDefault();\n                void save();", "                event.preventDefault();\n                void save(false, rejecting);"],
  /* The actions: variant 1 adds its own button; 2 and 3 turn the primary. */
  [`        <div data-prototype-actions="" className={hasQuestions ? phone ? "grid shrink-0 grid-cols-2 gap-2" : "flex shrink-0 justify-end gap-2" : "flex shrink-0 flex-wrap justify-end gap-2"}>
          <button type="button" className={SECONDARY} data-prototype-hide="" disabled={review.saving || speaking} onClick={() => void review.hide(round.id, false, phone ? "phone" : "desktop")}>{t("proto.hide")}</button>`,
  `        {needsText ? <p role="status" data-prototype-needs-text="" className={\`m-0 text-label font-semibold text-warning \${phone ? "" : "col-span-2 row-start-2"}\`}>{rw("needsText")}</p> : null}
        <div data-prototype-actions="" className={\`\${RV === 1 && phone && hasVariants ? "flex shrink-0 items-center justify-end gap-2" : hasQuestions ? phone ? "grid shrink-0 grid-cols-2 gap-2" : "flex shrink-0 justify-end gap-2" : "flex shrink-0 flex-wrap justify-end gap-2"}\${RV && !phone ? " col-start-2 row-start-1" : ""}\`}>
          <button type="button" className={RV === 1 && phone && hasVariants ? HIDE_PLAIN : SECONDARY} data-prototype-hide="" disabled={review.saving || speaking} onClick={() => void review.hide(round.id, false, phone ? "phone" : "desktop")}>{t("proto.hide")}</button>
          {RV === 1 && hasVariants ? <button type="button" className={rejectReady ? REJECT_FILL : REJECT_TINT} data-prototype-reject="" aria-label={rw("reject")} disabled={!canSend} onClick={() => void save(false, true)}><RotateCcw className="h-3.5 w-3.5" aria-hidden />{rw(phone ? "rejectShort" : "reject")}</button> : null}`],
  [`          <button type="button" className={PRIMARY} data-prototype-save="" disabled={!savable} onClick={() => void save()}>
            {review.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {t(hasQuestions ? "proto.answer" : "proto.save")}`,
  `          <button type="button" className={rejecting ? REJECT_FILL : saveQuiet ? SAVE_QUIET : PRIMARY} data-prototype-save="" disabled={rejecting ? !canSend : !savable} onClick={() => void save(false, rejecting)}>
            {review.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : rejecting ? <RotateCcw className="h-3.5 w-3.5" aria-hidden /> : null}
            {rejecting ? rw("reject") : t(hasQuestions ? "proto.answer" : "proto.save")}`],
]);
console.log("patched", root);
