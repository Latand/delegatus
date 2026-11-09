export type TextLengthUnit = "UTF-16 code units" | "Unicode code points" | "normalized Unicode code points" | "UTF-8 bytes";

/** Keep the measured value in the refusal so its author can correct one call. */
export function textLengthError(field: string, actual: number, max: number, unit: TextLengthUnit, min = 0): string {
  return `${field} must be ${min ? `${min}–${max}` : `at most ${max}`} ${unit}; actual length is ${actual}. Provide a complete value within the limit and retry. Never truncate identity, guards or provenance.`;
}
