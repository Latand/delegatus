/** Count Unicode code points, matching the external relay's character limit. */
export function prototypeTextLength(value: string): number {
  return [...value].length;
}
