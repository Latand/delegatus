const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export function fmtBytes(n: number): string {
  if (n >= 10 * GIB) return Math.round(n / GIB) + " GiB";
  if (n >= GIB) return (n / GIB).toFixed(1) + " GiB";
  return Math.max(0, Math.round(n / MIB)) + " MiB";
}
