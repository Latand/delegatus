/** Bounded typo hints only. The writer still requires an exact active id. */
export function closestReadableRuleIds(input: string, readable: readonly string[]): string[] {
  if (input.length < 16 || input.length > 20) return [];
  const target = input.toLowerCase();
  const distance = (id: string) => {
    let previous = Array.from({ length: id.length + 1 }, (_, n) => n);
    for (let i = 1; i <= target.length; i++) {
      const current = [i];
      for (let j = 1; j <= id.length; j++) current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(target[i - 1] !== id[j - 1]));
      previous = current;
    }
    return previous[id.length];
  };
  const ranked = [...new Set(readable)].map(id => ({ id, distance: distance(id) }))
    .filter(match => match.distance <= 2).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  return ranked.filter(match => match.distance === ranked[0].distance).slice(0, 3).map(match => match.id);
}
