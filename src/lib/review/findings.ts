import { countFindingBlocks, parseReview, reviewVerdict } from "@/lib/review";
import type { ReviewVerdict } from "./types";

export interface ParsedFindings {
  verdict: ReviewVerdict;
  findingsCount: number;
  content: string;
}

export function normalizeFindings(verdict: ReviewVerdict, markdown: string): string {
  const body = markdown.replace(/^\s*VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*$/im, "").trim();
  return `VERDICT: ${verdict}\n${body ? "\n" + body + "\n" : "\n"}`;
}

export function parseFindings(text: string): ParsedFindings | null {
  const verdict = reviewVerdict(text);
  if (!verdict) return null;
  const review = parseReview(text, null);
  const structured = review?.findings.length ?? 0;
  // A requested-changes round always names something; when the reviewer's prose
  // escapes the structured contract, fall back to counting blocks so the board
  // never badges it as zero findings (#930).
  const findingsCount = structured > 0 || verdict !== "REQUEST_CHANGES" ? structured : countFindingBlocks(text);
  return {
    verdict,
    findingsCount,
    content: normalizeFindings(verdict, text),
  };
}
