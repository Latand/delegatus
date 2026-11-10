import { z } from "zod";
import { textLengthError } from "./textLimits";

/** Check storage's UTF-16 metric explicitly; Zod string bounds count code points. */
export function utf16Text(max: number, min = 0, trim = false, recommended: number | null = Math.floor(max * 0.75)) {
  const text = trim ? z.string().trim() : z.string();
  return text.superRefine((value, ctx) => {
    if (value.length < min || value.length > max) ctx.addIssue({ code: "custom", message: textLengthError("", value.length, max, "UTF-16 code units", min) });
  })
    .describe(`${min}–${max} UTF-16 code units${trim ? " after trimming" : ""}. ${recommended === null ? "Preserve the exact identity." : `Recommended target: ${recommended}; the hard maximum remains ${max}.`}`)
    .meta({ ...(trim ? { "x-normalization": "trim", "x-normalized-minLength": min, "x-normalized-maxLength": max }
      : { minLength: Math.ceil(min / 2), maxLength: max }), "x-length-unit": "UTF-16 code units" });
}

/** The form store and replica reader both use Zod's Unicode code-point bounds. */
export function codePointText(max: number, min = 0, trim = false, recommended: number | null = Math.floor(max * 0.75)) {
  const text = trim ? z.string().trim() : z.string();
  return text.min(min).max(max, { error: issue => textLengthError("", typeof issue.input === "string" ? [...issue.input].length : 0, max, "Unicode code points", min) })
    .describe(`${min}–${max} Unicode code points${trim ? " after trimming" : ""}. ${recommended === null ? "Preserve the exact identity." : `Recommended target: ${recommended}; the hard maximum remains ${max}.`}`)
    .meta({ "x-length-unit": "Unicode code points", ...(trim ? { minLength: undefined, maxLength: undefined, "x-normalization": "trim", "x-normalized-minLength": min, "x-normalized-maxLength": max } : {}) });
}

/** Preserve the old raw schema bound and add the domain's normalized metric. */
export function storedUtf16Text(max: number, min: number, normalize: (value: string) => string, normalization: string) {
  return codePointText(max, min).superRefine((value, ctx) => {
    const actual = normalize(value).length;
    if (actual < min || actual > max) ctx.addIssue({ code: "custom", message: textLengthError("", actual, max, "UTF-16 code units", min) });
  }).describe(`Raw input: ${min}–${max} Unicode code points. After ${normalization}: ${min}–${max} UTF-16 code units; recommended target ${Math.floor(max * 0.75)} normalized units.`)
    .meta({ "x-length-unit": "Unicode code points", "x-normalization": normalization, "x-normalized-length-unit": "UTF-16 code units", "x-normalized-minLength": min, "x-normalized-maxLength": max });
}

/** Expose a normalized bound without rejecting valid whitespace padding. */
export function normalizedUtf16Text(max: number, normalize: (value: string) => string) {
  return z.string().superRefine((value, ctx) => {
    const actual = normalize(value).length;
    if (actual > max) ctx.addIssue({ code: "custom", message: textLengthError("", actual, max, "UTF-16 code units") });
  }).meta({ "x-length-unit": "UTF-16 code units", "x-normalized-maxLength": max });
}
