/** Shared by memory parsing and MCP schemas without loading the scanner. */
export const MEMORY_KINDS = ["preference", "project_fact", "reference", "failure", "instruction", "skill"] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];
