const TASK_TITLE_LIMIT = 96;

function stripInjectedContext(text: string): string {
  let out = text;
  const envEnd = out.lastIndexOf("</environment_context>");
  if (envEnd >= 0) out = out.slice(envEnd + "</environment_context>".length);
  const instructionsEnd = out.lastIndexOf("</INSTRUCTIONS>");
  if (instructionsEnd >= 0) out = out.slice(instructionsEnd + "</INSTRUCTIONS>".length);
  return out.trim();
}

function normalizePrompt(text: string): string {
  return stripInjectedContext(text)
    .replace(/(?:э[-\s]*э[-\s]*э|эээ|ээ|эм|ммм)/giu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isServicePrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^(?:<|Caveat:|\[Request interrupted|This came from another Claude session|# AGENTS\.md instructions)/.test(trimmed)) return true;
  if (trimmed.length < 18) return true;
  return false;
}

const TASKISH =
  /(?:созда(?:й|ть|л)|сдела(?:й|ть)|добав(?:ь|ить)|исправ(?:ь|ить)|почин(?:и|ить)|проверь|разберись|найди|напиши|реализ(?:уй|овать)|запусти|подготовь|обнови|перенеси|удали|отрефактори|проанализируй|\b(?:create|add|fix|implement|build|write|review|check|investigate|run|update|refactor|deploy|make|set up|setup)\b)/i;

function trimRequestLead(text: string): string {
  return text
    .replace(/^(?:я\s+бы\s+хотел(?:а)?|хочу|нужно|надо)(?:,?\s+чтобы\s+ты)?\s+/iu, "")
    .replace(/^(?:пожалуйста|pls|please),?\s+/iu, "")
    .replace(/^(?:i(?:'d| would)\s+like\s+(?:you\s+)?to|can you|could you)\s+/iu, "")
    .trim();
}

function normalizeLeadingVerb(text: string): string {
  const replacements: Array<[RegExp, string]> = [
    [/^создал[а]?\s+/iu, "создать "],
    [/^сделал[а]?\s+/iu, "сделать "],
    [/^написал[а]?\s+/iu, "написать "],
    [/^добавил[а]?\s+/iu, "добавить "],
    [/^исправил[а]?\s+/iu, "исправить "],
    [/^проверил[а]?\s+/iu, "проверить "],
    [/^запустил[а]?\s+/iu, "запустить "],
    [/^подготовил[а]?\s+/iu, "подготовить "],
    [/^обновил[а]?\s+/iu, "обновить "],
    [/^реализовал[а]?\s+/iu, "реализовать "],
  ];
  for (const [pattern, replacement] of replacements) {
    if (pattern.test(text)) return text.replace(pattern, replacement);
  }
  return text;
}

function sentenceHead(text: string): string {
  const firstParagraph = text.split(/\n\s*\n/, 1)[0] ?? text;
  const firstSentence = firstParagraph.match(/^(.{18,}?[.!?。！？])(?:\s|$)/u)?.[1] ?? firstParagraph;
  return firstSentence
    .replace(/\s+/g, " ")
    .replace(/[.!?。！？]+$/u, "")
    .trim();
}

function titleCaseFirst(text: string): string {
  const first = text.charAt(0);
  return first ? first.toLocaleUpperCase() + text.slice(1) : text;
}

/** Pure request-title parsing for transcript consumers. */
export function taskTextFromPrompt(raw: string): string | null {
  const prompt = normalizePrompt(raw);
  if (isServicePrompt(prompt) || !TASKISH.test(prompt)) return null;
  const title = titleCaseFirst(normalizeLeadingVerb(trimRequestLead(sentenceHead(prompt)))).slice(0, TASK_TITLE_LIMIT).trim();
  return title || null;
}
