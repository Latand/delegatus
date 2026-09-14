import { viewerControlOrigin, viewerControlToken } from "@/lib/mcp/controlEndpoint";

type PipelineTick = () => Promise<void>;
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface PipelineSignalState {
  tick: PipelineTick | null;
  scheduled: boolean;
}

const signalHost = globalThis as typeof globalThis & {
  __llvPipelineSignal?: PipelineSignalState;
};

/** The tick a process without an in-process controller sends after it changes
    a pipeline — the Viewer MCP server, the runtime host. It resolves its Viewer
    and credential the way every other Viewer control request does (#1685):
    agents are launched without LLV_VIEWER_CONTROL_URL, so reading only that
    sent a staging agent's tick to the production port, and a Viewer with a
    token refused the bare request unless a trusted local entry vouched for it. */
export async function requestRemotePipelineTick(
  fetcher: Fetcher = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const baseUrl = viewerControlOrigin(env);
  const credential = viewerControlToken(env, baseUrl);
  const response = await fetcher(new URL("/api/pipelines/tick", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    body: "{}",
  });
  if (!response.ok) throw new Error(`pipeline controller request failed with status ${response.status}`);
}

async function defaultPipelineTick(): Promise<void> {
  await requestRemotePipelineTick();
}

const signal = signalHost.__llvPipelineSignal ??= { tick: defaultPipelineTick, scheduled: false };

export function registerPipelineTick(tick: PipelineTick): () => void {
  const previous = signal.tick;
  signal.tick = tick;
  return () => {
    if (signal.tick === tick) signal.tick = previous;
  };
}

export function requestPipelineTick(): void {
  if (signal.scheduled || signal.tick === null) return;
  signal.scheduled = true;
  queueMicrotask(() => {
    signal.scheduled = false;
    const tick = signal.tick;
    if (tick === null) return;
    void tick().catch((error) => {
      console.error("[pipeline controller] requested tick failed", error);
    });
  });
}
