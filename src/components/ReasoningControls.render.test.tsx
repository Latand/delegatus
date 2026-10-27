import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasoningControls, speedChoiceOf } from "./ReasoningControls";

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
  expect(render({ enabled: true, reason: null })).toContain('<option value="ultrafast">ultra</option>');
  expect(render({ enabled: false, reason: null })).toContain('<option value="ultrafast" disabled="">ultra</option>');
  expect(render({ enabled: false, reason: "B doesn't offer Ultrafast for GPT-6.1-Sol (offers: Fast)" }, "ultrafast"))
    .toContain('<option value="ultrafast" disabled="" selected="">ultra — B doesn&#x27;t offer Ultrafast for GPT-6.1-Sol (offers: Fast)</option>');
});

test("a successor's draft opens on the incumbent's applied speed", () => {
  expect(speedChoiceOf({ engine: "codex", serviceTier: "ultrafast", fast: true })).toBe("ultrafast");
  expect(speedChoiceOf({ engine: "codex", serviceTier: "priority", fast: true })).toBe("fast");
  expect(speedChoiceOf({ engine: "codex", serviceTier: null, fast: true })).toBe("fast");
  expect(speedChoiceOf({ engine: "codex", serviceTier: "default", fast: false })).toBe("");
  expect(speedChoiceOf({ engine: "claude", serviceTier: "ultrafast", fast: true })).toBe("");
  expect(speedChoiceOf(null)).toBe("");
});
