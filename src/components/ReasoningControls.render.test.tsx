import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { effortTierLabel } from "@/components/builderCopy";
import { effortScale } from "@/lib/agent/efforts";
import { translate } from "@/lib/i18n";
import { ReasoningControls } from "./ReasoningControls";

for (const model of ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna"]) {
  test(`launch reasoning selector follows ${model}`, () => {
    const html = renderToStaticMarkup(<ReasoningControls engine="codex" model={model} effort="max" speed="" onModel={() => {}} onEffort={() => {}} onSpeed={() => {}} />);
    expect(html).toContain('value="max" selected=""');
    expect(html.includes('value="ultra"')).toBe(!model.endsWith("-luna"));
  });
}

test("the speed select offers ultrafast only with the launch account's answer, and its reason in the option text", () => {
  const render = (ultra: { enabled: boolean; reason: string | null } | null, speed: "" | "ultrafast" = "") => renderToStaticMarkup(
    <ReasoningControls engine="codex" model="gpt-6.1-sol" effort="" speed={speed} ultra={ultra} onModel={() => {}} onEffort={() => {}} onSpeed={() => {}} />);
  expect(render(null)).not.toContain('value="ultrafast"');
  expect(render({ enabled: true, reason: null })).toContain('<option value="ultrafast">ultrafast</option>');
  expect(render({ enabled: false, reason: null })).toContain('<option value="ultrafast" disabled="">ultrafast</option>');
  expect(render({ enabled: false, reason: "B doesn't offer Ultrafast for GPT-6.1-Sol (offers: Fast)" }, "ultrafast"))
    .toContain('<option value="ultrafast" disabled="" selected="">ultrafast — B doesn&#x27;t offer Ultrafast for GPT-6.1-Sol (offers: Fast)</option>');
});

test("a rotation's empty speed choice says the incumbent's tier carries over; a new launch's says default", () => {
  const render = (inheritSpeed: boolean) => renderToStaticMarkup(
    <ReasoningControls engine="codex" model="gpt-6.1-sol" effort="" speed="" inheritSpeed={inheritSpeed} onModel={() => {}} onEffort={() => {}} onSpeed={() => {}} />);
  expect(render(true)).toContain(`<option value="" selected="">${translate("en", "draft.speedInherited")}</option>`);
  expect(render(false)).toContain(`<option value="" selected="">${translate("en", "draft.speedDefault")}</option>`);
});

test("the ultrafast speed option never reads like a reasoning option beside it, in either language", () => {
  for (const locale of ["en", "uk"] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    const efforts = [t("draft.effortDefault"), ...effortScale("codex", "gpt-6.1-sol")!.map((tier) => effortTierLabel(t, tier))];
    expect(efforts).not.toContain(t("draft.speedUltra"));
  }
});
