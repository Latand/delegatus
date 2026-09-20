/**
 * The dead-host copy must be TRUTHFUL in both locales.
 *
 * It has been wrong twice in opposite directions. It first said "Messages
 * can't be delivered", which promised less than the product did; it was then
 * repaired into a promise that text goes now and images wait for a manual
 * recovery — which is what the composer used to do, and is no longer true.
 * Sending admits the WHOLE message, text and attachment bytes under one key,
 * and the send itself starts the agent again. The banner's controls became
 * what they always should have been: optional.
 *
 * These tests pin the facts the copy must state, per locale:
 *   1. the whole message is saved first, text and images together,
 *   2. sending starts the agent again and delivers,
 *   3. the controls below are optional, never a precondition,
 *   4. the recovery controls are all still reachable.
 */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n";

import { DeadHostBannerView } from "./DeadHostBanner";

const LOCALES = ["en", "uk"] as const;

/** Semantic markers per locale: stems that must (or must not) appear so the
    copy states each fact without the test hard-coding one exact phrasing. */
const FACTS = {
  en: {
    wholeMessage: /text and images together/i,
    resumes: /started again/i,
    optional: /optional/i,
    falseClaims: [
      /can[’']t be delivered/i, /cannot be delivered/i,
      /can[’']t be attached/i, /cannot be attached/i,
      /messages will queue/i,
    ],
  },
  uk: {
    wholeMessage: /і текст, і зображення/i,
    resumes: /запускається знову/i,
    optional: /необовʼязков/i,
    falseClaims: [/не доставляються/i, /не можна додати/i, /підуть у чергу/i],
  },
} as const;

for (const locale of LOCALES) {
  test(`the ${locale} dead-host banner body promises the whole message, the resume, and optional controls`, () => {
    const body = translate(locale, "deadHost.body");
    const facts = FACTS[locale];
    expect(body).toMatch(facts.wholeMessage);
    expect(body).toMatch(facts.resumes);
    expect(body).toMatch(facts.optional);
    for (const falseClaim of facts.falseClaims) expect(body).not.toMatch(falseClaim);
  });

  test(`the ${locale} dead-host title does not make the operator queue behind a restore`, () => {
    const title = translate(locale, "deadHost.title");
    for (const falseClaim of FACTS[locale].falseClaims) expect(title).not.toMatch(falseClaim);
  });

  test(`the ${locale} banner stays one compact row with all three recovery controls`, () => {
    const t: Parameters<typeof DeadHostBannerView>[0]["t"] = (key, params) => translate(locale, key, params);
    const html = renderToStaticMarkup(
      <DeadHostBannerView t={t} sinceLabel="5m" onRespawn={() => {}} onAttach={() => {}} onRecheck={() => {}} />,
    );
    // The explainer body is gone (compact-feed pass): the title states the
    // queueing contract and every control stays reachable.
    const body = translate(locale, "deadHost.body");
    const escapeFree = (value: string) => value.split(/[&<>'’]/)[0]!.trim();
    expect(html).not.toContain(escapeFree(body));
    for (const control of ["deadHost.respawn", "deadHost.attach", "deadHost.recheck"] as const) {
      expect(html).toContain(translate(locale, control));
    }
  });
}
