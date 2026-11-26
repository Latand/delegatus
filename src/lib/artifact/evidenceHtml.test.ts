import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { containEvidenceHtml, transformEvidenceHtml } from "./evidenceHtml";

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

test("browser-style tree construction removes navigation recovered from malformed markup", () => {
  const result = containEvidenceHtml('<!doctype html><a href="https://outside.invalid" <p>Visible report</p><meta http-equiv="re&#x66;resh" content="0;url=https://outside.invalid">');
  const window = new Window();
  try {
    const document = new window.DOMParser().parseFromString(result, "text/html");
    expect(document.doctype?.name).toBe("html");
    expect(document.querySelector("a[href], meta[http-equiv=refresh]")).toBeNull();
    expect(document.body.textContent).toContain("Visible report");
  } finally { window.happyDOM.abort(); }
});

test("serialization preserves doctype, optional head documents, CSS raw text and local assets", () => {
  for (const source of [
    '<!doctype html><html><head><style>.x::before { content: "<body>" }</style></head><body><img src="chart.png"></body></html>',
    '<!doctype html><h1>Report without an explicit head</h1><img src="chart.png">',
  ]) {
    const result = containEvidenceHtml(source);
    const window = new Window();
    try {
      const document = new window.DOMParser().parseFromString(result, "text/html");
      expect(document.doctype?.name).toBe("html");
      expect(document.body.textContent).toContain(source.includes("Report without") ? "Report without an explicit head" : "");
      expect(document.querySelector("img")?.getAttribute("src")).toBe("chart.png");
      if (source.includes("content:")) expect(document.querySelector("style")?.textContent).toContain('content: "<body>"');
    } finally { window.happyDOM.abort(); }
  }
});

test("a generated base is inserted into the parsed head using the verified authority", () => {
  const result = containEvidenceHtml('<!-- <head>sample marker</head> --><!doctype html><img src="chart.png">', "http://[::1]:8898/api/artifact/frame/grant/");
  const window = new Window();
  try {
    const document = new window.DOMParser().parseFromString(result, "text/html");
    expect(document.doctype?.name).toBe("html");
    expect(document.head.querySelector("base")?.getAttribute("href")).toBe("http://[::1]:8898/api/artifact/frame/grant/");
    expect(document.body.querySelector("img")?.getAttribute("src")).toBe("chart.png");
  } finally { window.happyDOM.abort(); }
});

test("IPv6 fallback inlines only admitted local chart bytes", () => {
  const result = transformEvidenceHtml('<img src="chart.png"><img src="//outside.invalid/leak.png">', undefined,
    new Map([["chart.png", "data:image/png;base64,AA=="]]));
  const window = new Window();
  try {
    const document = new window.DOMParser().parseFromString(result, "text/html");
    expect(document.querySelectorAll("img")[0]?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(document.querySelectorAll("img")[1]?.hasAttribute("src")).toBe(false);
  } finally { window.happyDOM.abort(); }
});
