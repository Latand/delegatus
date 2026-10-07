/* An owner census for drain tests that model what each journal row's
   conversation is, as the production reader would report it
   (docs/design/update-drain-liveness.md). */
import type { OwnerReading, QuietPorts } from "./quiet";

/** A conversation `read` calls `alive` has a live host running a turn, one it
    calls `gone` has a host whose process is gone, and one it calls
    `unresolved` names nothing the registry knows. A stage reference the rows
    do not name is owned by a live process unless `read` says otherwise. */
export function owners(read: (conversationId: string | undefined) => "alive" | "gone" | "unresolved" = () => "alive"): NonNullable<QuietPorts["owners"]> {
  const owner = (id: string | null | undefined, process: "alive" | "gone"): OwnerReading => ({ id: `owner:${id}`, binding: id ?? null,
    artifactPath: null, entryKey: null, engine: "codex", cwd: null, role: "host", process, tail: { turn: "busy", lastRecordAt: null } });
  return async (sessions) => {
    const found = sessions.filter((session) => read(session.conversationId) !== "unresolved")
      .map((session) => owner(session.conversationId, read(session.conversationId) === "gone" ? "gone" : "alive"));
    return {
      owners: found,
      ownerless: [],
      bound: (reference) => {
        const bound = found.filter((item) => item.binding === reference.conversationId);
        return bound.length || read(reference.conversationId ?? undefined) !== "alive" ? bound : [owner(reference.conversationId, "alive")];
      },
      names: (reference) => read(reference.conversationId ?? undefined) !== "unresolved",
      tail: async () => null,
    };
  };
}
