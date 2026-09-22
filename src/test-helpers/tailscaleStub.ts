import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * A stand-in `tailscale` for the phone-access tests and the capture driver.
 * It is the only Tailscale they ever run: the operator's tailnet and serve
 * configuration are never touched.
 *
 * Behaviour comes from files in its own directory, so a test changes it
 * between calls without restarting anything:
 * - `status.json` is what `status --json` prints (`status.exit` makes it fail);
 * - `serve-status.json` is what `serve status --json` prints, and what a
 *   successful `serve --bg <port>` rewrites to point at that port;
 * - `serve-mode` is how `serve --bg` behaves: `ok` (default), `operator`
 *   (the operator-right refusal), `fail`, `hang` or `noverify` (exits 0 and
 *   leaves the status as it was), or `offfails` (publishes, then refuses
 *   every `serve … off`, so the mapping outlives the press), or `offlies`
 *   (`off` exits 0 and the mapping stays, so only a re-read finds it), or
 *   `stuck` (publishes a mapping to another port and refuses every `off`, the
 *   shape of a publish that took and cannot be undone), or `blind` (publishes
 *   this port, then every `serve status` is unreadable and every `off` is
 *   refused: the press cannot tell whether the mapping is still there);
 * - `calls.log` records every argv, one line per call.
 *
 * The script names its tools by absolute path, so a `PATH` holding only its
 * directory still runs it, and a `PATH` without it reads as "not installed".
 */

export type TailscaleStub = {
  dir: string;
  /** A directory that holds no `tailscale` at all. */
  emptyDir: string;
  setStatus(status: { BackendState: string; Self?: { DNSName?: string } } | null): void;
  /** Publish `/` on 443 to a loopback port, or clear it with null. */
  setServing(port: number | null): void;
  setServeMode(mode: "ok" | "operator" | "fail" | "hang" | "noverify" | "offfails" | "offlies" | "stuck" | "blind"): void;
  /** Publish `/` on 443 the way a foreground `tailscale serve <port>` does. */
  setServingForeground(port: number): void;
  calls(): string[];
  cleanup(): void;
};

export const STUB_DNS_NAME = "viewer-host.example-tailnet.ts.net";

export function serveStatusJson(port: number | null, dnsName = STUB_DNS_NAME): string {
  if (port === null) return "{}";
  return JSON.stringify({
    TCP: { "443": { HTTPS: true } },
    Web: { [`${dnsName}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
  });
}

/**
 * What `serve status --json` prints for a FOREGROUND session — the shape an
 * explicit `--tailscale` start leaves, where the top-level `Web` is empty and
 * the session holds its own map under `Foreground[<session>]`.
 */
export function foregroundServeStatusJson(port: number, dnsName = STUB_DNS_NAME): string {
  return JSON.stringify({
    Foreground: {
      "sess-fixture": {
        TCP: { "443": { HTTPS: true } },
        Web: { [`${dnsName}:443`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } },
      },
    },
  });
}

const SCRIPT = (dnsName: string) => `#!/bin/sh
here=\${0%/*}
echo "$*" >> "$here/calls.log"
if [ "$1" = "status" ]; then
  if [ -f "$here/status.exit" ]; then echo "failed to connect to local tailscaled" >&2; exit 1; fi
  /bin/cat "$here/status.json"
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "status" ]; then
  if [ -f "$here/serve-blind" ]; then echo "not json at all"; exit 0; fi
  /bin/cat "$here/serve-status.json"
  exit 0
fi
if [ "$1" = "serve" ] && [ "$2" = "--bg" ]; then
  mode=ok
  if [ -f "$here/serve-mode" ]; then mode=$(/bin/cat "$here/serve-mode"); fi
  case "$mode" in
    operator) echo "Access denied: serve config denied" >&2; exit 1 ;;
    fail) echo "error: listener already in use" >&2; exit 1 ;;
    hang) exec /bin/sleep 60 ;;
    noverify) exit 0 ;;
    stuck)
      printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${dnsName}:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}' > "$here/serve-status.json"
      exit 0 ;;
    blind)
      printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${dnsName}:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}' "$3" > "$here/serve-status.json"
      : > "$here/serve-blind"
      exit 0 ;;
  esac
  printf '{"TCP":{"443":{"HTTPS":true}},"Web":{"${dnsName}:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}' "$3" > "$here/serve-status.json"
  echo "Available within your tailnet: https://${dnsName}/"
  exit 0
fi
if [ "$1" = "serve" ] && [ "$4" = "off" ]; then
  mode=ok
  if [ -f "$here/serve-mode" ]; then mode=$(/bin/cat "$here/serve-mode"); fi
  if [ "$mode" = "offfails" ] || [ "$mode" = "stuck" ] || [ "$mode" = "blind" ]; then echo "error: cannot remove the mapping" >&2; exit 1; fi
  if [ "$mode" = "offlies" ]; then exit 0; fi
  printf '{}' > "$here/serve-status.json"
  exit 0
fi
echo "unexpected: $*" >&2
exit 2
`;

export function createTailscaleStub(options: { root?: string; dnsName?: string } = {}): TailscaleStub {
  const root = options.root ?? fs.mkdtempSync(path.join(os.tmpdir(), "llv-tailscale-stub-"));
  const dir = path.join(root, "tailscale-bin");
  const emptyDir = path.join(root, "no-tailscale-bin");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(emptyDir, { recursive: true });
  const dnsName = options.dnsName ?? STUB_DNS_NAME;
  fs.writeFileSync(path.join(dir, "tailscale"), SCRIPT(dnsName), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "calls.log"), "");
  const stub: TailscaleStub = {
    dir,
    emptyDir,
    setStatus(status) {
      fs.rmSync(path.join(dir, "status.exit"), { force: true });
      if (status === null) fs.writeFileSync(path.join(dir, "status.exit"), "1");
      else fs.writeFileSync(path.join(dir, "status.json"), JSON.stringify(status));
    },
    setServing(port) {
      fs.writeFileSync(path.join(dir, "serve-status.json"), serveStatusJson(port, dnsName));
    },
    setServingForeground(port) {
      fs.writeFileSync(path.join(dir, "serve-status.json"), foregroundServeStatusJson(port, dnsName));
    },
    setServeMode(mode) {
      fs.rmSync(path.join(dir, "serve-blind"), { force: true });
      fs.writeFileSync(path.join(dir, "serve-mode"), mode);
    },
    calls() {
      return fs.readFileSync(path.join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
    },
    cleanup() {
      if (!options.root) fs.rmSync(root, { recursive: true, force: true });
    },
  };
  stub.setStatus({ BackendState: "Running", Self: { DNSName: `${dnsName}.` } });
  stub.setServing(null);
  return stub;
}
