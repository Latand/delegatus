import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { loadTasks } from "@/lib/tasks/store";
import { telegramBotService, TelegramBotError, type TelegramRichMessage } from "@/lib/telegram/bot/service";
import { prototypeRoot, storedMediaPath, findPrototypeRound, mutatePrototypeRound, withPrototypeState } from "./store";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import path from "node:path";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import { ownerReviewDestination } from "@/lib/externalRelay/telegramPublication";
import type { PrototypeTelegramPost } from "./types";
import { readSelf } from "@/lib/links/self";
import { publicEntry } from "@/lib/links/publicEntry";
import { prototypeCopyLine, prototypeReference } from "./telegramAnswer";
import type { PrototypeFrame, PrototypeReviewRound } from "./types";

const inline = (text: string) => text.replace(/\s+/g, " ").replace(/([\\`*_{}\[\]()#+.!|<>~-])/g, "\\$1");
const attribute = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export interface PrototypeSlide { id: string; variantNumber: number; caption: string; blob: Blob }

export function prototypeTelegramLink(round: PrototypeReviewRound): string {
  const url = new URL(readSelf()?.publicUrl ?? `http://localhost:${publicEntry().port}`);
  if (round.taskId) url.searchParams.set("prototypeTask", round.taskId);
  url.searchParams.set("prototypeReview", round.id);
  url.searchParams.set("project", round.project);
  return url.href;
}
function withReviewLink(message: TelegramRichMessage, round: PrototypeReviewRound, previews: number): TelegramRichMessage {
  const link = prototypeTelegramLink(round);
  const count = round.variants.reduce((n, v) => n + v.frames.length, 0);
  return { ...message,
    markdown: `${message.markdown}\n\nКадри: ${previews}/${count}. [Повне рев’ю у Delegatus](<${link}>)`,
    plainText: `${message.plainText}\n\nКадри: ${previews}/${count}. ${link}` };
}

/** Only a definitive Telegram limit refusal uses this smaller rich carousel. */
export function renderPrototypeTelegramSummary(round: PrototypeReviewRound, slides: readonly PrototypeSlide[], taskTitle = ""): TelegramRichMessage {
  const compact = { ...round, title: round.title.slice(0, 120),
    questions: round.questions?.map(q => ({ ...q, text: q.text.slice(0, 80), options: q.options.map(o => ({ ...o, label: o.label.slice(0, 40) })) })),
    variants: round.variants.map(v => ({ ...v, description: v.description.slice(0, 160) })) };
  const previews = round.variants.flatMap(v => slides.filter(s => s.variantNumber === v.number).slice(0, 1).map(s => ({ ...s, caption: s.caption.slice(0, 160) })));
  const message = renderPrototypeTelegram(compact, previews, taskTitle.slice(0, 200));
  const count = round.variants.reduce((n, v) => n + v.frames.length, 0);
  const link = prototypeTelegramLink(round);
  message.markdown += `\n\nСкорочене рев’ю · ${count} кадрів. [Повне рев’ю у Delegatus](<${link}>)`;
  message.plainText += `\n\nСкорочене рев’ю · ${count} кадрів. ${link}`;
  return message;
}

/** First valid frame of each variant gets priority when the round exceeds 50. */
export async function prototypeSlides(round: PrototypeReviewRound): Promise<PrototypeSlide[]> {
  if (round.mediaRemovedAt) return [];
  let root: string;
  try { root = await fs.realpath(prototypeRoot()); } catch { return []; }
  const variants = [...round.variants].sort((a, b) => a.number - b.number);
  const groups = variants.map(variant => ({ variant, next: 0, slides: [] as PrototypeSlide[] }));
  let count = 0;
  const fill = async (group: typeof groups[number], limit: number) => {
    const { variant, slides } = group;
    while (group.next < variant.frames.length && count < 50 && slides.length < limit) {
      const index = group.next++;
      const frame = variant.frames[index]!;
      const blob = await frameBlob(root, round.id, frame);
      if (blob) { slides.push({ id: `v${variant.number}f${index + 1}`, variantNumber: variant.number, caption: `${variant.number} · ${variant.name} — ${frame.caption}`, blob }); count++; }
    }
  };
  // Reserve variant coverage before filling the preview. Decode and retain at
  // most 50 valid frames, even when the full review contains 240 files.
  for (const group of groups) await fill(group, 1);
  for (const group of groups) await fill(group, 50);
  const slides = groups.map(g => g.slides);
  if (round.variants.reduce((n, v) => n + v.frames.length, 0) <= 50) return slides.flat();
  return [...slides.flatMap(g => g.slice(0, 1)), ...slides.flatMap(g => g.slice(1))];
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
  for (const variant of [...round.variants].sort((a, b) => a.number - b.number)) {
    lines.push(`**${variant.number} · ${inline(variant.name)}**`, "", inline(variant.description), "");
    const frames = slides.filter(slide => slide.variantNumber === variant.number);
    if (frames.length) lines.push("<tg-slideshow>", ...frames.map(s => `![](tg://photo?id=${s.id} ${JSON.stringify(s.caption.replace(/[\r\n]/g, " "))})`), "</tg-slideshow>", "");
    else lines.push("Кадри — у Delegatus.", "");
  }
  for (const [i, question] of (round.questions ?? []).entries()) {
    const heading = `<b>${attribute(`Питання ${i + 1}/${round.questions!.length} · ${question.text.replace(/\s+/g, " ")}${question.multiple ? " (можна кілька)" : ""}`)}</b>`;
    const options = question.options.map((option, j) => `${String.fromCharCode(97 + j)}) ${attribute(option.label.replace(/\s+/g, " "))}${option.recommended ? " ✅" : ""}`);
    lines.push(`<p>${[heading, ...options, ...(question.other ? ["+ Інше — у коментарі"] : [])].join("<br>")}</p>`, "");
  }
  lines.push("---", `Як відповісти: дайте текстовий reply на цей пост або його опитування: 1b, 2a; 1: b; рекомендовані; або відповідь своїми словами. Рішення записує лише текстовий reply власника. Голоси показують думки учасників. Можна також надіслати клону ${prototypeReference(round)} і відповідь, або скористатися кнопкою. Застереження до рекомендованих відповідей теж збережуться. Повне рев’ю — у Delegatus.`, "");
  const button = (label: string, text: string, recommended = false) => `<tg-button type="copy_text"${recommended ? ' style="success"' : ""} text="${attribute(text)}">${label}</tg-button>`;
  if (round.questions?.length) lines.push('<tg-button-row align="center">', button("Скопіювати рекомендовані", prototypeCopyLine(round), true), "</tg-button-row>");
  const variants = [...round.variants].sort((a, b) => a.number - b.number);
  for (let i = 0; i < variants.length; i += 8) lines.push('<tg-button-row align="center">', ...variants.slice(i, i + 8).map(v => button(`Варіант ${v.number}`, prototypeCopyLine(round, v.number))), "</tg-button-row>");
  const plain = [`🧪 ${sample ? "Зразок · " : ""}Прототип · ${round.title}`, `${taskTitle.split("\n")[0]!} · ${prototypeReference(round)}`, ""];
  for (const variant of variants) {
    plain.push(`${variant.number} · ${variant.name}`, variant.description,
      ...slides.filter(s => s.variantNumber === variant.number).map(s => s.caption), "");
  }
  for (const [i, question] of (round.questions ?? []).entries()) {
    plain.push(`Питання ${i + 1}/${round.questions!.length} · ${question.text}${question.multiple ? " (можна кілька)" : ""}`,
      ...question.options.map((o, j) => `${String.fromCharCode(97 + j)}) ${o.label}${o.recommended ? " ✅" : ""}`),
      ...(question.other ? ["+ Інше — у коментарі"] : []), "");
  }
  plain.push(`Дайте текстовий reply на цей пост або його опитування: 1b, 2a; 1: b; рекомендовані; або відповідь своїми словами. Рішення записує лише текстовий reply власника. Голоси показують думки учасників. Можна також надіслати клону ${prototypeReference(round)} і відповідь, або скопійований рядок. Застереження теж збережуться. Повне рев’ю — у Delegatus.`);
  if (round.questions?.length) plain.push(`Скопіювати рекомендовані: ${prototypeCopyLine(round)}`);
  for (const variant of variants) plain.push(`Варіант ${variant.number}: ${prototypeCopyLine(round, variant.number)}`);
  return { markdown: lines.join("\n"), plainText: plain.join("\n"), images: slides.map(({ id, blob }) => ({ id, blob })),
    review: { id: round.id, taskId: round.taskId, questions: round.questions ?? [] } };
}

export async function postPrototypeReviewToTelegram(round: PrototypeReviewRound, key = round.id): Promise<PrototypeTelegramPost | undefined> {
  return withViewerOperation("prototype.telegram", () => postRound(round, key));
}
async function postRound(round: PrototypeReviewRound, key: string): Promise<PrototypeTelegramPost | undefined> {
  return withFileTransaction(path.join(prototypeRoot(), `${round.id}.telegram.lock`), "Telegram review post is busy", async () => {
    const current = await withPrototypeState(() => findPrototypeRound(round.taskId, round.id));
    if (!current) return undefined;
    if (key === round.id && current.telegramPost && current.telegramPost.key !== key) return current.telegramPost;
    if (round.telegramPost?.state === "pending" && round.telegramPost.key === key && current.telegramPost?.key !== key) return current.telegramPost;
    // A durable pending claim survives a stopped process. The bot's journal
    // reconciles it under this same key without issuing a duplicate send.
    if (current.telegramPost?.key === key && current.telegramPost.state !== "pending") return current.telegramPost;
    const record = async (state: PrototypeTelegramPost["state"], reason?: string) => {
      const post = { key, state, at: new Date().toISOString(), ...(reason ? { reason } : {}) };
      await withPrototypeState(() => mutatePrototypeRound(round.taskId, round.id, held => { held.telegramPost = post; }));
      return post;
    };
    await record("pending");
    try {
      const task = await withPrototypeState(() => loadTasks().find(t => t.id === round.taskId));
      const slides = await prototypeSlides(current);
      const fallback = withReviewLink(renderPrototypeTelegram(current, [], task?.text), current, 0);
      const result = await telegramBotService().sendOwnerReview({ clientRequestId: key,
        message: withReviewLink(renderPrototypeTelegram(current, slides, task?.text), current, slides.length), fallbackMarkdown: fallback.markdown, fallbackPlainText: fallback.plainText,
        limitFallback: renderPrototypeTelegramSummary(current, slides, task?.text) });
      if (!result) return record("failed", ownerReviewDestination().reason ?? "destination_unavailable");
      return record("sent");
    } catch (error) {
      // Never log a task title, Telegram description, path or destination.
      const reason = error instanceof TelegramBotError ? error.code : "unavailable";
      console.warn("prototype Telegram post refused", reason);
      return record(reason === "send_uncertain" ? "uncertain" : "failed", reason);
    }
  });
}
