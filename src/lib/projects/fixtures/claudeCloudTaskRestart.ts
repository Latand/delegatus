import { prepareClaudeCloudTask } from "../claudeCloudTasks";
import { createClaudeCloudTaskProvider } from "@/lib/pipelines/cloudClaudeClient";

const input = JSON.parse(await Bun.stdin.text());
const provider = createClaudeCloudTaskProvider({ now: () => input.now,
  readLogin: async () => ({ accessToken: "fixture", organization: "org-fixture", expiresAt: 0 }),
  fetch: ((target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof target === "string" || target instanceof URL ? target : target.url);
    return fetch(new URL(url.pathname + url.search, input.origin), init);
  }) as typeof fetch });
const result = await prepareClaudeCloudTask({ project: input.project, account: input.account, repository: "sample/project", ref: "main",
  now: () => input.now, signal: new AbortController().signal, assertCurrent: () => {}, force: input.force }, provider);
process.stdout.write(JSON.stringify(result));
