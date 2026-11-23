import { expect, test } from "bun:test";
import { officeXmlText } from "./officeDocuments";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const A = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const lines = (name: string, xml: string) => officeXmlText(name, Buffer.from(xml))!.split("\n");

test.each([
  ["word/document.xml", `<w:document ${W}><w:body><w:p><w:r><w:t>Alpha</w:t></w:r><w:r><w:t>Beta</w:t></w:r></w:p><w:p><w:r><w:t>Gamma</w:t></w:r></w:p></w:body></w:document>`,
    `<w:document ${W}>\n  <w:body>\n    <w:p>\n      <w:r>\n        <w:t>Alpha</w:t>\n      </w:r>\n      <w:r>\n        <w:t>Beta</w:t>\n      </w:r>\n    </w:p>\n    <w:p>\n      <w:r><w:t>Gamma</w:t></w:r>\n    </w:p>\n  </w:body>\n</w:document>`],
  ["xl/worksheets/sheet1.xml", `<worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>Alpha</t></r><r><t>Beta</t></r></is></c><c r="B1" t="inlineStr"><is><t>Gamma</t></is></c></row></sheetData></worksheet>`,
    `<worksheet ${S}>\n\t<sheetData>\n\t\t<row r="1">\n\t\t\t<c r="A1" t="inlineStr">\n\t\t\t\t<is>\n\t\t\t\t\t<r>\n\t\t\t\t\t\t<t>Alpha</t>\n\t\t\t\t\t</r>\n\t\t\t\t\t<r>\n\t\t\t\t\t\t<t>Beta</t>\n\t\t\t\t\t</r>\n\t\t\t\t</is>\n\t\t\t</c>\n\t\t\t<c r="B1" t="inlineStr"><is><t>Gamma</t></is></c>\n\t\t</row>\n\t</sheetData>\n</worksheet>`],
  ["ppt/slides/slide1.xml", `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Alpha</a:t></a:r><a:r><a:t>Beta</a:t></a:r></a:p><a:p><a:r><a:t>Gamma</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    `<p:sld ${A}>\r\n  <p:cSld><p:spTree><p:sp><p:txBody>\r\n    <a:p>\r\n      <a:r><a:t>Alpha</a:t></a:r>\r\n      <a:r><a:t>Beta</a:t></a:r>\r\n    </a:p>\r\n    <a:p><a:r><a:t>Gamma</a:t></a:r></a:p>\r\n  </p:txBody></p:sp></p:spTree></p:cSld>\r\n</p:sld>`],
] as const)("%s yields the same logical text whatever the indentation between runs", (name, compact, indented) => {
  expect(lines(name, indented)).toEqual(lines(name, compact));
  // Runs join into one word; paragraphs and cells stay on separate lines.
  expect(lines(name, compact)).toContain("AlphaBeta");
  expect(lines(name, compact)).toContain("Gamma");
  expect(lines(name, compact).some(line => line.includes("BetaGamma"))).toBe(false);
});

test("preserved spaces stay inside the text while unpreserved whitespace-only runs vanish in one reading", () => {
  const xml = `<w:document ${W}><w:body><w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:r><w:t> </w:t></w:r><w:r><w:t>Beta</w:t></w:r></w:p></w:body></w:document>`;
  const text = lines("word/document.xml", xml);
  expect(text).toContain("Alpha  Beta");
  expect(text).toContain("Alpha Beta");
});

test.each([
  ["unclosed element", `<w:document ${W}><w:body>`],
  ["unbound prefix", "<x:root/>"],
  ["document type", "<!DOCTYPE root><root/>"],
  ["undeclared entity", "<root>&secret;</root>"],
  ["invalid UTF-8", Buffer.from([0x3c, 0x72, 0x3e, 0xc0, 0x3c, 0x2f, 0x72, 0x3e])],
  ["mismatched declared encoding", '<?xml version="1.0" encoding="windows-1252"?><root/>'],
  ["deep nesting", "<a>".repeat(300) + "</a>".repeat(300)],
] as const)("%s cannot be inspected and throws", (_label, xml) => {
  expect(() => officeXmlText("part.xml", typeof xml === "string" ? Buffer.from(xml) : xml)).toThrow();
});

test("non-XML members are left to the raw byte scan", () => {
  expect(officeXmlText("media/image1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
});
