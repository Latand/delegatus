import { MAX_STAGE_FINDING_CHARS, MAX_STAGE_REPORT_FINDINGS, MAX_STAGE_REPORT_SUMMARY_CHARS } from "./limits";
import { STAGE_FINDING_SEVERITIES, type StageFinding, type StageFindingSeverity, type StageVerdict, type StageVerdictStatus } from "./types";

const MAX_FINDINGS = MAX_STAGE_REPORT_FINDINGS;
const MAX_FINDING_CHARS = MAX_STAGE_FINDING_CHARS;
export const MAX_OUTPUT_CHARS = 32_000;
/* `rankedFindings` is derived from `findings`, never read from the value being
   validated: an agent that writes it into its own fenced block is ignored, and
   a persisted record re-derives the identical array when it is loaded. */
const ALLOWED_KEYS = new Set(["status", "findings", "rankedFindings", "confidence"]);

const SEVERITY_RANK = new Map<StageFindingSeverity | null, number>(
  [...STAGE_FINDING_SEVERITIES.map((severity, index) => [severity, index] as const), [null, STAGE_FINDING_SEVERITIES.length] as const],
);
/** `P1 — text`, `P1 - text` and `P1: text`: the forms reviewers already write
    and the form {@link stageFindingText} renders. The separator is required
    and a dash carries a space on each side, so prose that merely opens on a
    severity keeps its own text: "P1-based scoring is wrong" and "P0 through
    P3 are undefined" talk about ranks, and reading either as a rank would
    rewrite the words the reviewer wrote. */
const RANKED_FINDING_RE = new RegExp(`^(${STAGE_FINDING_SEVERITIES.join("|")})(?:\\s+[—–-]\\s+|\\s*:\\s*)([\\s\\S]*)$`);

/** One finding as a record. Text that names no severity is unranked, which is
    every finding a fenced verdict carried before ranking existed. */
export function stageFindingFromText(text: string): StageFinding {
  const match = RANKED_FINDING_RE.exec(text.trim());
  const body = match?.[2]?.trim();
  return match && body ? { severity: match[1] as StageFindingSeverity, text: body } : { severity: null, text: text.trim() };
}

/** The single rendering of a finding, for the card, the relay and the record. */
export function stageFindingText(finding: StageFinding): string {
  return finding.severity ? `${finding.severity} — ${finding.text}` : finding.text;
}

/** Most severe first, unranked last, stable within a severity. */
export function rankStageFindings(findings: readonly StageFinding[]): StageFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => (SEVERITY_RANK.get(left.finding.severity)! - SEVERITY_RANK.get(right.finding.severity)!) || (left.index - right.index))
    .map(({ finding }) => finding);
}

const PROSE_VERDICT_STATUSES = {
  APPROVE: "pass",
  REQUEST_CHANGES: "fail",
  COMMENT: "needs_decision",
  "NO FINDINGS": "pass",
} as const satisfies Record<string, StageVerdict["status"]>;
const PROSE_VERDICT_LINE_RE = /^\s*(?:VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)|(NO FINDINGS))\s*$/i;

type ProseVerdictMarker = keyof typeof PROSE_VERDICT_STATUSES;

function proseVerdictMarkers(prose: string): ProseVerdictMarker[] {
  const markers: ProseVerdictMarker[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (const line of prose.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const token = fenceMatch[1]!;
      const marker = token[0] as "`" | "~";
      if (!fence) fence = { marker, length: token.length };
      else if (fence.marker === marker && token.length >= fence.length && !fenceMatch[2]!.trim()) fence = null;
      continue;
    }
    if (fence || /^\s*>/.test(line)) continue;
    const match = PROSE_VERDICT_LINE_RE.exec(line);
    if (match) markers.push((match[1] ?? match[2])!.toUpperCase() as ProseVerdictMarker);
  }
  return markers;
}

export type ParsedStageVerdict = {
  verdict: StageVerdict;
  output: string;
  /** The findings are the engine's own synthesis rather than a reviewer's work:
      a review flow's state detail and the placeholder line a round with no
      findings gets. They describe nothing to fix, so they never route a fail
      edge (#1785). Absent on everything an agent reported for itself. */
  syntheticFindings?: boolean;
};

/**
 * Whether a settled verdict is the graph's fail signal (#1785). A fail always
 * is. A needs_decision is too when it carries findings a reviewer reported:
 * reviewers report fixable defects under that status when only their confidence
 * in the call is partial, and the fix stage a fail edge names is where those
 * findings belong. A needs_decision with nothing to fix, or with nothing but the
 * engine's own synthesis, is a question for the operator and parks.
 */
export function verdictRoutesAsFail(parsed: ParsedStageVerdict): boolean {
  if (parsed.verdict.status === "fail") return true;
  return parsed.verdict.status === "needs_decision"
    && Boolean(parsed.verdict.findings?.length)
    && !parsed.syntheticFindings;
}
export type RejectedStageVerdict = { failureReason: string; output: string };

export function stageVerdictFrom(value: unknown): StageVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ALLOWED_KEYS.has(key))) return null;
  if (record.status !== "pass" && record.status !== "fail" && record.status !== "needs_decision") return null;
  const verdict: StageVerdict = { status: record.status };
  if (record.findings !== undefined) {
    if (!Array.isArray(record.findings) || record.findings.length > MAX_FINDINGS) return null;
    const findings: StageFinding[] = [];
    for (const finding of record.findings) {
      if (typeof finding !== "string") return null;
      const trimmed = finding.trim();
      if (!trimmed || trimmed.length > MAX_FINDING_CHARS) return null;
      findings.push(stageFindingFromText(trimmed));
    }
    /* Ranking is what the record keeps: the relay, the park detail and the
       card all read `findings[0]`, and that must be the worst one. Findings
       none of which carry a rank have nothing to order, so they keep the
       order they arrived in and the record stays the array it always was.

       The clamp applies to the rendered form: rewriting a separator can
       lengthen a finding that was already at the bound, and a
       record this validator would then reject on reload is a record the store
       refuses whole. Clamping the rendering makes it idempotent — a reload
       re-derives the same array, byte for byte. */
    const ranked = rankStageFindings(findings).map((finding) => stageFindingFromText(stageFindingText(finding).slice(0, MAX_FINDING_CHARS)));
    verdict.findings = ranked.map(stageFindingText);
    if (ranked.some((finding) => finding.severity !== null)) verdict.rankedFindings = ranked;
  }
  if (record.confidence !== undefined) {
    if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) {
      return null;
    }
    verdict.confidence = record.confidence;
  }
  return verdict;
}

function completionVerdictFrom(value: unknown): StageVerdict | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return stageVerdictFrom({
    status: record.status,
    ...(Object.hasOwn(record, "findings") ? { findings: record.findings } : {}),
    ...(Object.hasOwn(record, "confidence") ? { confidence: record.confidence } : {}),
  });
}

/** One fenced block, as a Markdown reader sees it: where it opened, which line
    that was, and the exact bounds of its payload. */
export type FencedBlock = {
  /** Offset of the opening fence line. */
  index: number;
  /** 1-based line of the opening fence — the position a park detail names. */
  line: number;
  payload: string;
  /** Offsets of the payload inside the original text, for a caller that
      rewrites it in place. */
  payloadStart: number;
  payloadEnd: number;
};

/** A fence opens at the start of a line (up to three spaces of indent), and a
    backtick fence's info string may not itself contain a backtick. */
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Every fenced block in `text`, read line by line.
 *
 * Line-anchored on purpose (#1756). The production message that parked lane
 * 42490aea quoted a fence inside an inline code span — ```` ``` ```` in the
 * middle of a sentence — and a scan for three backticks ANYWHERE paired those
 * stray ticks with the opening fence of the real verdict. The verdict block
 * was consumed as somebody else's closing delimiter, never became a candidate,
 * and the lane parked reporting malformed JSON over a perfectly valid verdict.
 * Mid-line backticks are prose; only a line that begins with the fence can open
 * or close a block.
 *
 * A block left open at the end of the text closes there, as CommonMark has it,
 * so a final verdict whose closing fence the agent forgot is still readable.
 */
export function fencedBlocks(text: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  let open: { marker: string; length: number; index: number; line: number; payloadStart: number } | null = null;
  let offset = 0;
  let lineNumber = 0;
  for (const rawLine of text.split("\n")) {
    lineNumber += 1;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = FENCE_LINE_RE.exec(line);
    const token = match?.[1] ?? "";
    const info = match?.[2] ?? "";
    if (open) {
      if (match && token.startsWith(open.marker) && token.length >= open.length && !info.trim()) {
        /* The payload ends before the newline that carries the closing fence. */
        const payloadEnd = offset > open.payloadStart ? offset - 1 : open.payloadStart;
        blocks.push({
          index: open.index,
          line: open.line,
          payload: text.slice(open.payloadStart, payloadEnd),
          payloadStart: open.payloadStart,
          payloadEnd,
        });
        open = null;
      }
    } else if (match && !(token.startsWith("`") && info.includes("`"))) {
      const payloadStart = Math.min(offset + rawLine.length + 1, text.length);
      open = { marker: token[0]!, length: token.length, index: offset, line: lineNumber, payloadStart };
    }
    offset += rawLine.length + 1;
  }
  if (open) {
    blocks.push({
      index: open.index,
      line: open.line,
      payload: text.slice(open.payloadStart),
      payloadStart: open.payloadStart,
      payloadEnd: text.length,
    });
  }
  return blocks;
}

type FinalVerdictCandidate = {
  index: number;
  verdict: StageVerdict;
};

function malformedReason(what: string, line: number): string {
  return `canonical completed assistant turn ${what}, at the fenced block on line ${line}`;
}

function finalVerdictCandidate(text: string): FinalVerdictCandidate | { failureReason: string } {
  const blocks = fencedBlocks(text);
  if (!blocks.length) {
    return { failureReason: "canonical completed assistant turn is missing a fenced JSON verdict" };
  }

  const candidates: FinalVerdictCandidate[] = [];
  /* The reason names the block it was read from (#1756 expectation 3): a park
     detail that says only "malformed" cannot be told apart from a reader that
     was looking at the wrong text, which is exactly what happened. */
  let lastFailureReason = malformedReason("is missing a valid status, findings, or confidence field", blocks.at(-1)!.line);
  for (const block of blocks) {
    let raw: unknown;
    try {
      raw = JSON.parse(block.payload);
    } catch {
      lastFailureReason = malformedReason("has malformed JSON in the fenced verdict", block.line);
      continue;
    }
    const verdict = completionVerdictFrom(raw);
    if (!verdict) {
      lastFailureReason = malformedReason("is missing a valid status, findings, or confidence field", block.line);
      continue;
    }
    candidates.push({ index: block.index, verdict });
  }
  if (!candidates.length) return { failureReason: lastFailureReason };
  if (new Set(candidates.map(({ verdict }) => verdict.status)).size > 1) {
    return { failureReason: "canonical completed assistant turn has conflicting fenced JSON verdicts" };
  }
  return candidates.at(-1)!;
}

export function stageVerdictRejectionReason(text: string): string {
  const candidate = finalVerdictCandidate(text);
  if ("failureReason" in candidate) return candidate.failureReason;
  const parsed = parseStageVerdict(text);
  return parsed && "failureReason" in parsed
    ? parsed.failureReason
    : "canonical completed assistant turn did not yield a valid final JSON verdict";
}

/** Completion authority is the last well-formed fenced JSON verdict in a completed turn. */
export function parseStageVerdict(text: string): ParsedStageVerdict | RejectedStageVerdict | null {
  const candidate = finalVerdictCandidate(text);
  if ("failureReason" in candidate) return null;
  /* Stage directives may require their own completion evidence beside the
     controller's three core fields. Persist only the bounded core verdict; the
     stage-specific evidence remains in the canonical transcript. */
  const verdict = candidate.verdict;
  const prose = text.slice(0, candidate.index).trim();
  const output = prose.slice(0, MAX_OUTPUT_CHARS);
  if (verdict.status === "pass" && verdict.findings?.length) {
    return {
      failureReason: 'contradictory stage verdict: status "pass" cannot include findings',
      output,
    };
  }
  for (const marker of proseVerdictMarkers(prose)) {
    if (PROSE_VERDICT_STATUSES[marker] !== verdict.status) {
      return {
        failureReason: `contradictory stage verdict: prose marker "${marker}" disagrees with JSON status "${verdict.status}"`,
        output,
      };
    }
  }
  return { verdict, output };
}

/** The completion a stage attempt reports for itself, as the MCP call carries
    it (graph slice 2). Deliberately three fields: everything else on the
    record — the head, the branch's pull request, the declared outputs — is
    read by the server, so nothing here can be claimed. */
export type StageCompletionInput = {
  verdict: unknown;
  findings?: unknown;
  summary?: unknown;
};

export type StageCompletionRefusal = { error: string; code: StageCompletionRefusalCode };
export type StageCompletionRefusalCode = "STAGE_REPORT_INVALID" | "STAGE_REPORT_CONTRADICTORY";
export type NormalizedStageCompletion = { verdict: StageVerdict; summary: string | null };

const STAGE_VERDICT_STATUSES: readonly StageVerdictStatus[] = ["pass", "fail", "needs_decision"];

function refusal(error: string, code: StageCompletionRefusalCode = "STAGE_REPORT_INVALID"): StageCompletionRefusal {
  return { error, code };
}

/**
 * The second input of the same form (graph slice 2). A completion call and a
 * fenced JSON verdict end in the SAME normaliser: the call's ranked findings
 * are rendered to the verdict's finding strings and handed to
 * {@link stageVerdictFrom}, which is where every bound and every contradiction
 * rule already lives. A call therefore cannot express a verdict a fenced block
 * could not, and both produce byte-identical records.
 */
export function normalizeStageCompletion(input: StageCompletionInput): NormalizedStageCompletion | StageCompletionRefusal {
  if (typeof input.verdict !== "string" || !STAGE_VERDICT_STATUSES.includes(input.verdict as StageVerdictStatus)) {
    return refusal(`verdict must be one of ${STAGE_VERDICT_STATUSES.join(", ")}`);
  }
  const status = input.verdict as StageVerdictStatus;
  const findings: StageFinding[] = [];
  if (input.findings !== undefined && input.findings !== null) {
    if (!Array.isArray(input.findings)) return refusal("findings must be an array of { severity, text }");
    if (input.findings.length > MAX_FINDINGS) return refusal(`findings must hold at most ${MAX_FINDINGS} entries`);
    for (const raw of input.findings) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return refusal("each finding must be an object { severity, text }");
      const finding = raw as Record<string, unknown>;
      const severity = finding.severity;
      if (typeof severity !== "string" || !(STAGE_FINDING_SEVERITIES as readonly string[]).includes(severity)) {
        return refusal(`each finding needs a severity of ${STAGE_FINDING_SEVERITIES.join(", ")}`);
      }
      const text = typeof finding.text === "string" ? finding.text.trim() : "";
      if (!text) return refusal("each finding needs a non-empty text");
      if (text.length > MAX_FINDING_CHARS) return refusal(`each finding text must be at most ${MAX_FINDING_CHARS} characters`);
      findings.push({ severity: severity as StageFindingSeverity, text });
    }
  }
  if (status === "pass" && findings.length > 0) {
    return refusal('contradictory stage verdict: status "pass" cannot include findings', "STAGE_REPORT_CONTRADICTORY");
  }
  /* The bound belongs to the finding as it is recorded, and that is the
     rendered `P1 — text`: a text at the schema's own bound is five characters
     longer once its rank is in front of it, and handing that to
     {@link stageVerdictFrom} would refuse the whole call over characters the
     caller never wrote. Clamp the rendering, exactly as that validator does
     when it reloads a record, so such a text is accepted and loses only its
     tail. The tool schema states this where the caller reads the bound. */
  const rendered = rankStageFindings(findings).map((finding) => stageFindingText(finding).slice(0, MAX_FINDING_CHARS));
  const verdict = stageVerdictFrom({ status, ...(rendered.length ? { findings: rendered } : {}) });
  if (!verdict) return refusal("the reported verdict is not a valid stage verdict");
  const summary = typeof input.summary === "string" ? input.summary.trim().slice(0, MAX_STAGE_REPORT_SUMMARY_CHARS) : "";
  return { verdict, summary: summary || null };
}
