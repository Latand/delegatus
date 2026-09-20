const SECRET_KEYWORD_RE =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token)/i;
const SECRET_VALUE_RE =
  /([\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|bearer|secret|password|passwd|pwd|token))\b(\s*[:=]\s*)(["']?)[^\s"',}]+/gi;

export function redactSecrets(text: string): string {
  if (!SECRET_KEYWORD_RE.test(text)) return text;
  return text.replace(SECRET_VALUE_RE, (_whole, key: string, sep: string, quote: string) => `${key}${sep}${quote}[redacted]`);
}
