import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom } from "@/test-helpers/onboardingDom";

/* Task d7759de2: a removal drops the account's project bindings, so the
   project's account strip reads them again at once; it used to keep naming
   the account until the page reloaded. */

installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { resetEngineAccountsStoresForTests, useEngineAccounts } = await import("@/hooks/useEngineAccounts");
const { ProjectAccounts } = await import("./ProjectAccounts");

const realFetch = globalThis.fetch;
let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  globalThis.fetch = realFetch;
  resetEngineAccountsStoresForTests();
});

const accountRow = (id: string, label: string) => ({ id, label, kind: id === "default" ? "legacy" : "managed", authPresent: true, auth: { state: "authenticated" }, loginPending: false, loginState: "authenticated", deviceAuth: null });

test("removing an account makes the project strip read its bindings again", async () => {
  resetEngineAccountsStoresForTests();
  let removed = false;
  let bindingReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/accounts") {
      return new Response(JSON.stringify({
        claude: { active: "work", accounts: [...(removed ? [] : [accountRow("default", "Main")]), accountRow("work", "Work")] },
        codex: { active: "default", accounts: [] },
      }));
    }
    if (url === "/api/accounts/claude" && init?.method === "DELETE") {
      removed = true;
      return new Response(JSON.stringify({ removed: { id: "default" }, hidden: { home: "/fixture/.claude" }, cleanupPending: false, moved: { archive: null, files: 0, bytes: 0 } }));
    }
    if (url.startsWith("/api/account-project-bindings")) {
      bindingReads += 1;
      const allowed = removed ? [{ accountId: "work", label: "Work" }] : [{ accountId: "default", label: "Main" }, { accountId: "work", label: "Work" }];
      return new Response(JSON.stringify({ project: "repo-fixture", engines: { claude: { restricted: true, allowed, carrying: [], outsidePool: [] } } }));
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  let remove: ((id: string) => Promise<boolean>) | null = null;
  function Harness() {
    remove = useEngineAccounts("claude").remove;
    return <ProjectAccounts project="repo-fixture" />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<Harness />));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(bindingReads).toBe(1);
  expect(host.querySelector("[data-project-accounts]")).not.toBeNull();

  await act(async () => { await remove!("default"); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

  expect(bindingReads).toBe(2);
  expect(host.querySelector("[data-project-accounts]")).not.toBeNull();
});
