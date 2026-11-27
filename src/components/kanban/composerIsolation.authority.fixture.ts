import type { Browser, Page, Route } from "playwright-core";
import type { RuntimeEnvelope } from "@/components/runtime/runtimeModel";
import type { IsolationWindow } from "./composerIsolation.fixture";
import { openFixture, type buildEvidenceAssets } from "./issue1695BrowserHarness";

type Assets = Awaited<ReturnType<typeof buildEvidenceAssets>>;
type InstallRoutes = (page: Page, entry: string, assets: Assets, catalog: (route: Route) => Promise<void>) => Promise<void>;

export async function verifyIsolationContexts(browser: Browser, assets: Assets, origin: string, routes: InstallRoutes) {
  const contexts: Awaited<ReturnType<typeof openFixture>>[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const tab = await openFixture(browser, "about:blank", {width:1440,height:900}, "light", "en", "reduce", false, 1);
      contexts.push(tab);
      await routes(tab.page, assets.entry, assets, route => route.abort());
      await tab.page.goto(origin + "/?scenario=composer-isolation&streaming=1&seathost=30");
      await tab.page.waitForFunction(() => (window as IsolationWindow).composerIsolation?.census().connection === "live");
      const field = tab.page.locator("[data-kanban-seat] textarea[data-composer-field]:visible");
      await field.focus();
      await field.fill("retained draft");
    }
    const [writer, reader] = contexts;
    const active = writer!.page.locator("[data-kanban-seat] textarea[data-composer-field]:focus");
    await active.fill("before selection after");
    const scroll = await active.evaluate(element => {
      const field = element as HTMLTextAreaElement;
      field.setSelectionRange(7,16);
      return field.scrollTop;
    });
    const cdp = await writer!.context.newCDPSession(writer!.page);
    await cdp.send("Input.imeSetComposition", {text:"текст",selectionStart:5,selectionEnd:5});
    await writer!.page.evaluate(() => {
      const fixture = (window as IsolationWindow).composerIsolation;
      fixture.event("foreign",0,true);
      fixture.event("foreign",1,true);
    });
    await writer!.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await cdp.send("Input.insertText", {text:"текст"});
    const result = await active.evaluate(element => {
      const field = element as HTMLTextAreaElement;
      return [field.value,field.selectionStart,field.selectionEnd,field.scrollTop];
    });
    if (result[0] !== "before текст after" || result[1] !== 12 || result[2] !== 12 || result[3] !== scroll) {
      throw Error("composition did not preserve the selected range and scroll position: " + JSON.stringify(result));
    }
    await active.fill("retained draft");
    // Both independent stores receive the same journal cursor and addressed operation.
    await reader!.page.evaluate(() => {
      const fixture = (window as IsolationWindow).composerIsolation;
      fixture.event("foreign",0,true);
      fixture.event("foreign",1,true);
    });
    const receipt = await writer!.page.evaluate(() => (window as IsolationWindow).composerIsolation.ownReceipt());
    await reader!.page.evaluate(envelope => {
      const w = window as IsolationWindow & { runtimeEmit(envelope: RuntimeEnvelope): void };
      w.runtimeEmit(envelope);
    }, receipt);
    for (const { page } of contexts) {
      await page.locator("[data-kanban-seat] [data-receipts-chip], [data-kanban-seat] [data-receipt-problem-count]").first().waitFor();
      const retained = await page.evaluate(() => {
        const field = document.activeElement;
        return field instanceof HTMLTextAreaElement && field.value === "retained draft";
      });
      if (!retained) throw Error("addressed receipt lost the tab's active draft");
    }

    const page = reader!.page;
    await page.evaluate(() => { location.hash = "#f=" + encodeURIComponent((window as IsolationWindow).composerIsolation.subagentPath); });
    const controls = page.locator('[data-strip-surface="structured-subagent"]:visible').first();
    await controls.waitFor();
    await page.evaluate(() => (window as IsolationWindow).composerIsolation.rootStatus("dead"));
    await controls.waitFor({state:"hidden"});
    await page.evaluate(() => (window as IsolationWindow).composerIsolation.rootStatus("hosted"));
    await controls.waitFor();
    for (const {pageErrors} of contexts) if (pageErrors.length) throw Error(pageErrors.join("\n"));
  } finally {
    for (const {context} of contexts.reverse()) await context.close();
  }
}
