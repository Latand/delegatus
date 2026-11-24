import { shortenHashesInText } from "@/lib/shortIds";
import fs from "node:fs/promises";
import os from "node:os";
import { claudeAccountsForPrivacy } from "@/lib/accounts/claude";
import { codexAccountsForPrivacy } from "@/lib/accounts/codex";
import { copilotAccountsForPrivacy } from "@/lib/accounts/copilot";
import { EMPTY_DENY_LIST, privateMatches, type PublicDenyList } from "@/lib/bridge/publicSafe";
import { isOpaqueProjectKey, projectDisplayName } from "@/lib/displayNames";
import { canonicalProject, projectAliasSnapshot } from "@/lib/projects/aliases";
import { projectCurationSnapshot } from "@/lib/projects/curation";
import { presentationName, projectPresentation } from "@/lib/projects/presentation";
import { repositoryReportName } from "@/lib/projects/settings";
import { projectDirectoryFallbacks } from "@/lib/scanner/projectDirectories";
import crypto from "node:crypto";
import sharp from "sharp";
import { taskFeedSource } from "@/lib/tasks/store";
import { telegramBotService, TelegramBotError, type TelegramRichMessage } from "@/lib/telegram/bot/service";
import { prototypeRoot, storedMediaPath, findPrototypeRound, mutatePrototypeRound, withPrototypeState } from "./store";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import path from "node:path";
import { withFileTransaction } from "@/lib/state/fileTransaction";
import type { OwnerDestinationFailure } from "@/lib/externalRelay/ownerDestination";
import type { PrototypeTelegramPost } from "./types";
import { readSelf } from "@/lib/links/self";
import { publicEntry } from "@/lib/links/publicEntry";
import { prototypeCopyLine, prototypeReference } from "./telegramAnswer";
import type { PrototypeFrame, PrototypeReviewRound } from "./types";

const inline = (text: string) => text.replace(/\s+/g, " ").replace(/([\\`*_{}\[\]()#+.!|<>~-])/g, "\\$1");
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attribute = (text: string) => escapeText(text).replace(/"/g, "&quot;");
export interface PrototypeSlide { id: string; variantNumber: number; caption: string; blob: Blob }

export function prototypeTelegramLink(round: PrototypeReviewRound): string {
  const url = new URL(readSelf()?.publicUrl ?? `http://localhost:${publicEntry().port}`);
  if (round.taskId) url.searchParams.set("prototypeTask", round.taskId);
  url.searchParams.set("prototypeReview", round.id);
  url.searchParams.set("project", round.project);
  return url.href;
}
// Bound the serialized Markdown as well as Telegram's parsed text.
const RICH_TEXT_MAX_BYTES = 32_768;

function shorten(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit - 1).join("") + "…";
}

function shortenDistinctLabels(labels: readonly string[], initialLimit = 32): string[] {
  const distinctLabels = new Set(labels);
  const maxLength = Math.max(1, ...labels.map(label => Array.from(label).length));
  let limit = Math.min(initialLimit, maxLength);
  while (true) {
    const shortened = labels.map(label => {
      const points = Array.from(label);
      if (points.length <= limit) return label;
      const retained = limit - 1;
      const head = Math.ceil(retained / 2);
      return `${points.slice(0, head).join("")}…${points.slice(points.length - (retained - head)).join("")}`;
    });
    if (new Set(shortened).size === distinctLabels.size || limit >= maxLength) return shortened;
    limit = Math.min(limit + 8, maxLength);
  }
}

function reviewTextDenyList(): PublicDenyList {
  const accounts = [...claudeAccountsForPrivacy(), ...codexAccountsForPrivacy(), ...copilotAccountsForPrivacy()];
  return { ...EMPTY_DENY_LIST, accounts: accounts.flatMap(account => [account.id, account.label]),
    local: [os.userInfo().username, path.basename(os.homedir()), os.hostname().split(".")[0]!] };
}

function reviewText(value: string, deny: PublicDenyList): string {
  // The owner's private review can include web links and repository names.
  // Screen machine paths, secrets and identities before escaping or shortening.
  const normalized = value.replaceAll("\\", "/");
  const matches = privateMatches(normalized, deny)
    .filter(match => ["path", "account", "host", "email", "secret"].includes(match.class))
    .sort((left, right) => left.start - right.start || right.end - left.end);
  // The shared matcher points at the drive-path prefix. Extend it through the
  // remaining Windows components so profile and nested folder names disappear.
  const windowsPath = /(?<![\p{L}\p{N}_])[a-z]:(?:\\|\/)(?!\/)(?:[^\\/\s]+(?:[ \t]+[^\\/\s]+)*(?:\\|\/))*[^\\/\s]+/giu;
  for (const match of normalized.matchAll(windowsPath)) {
    matches.push({ class: "path", start: match.index!, end: match.index! + match[0].length });
  }
  matches.sort((left, right) => left.start - right.start || right.end - left.end);
  let cursor = 0;
  let text = "";
  for (const match of matches) {
    if (match.start >= cursor) text += value.slice(cursor, match.start) + "[приховано]";
    cursor = Math.max(cursor, match.end);
  }
  return text + value.slice(cursor);
}

function reviewProjectName(project: string, deny: PublicDenyList): string {
  const key = canonicalProject(project);
  const alias = projectAliasSnapshot().displayNames[key];
  const manual = !alias && projectCurationSnapshot().manualProjects.find(row => canonicalProject(row.project) === key);
  const name = alias || (manual && manual.displayName) || repositoryReportName(key);
  const root = !name && isOpaqueProjectKey(key) ? projectDirectoryFallbacks([key])[key] : undefined;
  const fallback = projectDisplayName(key, name || (root && path.basename(root.replaceAll("\\", "/"))));
  const label = presentationName(projectPresentation(key), fallback).trim();
  return isOpaqueProjectKey(label) || reviewText(label, deny) !== label ? "Проєкт без назви" : shorten(label, 120);
}

function reviewCopy(round: PrototypeReviewRound, slides: readonly PrototypeSlide[], taskTitle: string) {
  const deny = reviewTextDenyList();
  const clean = (value: string) => reviewText(value, deny);
  return {
    round: { ...round, title: clean(round.title),
      questions: round.questions?.map(q => ({ ...q, text: clean(q.text),
        options: q.options.map(o => ({ ...o, label: clean(o.label) })),
        links: q.links?.map(link => ({ ...link, label: clean(link.label) })) })),
      variants: round.variants.map(v => ({ ...v, name: clean(v.name), description: clean(v.description) })) },
    slides: slides.map(s => ({ ...s, caption: clean(s.caption) })),
    taskTitle: shorten(clean(taskTitle.split("\n")[0]!), 200),
    projectName: reviewProjectName(round.project, deny),
  };
}
type ReviewCopy = ReturnType<typeof reviewCopy>;

function renderCompact(copy: ReviewCopy, shortenOptions: boolean, sample = false): TelegramRichMessage {
  const { round, slides } = copy;
  const variants = round.variants.map(v => ({ ...v, description: shorten(v.description, 80) }));
  const previews = round.variants.flatMap(v => slides.filter(s => s.variantNumber === v.number).slice(0, 1)
    .map(s => ({ ...s, caption: shorten(s.caption, 80) })));
  const condensed = { ...copy, round: { ...round, variants }, slides: previews };
  if (!shortenOptions) {
    const withFullOptions = renderReview(condensed, true, sample);
    if (Buffer.byteLength(withFullOptions.markdown) <= RICH_TEXT_MAX_BYTES) return withFullOptions;
  }
  // Retain both ends and grow the retained context until labels stay distinct.
  const questions = round.questions?.map(q => {
    const labels = shortenDistinctLabels(q.options.map(option => shortenHashesInText(option.label)));
    return { ...q, options: q.options.map((option, i) => ({ ...option, label: labels[i]! })) };
  });
  const withShortOptions = renderReview({ ...condensed, round: { ...condensed.round, questions } }, true, sample);
  if (Buffer.byteLength(withShortOptions.markdown) <= RICH_TEXT_MAX_BYTES) return withShortOptions;
  return renderReview({ ...copy, slides: [], round: { ...round, questions,
    variants: variants.map(v => ({ ...v, description: "" })) } }, true, sample);
}

/** A definitive Telegram limit refusal uses this smaller rich carousel. */
export function renderPrototypeTelegramSummary(round: PrototypeReviewRound, slides: readonly PrototypeSlide[], taskTitle = ""): TelegramRichMessage {
  return renderCompact(reviewCopy(round, slides, taskTitle), true);
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
  return renderBounded(reviewCopy(round, slides, taskTitle), sample);
}

function renderBounded(copy: ReviewCopy, sample = false): TelegramRichMessage {
  const full = renderReview(copy, false, sample);
  if (Buffer.byteLength(full.markdown) <= RICH_TEXT_MAX_BYTES) return full;
  return renderCompact(copy, false, sample);
}

function renderReview({ round, slides, taskTitle, projectName }: ReviewCopy, compact: boolean, sample = false): TelegramRichMessage {
  const title = `${sample ? "Зразок · " : ""}${round.variants.length ? "Прототип" : "Форма рішення"} · ${round.title}`;
  const reference = prototypeReference(round);
  const lines = [`# 🧪 ${inline(title)}`, `<p>Проєкт: <b>${escapeText(projectName)}</b></p>`, "",
    ...(taskTitle ? [`${inline(taskTitle)}`, ""] : []), reference, ""];
  const plain = [`🧪 ${title}`, `Проєкт: ${projectName}`, ...(taskTitle ? [taskTitle, ""] : []), reference, ""];
  if (sample) {
    const notice = "Це зразок нового повідомлення для перегляду на телефоні.";
    lines.push(notice, "");
    plain.push(notice, "");
  }
  const questions = round.questions ?? [];
  for (const [i, question] of questions.entries()) {
    const heading = `Питання ${i + 1}/${questions.length} · ${question.text.replace(/\s+/g, " ")}${question.multiple ? " (можна кілька)" : ""}`;
    const options = question.options.map((option, j) => `${String.fromCharCode(97 + j)}) ${shortenHashesInText(option.label).replace(/\s+/g, " ")}${option.recommended ? " ✅" : ""}`);
    if (question.other) options.push("+ Інше — у коментарі");
    lines.push(`<p><b>${escapeText(heading)}</b><br>${options.map(escapeText).join("<br>")}</p>`, "");
    plain.push(heading, ...options, "");
    for (const link of question.links ?? []) {
      lines.push(`[${inline(link.label)}](<${link.href}>)`, "");
      plain.push(`${link.label}: ${link.href}`, "");
    }
  }
  const variants = [...round.variants].sort((a, b) => a.number - b.number);
  for (const variant of variants) {
    lines.push(`**${variant.number} · ${inline(variant.name)}**`, "");
    if (variant.description) lines.push(inline(variant.description), "");
    const frames = slides.filter(slide => slide.variantNumber === variant.number);
    if (frames.length) lines.push("<tg-slideshow>", ...frames.map(s => `![](tg://photo?id=${s.id} ${JSON.stringify(s.caption.replace(/[\r\n]/g, " "))})`), "</tg-slideshow>", "");
    else lines.push("Кадри — у Delegatus.", "");
    plain.push(`${variant.number} · ${variant.name}`);
    if (variant.description) plain.push(variant.description);
    plain.push(...frames.map(s => s.caption), "");
  }
  const link = prototypeTelegramLink(round);
  const count = variants.reduce((n, v) => n + v.frames.length, 0);
  const frames = count ? `${compact ? "Скорочене рев’ю · " : ""}Кадри: ${slides.length}/${count}. ` : "";
  lines.push(`${frames}[Повне рев’ю у Delegatus](<${link}>)`, "");
  plain.push(`${frames}Повне рев’ю у Delegatus: ${link}`, "");
  const example = questions.map((_, index) => `${index + 1}a`).join(", ");
  const reply = questions.length
    ? `Дайте текстову відповідь на це повідомлення. Наприклад, ${example}, «рекомендовані» або відповідь своїми словами. Застереження теж збережуться.`
    : "Дайте текстову відповідь на це повідомлення з номером варіанта й коментарем.";
  lines.push(reply, "");
  plain.push(reply, "");
  const button = (label: string, text: string, recommended = false) => `<tg-button type="copy_text"${recommended ? ' style="success"' : ""} text="${attribute(text)}">${label}</tg-button>`;
  if (questions.length) {
    const copied = prototypeCopyLine(round);
    lines.push('<tg-button-row align="center">', button("Скопіювати рекомендовані", copied, true), "</tg-button-row>");
    plain.push(`Скопіювати рекомендовані: ${copied}`);
  }
  for (let i = 0; i < variants.length; i += 8) lines.push('<tg-button-row align="center">', ...variants.slice(i, i + 8).map(v => button(`Варіант ${v.number}`, prototypeCopyLine(round, v.number))), "</tg-button-row>");
  for (const variant of variants) plain.push(`Варіант ${variant.number}: ${prototypeCopyLine(round, variant.number)}`);
  return { markdown: lines.join("\n"), plainText: plain.join("\n"), images: slides.map(({ id, blob }) => ({ id, blob })) };
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
    const record = async (state: PrototypeTelegramPost["state"], reason?: string, destinationDetail?: PrototypeTelegramPost["destinationDetail"]) => {
      const post: PrototypeTelegramPost = { key, state, at: new Date().toISOString(), ...(reason ? { reason } : {}),
        ...(destinationDetail ? { destinationDetail } : {}) };
      await withPrototypeState(() => mutatePrototypeRound(round.taskId, round.id, held => { held.telegramPost = post; }));
      return post;
    };
    await record("pending");
    try {
      const task = await withPrototypeState(() => round.taskId === null ? undefined : taskFeedSource()?.get(round.taskId));
      const slides = await prototypeSlides(current);
      const copy = reviewCopy(current, slides, task?.text ?? "");
      const fallback = renderBounded({ ...copy, slides: [] });
      let unavailable: OwnerDestinationFailure | undefined;
      const result = await telegramBotService().sendOwnerReview({ clientRequestId: key,
        message: renderBounded(copy), fallbackMarkdown: fallback.markdown, fallbackPlainText: fallback.plainText,
        limitFallback: renderCompact(copy, true) }, failure => { unavailable = failure; });
      if (!result) return record("failed", unavailable?.reason ?? "destination_unavailable", unavailable?.detail);
      return record("sent");
    } catch (error) {
      // Never log a task title, Telegram description, path or destination.
      const reason = error instanceof TelegramBotError ? error.code : "unavailable";
      console.warn("prototype Telegram post refused", reason);
      return record(reason === "send_uncertain" ? "uncertain" : "failed", reason);
    }
  });
}
