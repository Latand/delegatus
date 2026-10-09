export function isRelayConversationDir(name: string): boolean {
  return /(?:^|-)llv-relay-conv-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name);
}
