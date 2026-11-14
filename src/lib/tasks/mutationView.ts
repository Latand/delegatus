import type { BoardTask } from "./types";
import type { SeatHolding } from "./commands";

export type TaskSeatReader = ((task: BoardTask) => SeatHolding) & {
  references?: (project: string) => readonly string[];
};

/** A command can name its inputs before an array reader asks for history.
 * The store owns these views for one synchronous, leased transaction only. */
export interface TaskMutationView {
  get(id: string): BoardTask | null;
  boardCount(project: string, now: number, members?: (task: BoardTask) => boolean, seat?: TaskSeatReader): number;
  completedFinding(project: string, key: string): BoardTask[];
  finding(project: string, key: string): BoardTask[];
  replace(task: BoardTask): BoardTask[];
}

const owner = globalThis as typeof globalThis & { __delegatusTaskMutationViewsV1?: WeakMap<BoardTask[], TaskMutationView> };
const views = owner.__delegatusTaskMutationViewsV1 ??= new WeakMap<BoardTask[], TaskMutationView>();

export function taskMutationView(tasks: BoardTask[]): TaskMutationView | undefined {
  return views.get(tasks);
}

/** Read a named row inside a mutation without turning an authorization or
 * acknowledgement lookup into a history traversal. Ordinary arrays keep the
 * pure command contract used by adapters and tests. */
export function readMutationTask(tasks: BoardTask[], id: string): BoardTask | undefined {
  const view = views.get(tasks);
  return view ? view.get(id) ?? undefined : tasks.find(task => task.id === id);
}

/** Full-array callers retain the ordinary reader contract. Commands use the
 * keyed view without resolving the array at all. */
export function lazyTaskMutationView(read: () => BoardTask[], view: TaskMutationView, onArrayWrite: () => void): BoardTask[] {
  let rows: BoardTask[] | undefined;
  const resolve = () => {
    return rows ??= read();
  };
  const tasks = new Proxy<BoardTask[]>([], {
    get: (_target, key) => Reflect.get(resolve(), key),
    set: (_target, key, value) => { onArrayWrite(); views.delete(tasks); return Reflect.set(resolve(), key, value); },
    has: (_target, key) => Reflect.has(resolve(), key),
    ownKeys: () => Reflect.ownKeys(resolve()),
    getOwnPropertyDescriptor: (_target, key) => Reflect.getOwnPropertyDescriptor(resolve(), key),
    deleteProperty: (_target, key) => { onArrayWrite(); views.delete(tasks); return Reflect.deleteProperty(resolve(), key); },
    defineProperty: (_target, key, descriptor) => { onArrayWrite(); views.delete(tasks); return Reflect.defineProperty(resolve(), key, descriptor); },
  });
  views.set(tasks, view);
  return tasks;
}
