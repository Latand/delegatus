/** Query-side forms use the existing unicode61 index; no body is rewritten. */
export interface QueryUnit {
  label: string;
  expression: string;
  terms: Array<{ term: string; prefix: boolean }>;
  phrase: boolean;
  /** Written in quotation marks: the second pass never widens it. */
  quoted?: true;
  /** Carries the second pass's wider expression; its label ends with "~". */
  wide?: true;
}

const CYRILLIC_ENDINGS = (
  "ившись ывшись иться ыться ешься ються ення ання іння ться тися "
  + "ами ями ого его ому ему ими ыми ові еві ах ях ам ям ом ем ою ею "
  + "ої ій ий ый ой ая яя ое ее ие ые ую юю их ых ов ев ей ів ет ют ут ит ат ят "
  + "ла ло ли ть ти ся сь а я о е ы и і ї у ю ь й"
).split(" ").sort((a, b) => b.length - a.length);
const STOP_WORDS = new Set((
  "the and of to in is for with a an on at by as be are was were it this that from or not "
  + "и в на не что с по из к у за от до а о это как для но или "
  + "і та що з до як це але або для"
).split(" "));

const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

function forms(term: string): string[] {
  if (!/[её]/u.test(term) || !/^[а-яіїєґё]+$/u.test(term)) return [term];
  const variants = new Set([term, term.replaceAll("ё", "е")]);
  for (const i of [term.indexOf("е"), term.lastIndexOf("е")]) {
    if (i >= 0) variants.add(term.slice(0, i) + "ё" + term.slice(i + 1));
  }
  return [...variants];
}

export function queryUnits(query: string, frequency?: (term: string, prefix: boolean) => number, messages = 0): QueryUnit[] {
  const units: QueryUnit[] = [];
  for (const match of query.matchAll(/"([^"]*)"|([^\s"]+)/gu)) {
    const raw = match[1] ?? match[2];
    // unicode61 retains dotted capital I with diacritic removal disabled.
    // Avoid JavaScript's expanding lowercase mapping to i + combining dot.
    const lowered = raw.includes("İ") ? Array.from(raw, (char) => char === "İ" ? char : char.toLowerCase()).join("") : raw.toLowerCase();
    const tokens = lowered.match(/[\p{L}\p{N}\p{M}\p{Co}_#]+/gu) ?? [];
    if (!tokens.length) continue;
    if (match[1] !== undefined || tokens.length > 1) {
      const label = tokens.join(" ");
      units.push({ label, expression: quote(label), terms: tokens.map((term) => ({ term, prefix: false })), phrase: true,
        ...(match[1] !== undefined ? { quoted: true as const } : {}) });
      continue;
    }
    const word = tokens[0]!;
    let stem = word;
    let prefix = false;
    if (!/[\p{N}_#]/u.test(word) && word.length >= 5) {
      const endings = /^[a-z]+$/u.test(word) ? ["ies", "ied", "ing", "ed", "es", "s"]
        : /^[а-яіїєґё]+$/u.test(word) ? CYRILLIC_ENDINGS : [];
      const ending = endings.find((s) => word.endsWith(s) && word.length - s.length >= 4);
      stem = ending ? word.slice(0, -ending.length) : word;
      if (!ending && /^[a-z]+$/u.test(word) && word.endsWith("e") && word.length > 5) stem = word.slice(0, -1);
      if (frequency && messages && stem !== word && frequency(stem, true) > messages * 0.05
        && frequency(word, true) <= messages * 0.05) stem = word;
      prefix = true;
    }
    const terms = /^\d+$/u.test(word)
      ? [word, `#${word}`].map((term) => ({ term, prefix: false }))
      : forms(stem).map((term) => ({ term, prefix }));
    const expression = terms.map(({ term, prefix }) => quote(term) + (prefix ? "*" : "")).join(" OR ");
    units.push({ label: stem + (prefix ? "*" : ""), expression: terms.length > 1 ? `(${expression})` : expression, terms, phrase: false });
  }
  // Duplicates of one expression merge into the last; quotation marks on any of them hold.
  const merged = new Map<string, QueryUnit>();
  for (const unit of units) {
    merged.set(unit.expression, merged.get(unit.expression)?.quoted ? { ...unit, quoted: true } : unit);
  }
  return [...merged.values()];
}

export function isFunctionWord(unit: QueryUnit): boolean {
  return !unit.phrase && STOP_WORDS.has(unit.label.replace(/\*$/u, ""));
}

/** The smallest window that recovered every on-topic replay query; see docs/design/smarter-search.md. */
export const WIDER_NEAR_TOKENS = 8;

/**
 * The second pass's form of a unit, or null when it has none. An unquoted
 * compound term also matches its parts near each other in one message; an
 * identifier also matches as a prefix. The literal form always stays.
 */
export function widerExpression(unit: QueryUnit): string | null {
  if (unit.quoted) return null;
  const single = !unit.phrase && unit.terms.length === 1 ? unit.terms[0]!.term : null;
  const parts = [...new Set(unit.phrase ? unit.terms.map((t) => t.term)
    : single?.includes("_") ? single.split("_").filter(Boolean) : [])];
  const wider = [unit.expression];
  if (parts.length >= 2 && !parts.some((part) => /^\d+$/u.test(part))
    && parts.filter((part) => !STOP_WORDS.has(part)).length >= 2) {
    wider.push(`NEAR(${parts.map(quote).join(" ")}, ${WIDER_NEAR_TOKENS})`);
  }
  if (single && single.length >= 5 && /[\p{N}_#]/u.test(single) && !/^#?\d+$/u.test(single)) wider.push(`${quote(single)}*`);
  return wider.length > 1 ? `(${wider.join(" OR ")})` : null;
}
