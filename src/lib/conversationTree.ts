import type { FileEntry } from "@/lib/types";

type ConversationTreeRow = Pick<FileEntry, "path" | "project" | "kind" | "parent" | "nativeThreadId" | "nativeParentThreadId" | "nativeForkSourceThreadId" | "conversationId">;

export interface ConversationBranch<Row extends ConversationTreeRow = FileEntry> {
  file: Row;
  children: ConversationBranch<Row>[];
}

/** Group the currently loaded catalog pages using recorded relationships. */
export function conversationTree<Row extends ConversationTreeRow>(files: readonly Row[]): ConversationBranch<Row>[] {
  const byPath = new Map(files.map((file): [string, ConversationBranch<Row>] => [file.path, { file, children: [] }]));
  const byThread = new Map<string, Row>();
  for (const file of files) {
    const thread = file.nativeThreadId?.toLowerCase();
    if (thread && !byThread.has(thread)) byThread.set(thread, file);
  }

  const parents = new Map<string, string>();
  const roots: ConversationBranch<Row>[] = [];
  for (const branch of byPath.values()) {
    const { file } = branch;
    const thread = file.nativeParentThreadId ?? file.nativeForkSourceThreadId;
    const parentPath = file.parent && byPath.has(file.parent) ? file.parent : thread && byThread.get(thread.toLowerCase())?.path;
    const parent = parentPath ? byPath.get(parentPath) : undefined;
    if (!parent || parent === branch || parent.file.project !== file.project ||
        (file.conversationId && file.conversationId === parent.file.conversationId)) {
      roots.push(branch);
      continue;
    }
    // A corrupt edge must never hide its entire branch or recurse forever.
    let ancestor: string | undefined = parent.file.path;
    while (ancestor && ancestor !== file.path) ancestor = parents.get(ancestor);
    if (ancestor === file.path) {
      roots.push(branch);
      continue;
    }
    parents.set(file.path, parent.file.path);
    parent.children.push(branch);
  }
  for (const branch of byPath.values()) {
    // Desktop side chats have titles and a reader of their own. Show them
    // ahead of raw CLI subagent traces when both hang off the same parent.
    branch.children.sort((a, b) => Number(a.file.kind === "subagent") - Number(b.file.kind === "subagent"));
  }
  return roots;
}
