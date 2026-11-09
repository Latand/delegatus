import { z } from "zod";
import { textLengthError } from "./textLimits";

/** Existing JS string limits use UTF-16, including two units per astral scalar. */
export function utf16Text(max: number, min = 0, trim = false, recommended: number | null = Math.floor(max * 0.75)) {
  const text = trim ? z.string().trim() : z.string();
  return text.min(min).max(max, { error: issue => textLengthError("text", typeof issue.input === "string" ? issue.input.length : 0, max, "UTF-16 code units", min) })
    .describe(`${min}–${max} UTF-16 code units${trim ? " after trimming" : ""}. ${recommended === null ? "Preserve the exact identity." : `Recommended target: ${recommended}; the hard maximum remains ${max}.`}`)
    .meta({ "x-length-unit": "UTF-16 code units" });
}

/** Expose a normalized bound without rejecting valid whitespace padding. */
export function normalizedUtf16Text(max: number, normalize: (value: string) => string) {
  return z.string().superRefine((value, ctx) => {
    const actual = normalize(value).length;
    if (actual > max) ctx.addIssue({ code: "custom", message: textLengthError("text", actual, max, "UTF-16 code units") });
  }).meta({ "x-length-unit": "UTF-16 code units", "x-normalized-maxLength": max });
}
