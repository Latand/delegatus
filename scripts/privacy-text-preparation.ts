type NormalizedText = { compact: string; error: boolean; exactSearchable: string; searchable: string };
type PreparedText = {
  normalized: NormalizedText;
  known: NormalizedText;
  // These detections depend only on publication text and the fixed public
  // catalog. Per-inspector known-value configuration remains uncached.
  staticFindings?: readonly string[];
};

// Preparation depends on publication bytes and the fixed public catalog;
// known-value configuration is applied afterwards by each inspector. Keep at
// most two large inputs and a separate small-input cache (4096 entries, four
// million characters) so repeated views/configurations reuse normalization and
// raw ownership graphs without retaining a growing corpus.
const recent = new Map<string, PreparedText>();
const small = new Map<string, PreparedText>();
let smallCharacters = 0;

export function preparedPrivacyText(text: string, prepare: () => PreparedText): PreparedText {
  if (text.length < 100_000) {
    const cached = small.get(text);
    if (cached) return cached;
    const result = prepare();
    while (small.size >= 4096 || smallCharacters + text.length > 4_000_000) {
      const oldest = small.keys().next().value!;
      small.delete(oldest);
      smallCharacters -= oldest.length;
    }
    small.set(text, result);
    smallCharacters += text.length;
    return result;
  }
  if (text.length > 4_000_000) return prepare();
  const cached = recent.get(text);
  if (cached) return cached;
  const result = prepare();
  if (recent.size === 2) recent.delete(recent.keys().next().value!);
  recent.set(text, result);
  return result;
}
