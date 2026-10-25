/** One stable future date for agent-create fixtures, independent of file order. */
export function withTaskDue<T extends object>(input: T): T & { dueAt: string } {
  return { dueAt: "2099-01-01T12:00:00.000Z", ...input };
}
