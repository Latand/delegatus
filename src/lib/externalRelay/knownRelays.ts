/**
 * The relay services this install offers a one-button connection to. The
 * origin of each is an internal detail of the product: nobody types it, and
 * when a service moves it changes here, in one line. The service's own
 * descriptor supplies its description and icon at runtime (`knownRelayInfo`);
 * `name` is what the button says until, and unless, it does.
 */
export type KnownRelay = {
  id: string;
  name: string;
  origin: string;
  /** Hosts, besides the origin itself, where the service's verify channel lives; a pairing page may open there on its own. */
  verifyHosts?: readonly string[];
};

export const KNOWN_RELAYS: readonly KnownRelay[] = [
  { id: "celestia", name: "Celestia", origin: "https://chatmoderator.botfather.dev", verifyHosts: ["t.me"] },
];

/**
 * Whether a verify link may be opened without a click on it: an `https:` page
 * on the relay's own origin or on a host the built-in list names for its
 * verify channel. A relay that is not in the list has only its own origin.
 */
export function verifyUrlAllowed(origin: string, verifyHosts: readonly string[] | undefined, value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    if (url.origin === new URL(origin).origin) return true;
    return (verifyHosts ?? []).includes(url.hostname) && url.port === "";
  } catch { return false; }
}

/** What the settings surface shows for a known relay: the list entry plus whatever its descriptor told. */
export type KnownRelayInfo = KnownRelay & {
  description: string | null;
  iconUrl: string | null;
};

export function knownRelay(id: string): KnownRelay | null {
  return KNOWN_RELAYS.find((relay) => relay.id === id) ?? null;
}

/**
 * The icon the descriptor names, kept only when it is a file on the relay's
 * own origin. A descriptor advertising `http://` for its own host (as a
 * service does before it has a certificate) is read as the same path over the
 * origin's scheme; any other host is dropped, so the icon never makes the
 * browser contact a third party.
 */
export function ownOriginIcon(origin: string, icon: unknown): string | null {
  if (typeof icon !== "string") return null;
  try {
    const base = new URL(origin);
    const url = new URL(icon, base);
    if (url.hostname !== base.hostname || url.port !== base.port) return null;
    if (url.username || url.password) return null;
    return `${base.origin}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** A list entry with what its descriptor said; a descriptor that could not be read leaves the entry as listed. */
export function knownRelayInfo(
  relay: KnownRelay,
  descriptor: { description?: string; icon_url?: string | null } | null,
): KnownRelayInfo {
  return {
    ...relay,
    description: descriptor?.description || null,
    iconUrl: ownOriginIcon(relay.origin, descriptor?.icon_url),
  };
}
