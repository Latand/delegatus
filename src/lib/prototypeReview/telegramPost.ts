import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { loadTasks } from "@/lib/tasks/store";
import { effectiveReportTelegram } from "@/lib/projects/settings";
import { telegramBotService, TelegramBotError, type TelegramRichMessage } from "@/lib/telegram/bot/service";
import { prototypeRoot, storedMediaPath } from "./store";
import { prototypeCopyLine, prototypeReference } from "./telegramAnswer";
import type { PrototypeFrame, PrototypeReviewRound } from "./types";

const inline = (text: string) => text.replace(/\s+/g, " ").replace(/([\\`*_{}\[\]()#+.!|<>~-])/g, "\\$1");
const attribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export interface PrototypeSlide { id: string; caption: string; blob: Blob }

/** First valid frame of each variant gets priority when the round exceeds 50. */
export async function prototypeSlides(round: PrototypeReviewRound): Promise<PrototypeSlide[]> {
  if (round.mediaRemovedAt) return [];
  let root: string;
  try { root = await fs.realpath(prototypeRoot()); } catch { return []; }
  const variants = [...round.variants].sort((a, b) => a.number - b.number);
  const groups: PrototypeSlide[][] = [];
  for (const variant of variants) {
    const slides: PrototypeSlide[] = [];
    for (const [index, frame] of variant.frames.entries()) {
      const blob = await frameBlob(root, round.id, frame);
      if (blob) slides.push({ id: `v${variant.number}f${index + 1}`, caption: `${variant.number} · ${variant.name} — ${frame.caption}`, blob });
      if (slides.length === 50) break;
    }
    groups.push(slides);
  }
  if (groups.reduce((n, g) => n + g.length, 0) <= 50) return groups.flat();
  return [...groups.flatMap(g => g.slice(0, 1)), ...groups.flatMap(g => g.slice(1))].slice(0, 50);
}
async function frameBlob(root: string, reviewId: string, frame: PrototypeFrame): Promise<Blob | null> {
  try {
    const filename = storedMediaPath(root, reviewId, frame.image);
    if (await fs.realpath(filename) !== filename || !(await fs.lstat(filename)).isFile()) return null;
    const bytes = await fs.readFile(filename);
    if (bytes.length > 4 * 1024 * 1024 || bytes.length !== frame.image.bytes
      || crypto.createHash("sha256").update(bytes).digest("hex") !== frame.image.id) return null;
    const metadata = await sharp(bytes, { failOn: "warning" }).metadata();
    const width = metadata.width ?? 0, height = metadata.height ?? 0;
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || !width || !height || width + height > 10_000
      || Math.max(width, height) / Math.min(width, height) > 20) return null;
    await sharp(bytes, { failOn: "warning" }).raw().toBuffer();
    return new Blob([Uint8Array.from(bytes)], { type: frame.image.mime });
  } catch { return null; /* Missing, retired or invalid media still leaves the questions usable. */ }
}

export function renderPrototypeTelegram(round: PrototypeReviewRound, slides: readonly PrototypeSlide[], taskTitle = "", sample = false): TelegramRichMessage {
  const lines = [`# 🧪 ${sample ? "Зразок · " : ""}Прототип · ${inline(round.title)}`, `${inline(taskTitle.split("\n")[0]!)} · ${prototypeReference(round)}`, ""];
  if (sample) lines.push("Це зразок нового повідомлення для перегляду на телефоні.", "");
  if (slides.length) lines.push("<tg-slideshow>", ...slides.map(s => `![](tg://photo?id=${s.id} ${JSON.stringify(s.caption.replace(/[\r\n]/g, " "))})`), "</tg-slideshow>", "");
  else if (round.variants.length) lines.push("Кадри — у Delegatus.", "");
  for (const variant of [...round.variants].sort((a, b) => a.number - b.number)) {
    lines.push(`**${variant.number} · ${inline(variant.name)}** — ${inline(variant.description.split("\n")[0]!.slice(0, 140))}`, "");
  }
  for (const [i, question] of (round.questions ?? []).entries()) {
    lines.push(`## Питання ${i + 1}/${round.questions!.length} · ${inline(question.text)}${question.multiple ? " (можна кілька)" : ""}`, "",
      "| | Відповідь | |", "|:--|:--|:--:|",
      ...question.options.map((option, j) => `| **${String.fromCharCode(97 + j)}** | ${inline(option.label)} | ${option.recommended ? "✅ рекомендовано" : ""} |`),
      ...(question.other ? ["| **+** | Інше (поясніть у коментарі) | |"] : []), "");
  }
  lines.push("---", "Як відповісти: натисніть кнопку, надішліть скопійований рядок клону відповіддю на це повідомлення і, за бажанням, допишіть коментар з нового рядка. Повне рев’ю — у Delegatus.", "");
  const button = (label: string, text: string, recommended = false) => `<tg-button type="copy_text"${recommended ? ' style="success"' : ""} text="${attribute(text)}">${label}</tg-button>`;
  if (round.questions?.length) lines.push('<tg-button-row align="center">', button("Скопіювати рекомендовані", prototypeCopyLine(round), true), "</tg-button-row>");
  const variants = [...round.variants].sort((a, b) => a.number - b.number);
  for (let i = 0; i < variants.length; i += 8) lines.push('<tg-button-row align="center">', ...variants.slice(i, i + 8).map(v => button(`Варіант ${v.number}`, prototypeCopyLine(round, v.number))), "</tg-button-row>");
  return { markdown: lines.join("\n"), images: slides.map(({ id, blob }) => ({ id, blob })) };
}

export async function postPrototypeReviewToTelegram(round: PrototypeReviewRound): Promise<void> {
  try {
    const destination = effectiveReportTelegram(round.project);
    if (!destination) return;
    const task = loadTasks().find(t => t.id === round.taskId);
    const slides = await prototypeSlides(round);
    await telegramBotService().sendRichMessage({ clientRequestId: round.id, chat: destination.chat, topicId: destination.topicId,
      message: renderPrototypeTelegram(round, slides, task?.text), fallbackMarkdown: renderPrototypeTelegram(round, [], task?.text).markdown });
  } catch (error) {
    // Never log a task title, Telegram description, path or destination.
    console.warn("prototype Telegram post refused", error instanceof TelegramBotError ? error.code : "unavailable");
  }
}
