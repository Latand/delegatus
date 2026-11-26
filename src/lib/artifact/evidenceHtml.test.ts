import { expect, test } from "bun:test";
import { containEvidenceHtml } from "./evidenceHtml";

test("evidence HTML keeps presentation and local assets while removing navigation and script execution", () => {
  const source = `<!doctype html><html><head>
    <link rel="stylesheet" href="chart.css">
    <meta http-equiv="refresh" content="0;url=https://outside.invalid/redirect">
    <meta http-equiv="re&#x66;resh" content="0;url=https://outside.invalid/entity-refresh">
    <base target="_self" href="https://outside.invalid/">
    <script>location.href = "https://outside.invalid/script"</script>
  </head><body><h1>Disk report</h1><img src="chart.png">
    <a href="https://outside.invalid/link" target="_self" ping="https://outside.invalid/ping">leave</a>
    <area href='https://outside.invalid/area' attributionsrc='https://outside.invalid/attribution'>
    <svg><a xlink:href="https://outside.invalid/svg">svg</a></svg>
  </body></html>`;
  const result = containEvidenceHtml(source);
  expect(result).toContain('href="chart.css"');
  expect(result).toContain('src="chart.png"');
  expect(result).toContain("Disk report");
  for (const destination of ["refresh", "outside.invalid", "location.href", "target=", "ping=", "attributionsrc="]) {
    expect(result).not.toContain(destination);
  }
});

test("quoted greater-than signs do not terminate an HTML tag during containment", () => {
  expect(containEvidenceHtml('<a title="x > y" href="https://outside.invalid">report</a>'))
    .toBe('<a title="x > y" >report</a>');
});

test("an optional scoped base is inserted after untrusted base elements are removed", () => {
  const result = containEvidenceHtml('<html><head><base href="https://outside.invalid"></head><body><img src="chart.png"></body></html>', "http://localhost:8898/api/artifact/frame/signed/");
  expect(result).toContain('<head><base href="http://localhost:8898/api/artifact/frame/signed/">');
  expect(result).not.toContain("outside.invalid");
});
