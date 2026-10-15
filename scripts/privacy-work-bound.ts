// CPU samples exclude descheduling and fixture writes. Pair the same cache
// conditions at both sizes: the first source prepares bytes, later sources
// reuse that preparation while applying their own known-value configuration.
export function measurePrivacyWork<T>(scan: () => T): { cpu: number; value: T } {
  const start = process.cpuUsage();
  const value = scan();
  const used = process.cpuUsage(start);
  return { cpu: used.user + used.system, value };
}

export function assertPrivacyWorkBound(small: number[], large: number[], source: string): void {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  if (small.length !== 3 || large.length !== 3 || [...small, ...large].some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`${source}: missing CPU scaling samples`);
  }
  const ratio = median(large) / median(small);
  // Inputs grow 8x. Allow 4x overhead over linear growth, below quadratic's
  // 64x. No wall-clock duration or absolute CPU ceiling decides this verdict.
  if (ratio >= 32) throw new Error(`${source}: privacy CPU growth ${ratio.toFixed(2)}x exceeds 32x for 8x input`);
}
