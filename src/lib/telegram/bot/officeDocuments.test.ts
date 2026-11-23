import { expect, test } from "bun:test";
import { inspectOfficeZip, officeXmlText } from "./officeDocuments";
import { officeZip } from "./officeDocuments.fixture";

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

test("bytes hidden after a member's deflate stream make the package uninspectable", () => {
  const inspected: string[] = [];
  const entries = { "[Content_Types].xml": "<Types/>", "docProps/custom.xml": "<property>Neutral</property>" };
  expect([...inspectOfficeZip(officeZip(entries), 1024, name => inspected.push(name))]).toEqual(Object.keys(entries));
  expect(inspected).toEqual(Object.keys(entries));
  expect(() => inspectOfficeZip(officeZip(entries, true, false, Buffer.from("trailing note")), 1024, () => {})).toThrow();
});

const token = () => ["gh", "p_", "Ab9".repeat(12)].join("");
const anthropic = () => ["sk", "ant", "api03", "Ab9".repeat(6)];

test.each([
  ["an author before its comment", (secret: string) => `<comments ${S}><authors><author>Reviewer1</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>${secret.slice(0, 10)}</t></r><r><rPr><b/><sz val="9"/></rPr><t>${secret.slice(10)}</t></r></text></comment></commentList></comments>`],
  ["an earlier comment", (secret: string) => `<comments ${S}>\n  <authors><author>Reviewer</author></authors>\n  <commentList>\n    <comment ref="A1" authorId="0"><text><t>Note1</t></text></comment>\n    <comment ref="B1" authorId="0"><text>\n      <r><t>${secret.slice(0, 10)}</t></r>\n      <r><rPr><b/></rPr><t>${secret.slice(10)}</t></r>\n    </text></comment>\n  </commentList>\n</comments>`],
  ["a header before a footer", (secret: string) => `<worksheet ${S}><headerFooter><oddHeader>Draft1</oddHeader><oddFooter>${secret}</oddFooter></headerFooter></worksheet>`],
] as const)("SpreadsheetML keeps %s apart while rich runs inside it join", (_label, xml) => {
  const secret = token();
  expect(lines("xl/comments1.xml", xml(secret))).toContain(secret);
});

test("threaded comments, document properties and chart values stand apart in the separated reading", () => {
  const secret = token();
  const threaded = `<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1"><text>Note1</text></threadedComment><threadedComment ref="A1"><text>${secret}</text></threadedComment></ThreadedComments>`;
  const core = `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Draft1</dc:title><dc:subject>&#103;${secret.slice(1)}</dc:subject></cp:coreProperties>`;
  const chart = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:strCache><c:pt idx="0"><c:v>Name1</c:v></c:pt><c:pt idx="1"><c:v>${secret}</c:v></c:pt></c:strCache></c:chartSpace>`;
  for (const [name, xml] of [["xl/threadedComments/threadedComment1.xml", threaded], ["docProps/core.xml", core], ["word/charts/chart1.xml", chart]]) {
    expect(lines(name, xml)).toContain(secret);
  }
});

test("Word shows a non-breaking hyphen and a symbol character; a soft hyphen shows nothing", () => {
  const [a, b, c, d] = anthropic();
  const xml = `<w:document ${W}><w:body><w:p><w:r><w:t>${a}</w:t><w:noBreakHyphen/><w:t>${b}</w:t><w:sym w:font="Arial" w:char="002D"/><w:t>${c}</w:t><w:noBreakHyphen/><w:t>Ab</w:t><w:softHyphen/><w:t>${d.slice(2)}</w:t></w:r></w:p></w:body></w:document>`;
  expect(lines("word/document.xml", xml)).toContain(`${a}-${b}-${c}-${d}`);
});

test("math runs and markup-compatibility wrappers still join in every reading", () => {
  const secret = token();
  const xml = `<w:document ${W} xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body><w:p><m:oMath><m:r><m:t>${secret.slice(0, 10)}</m:t></m:r><m:r><m:t>${secret.slice(10, 20)}</m:t></m:r></m:oMath><mc:AlternateContent><mc:Choice Requires="w"><w:r><w:t>${secret.slice(20)}</w:t></w:r></mc:Choice></mc:AlternateContent></w:p></w:body></w:document>`;
  expect(lines("word/document.xml", xml).filter(line => line.includes(secret))).toHaveLength(3);
});

const neutralXlsx = () => officeZip({ "[Content_Types].xml": "<Types/>", "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>` });

test("embedded packages are opened and every member reaches inspection under its nested name", () => {
  const inspected: string[] = [];
  const outer = officeZip({ "[Content_Types].xml": "<Types/>", "word/embeddings/Microsoft_Excel_Worksheet.xlsx": neutralXlsx() });
  expect([...inspectOfficeZip(outer, 4096, name => inspected.push(name))]).toEqual(["[Content_Types].xml", "word/embeddings/Microsoft_Excel_Worksheet.xlsx"]);
  expect(inspected).toEqual(["[Content_Types].xml", "word/embeddings/Microsoft_Excel_Worksheet.xlsx",
    "word/embeddings/Microsoft_Excel_Worksheet.xlsx/[Content_Types].xml", "word/embeddings/Microsoft_Excel_Worksheet.xlsx/xl/worksheets/sheet1.xml"]);
  // Stored members are still opened, and a ZIP under another name is found by its signature.
  const stored = officeZip({ "ppt/embeddings/oleObject1.data": officeZip({ "word/document.xml": "<d/>" }) }, false);
  const names: string[] = [];
  inspectOfficeZip(stored, 4096, name => names.push(name));
  expect(names).toContain("ppt/embeddings/oleObject1.data/word/document.xml");
});

test.each([
  ["an OLE compound file", () => officeZip({ "word/embeddings/oleObject1.bin": Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(504)]) })],
  ["a package name that is no ZIP", () => officeZip({ "word/embeddings/Sheet.xlsx": "<not a package/>" })],
  ["a ZIP behind leading bytes", () => officeZip({ "word/embeddings/object.dat": Buffer.concat([Buffer.from("stub"), neutralXlsx()]) })],
  ["a damaged embedded package", () => officeZip({ "word/embeddings/Sheet.xlsx": neutralXlsx().subarray(0, 40) })],
  ["nesting past the bound", () => officeZip({ "a.docx": officeZip({ "b.xlsx": officeZip({ "c.pptx": neutralXlsx() }) }) })],
] as const)("%s cannot be inspected and throws", (_label, build) => {
  expect(() => inspectOfficeZip(build(), 1 << 20, () => {})).toThrow();
});

test("nesting within the bound is inspected", () => {
  const names: string[] = [];
  inspectOfficeZip(officeZip({ "a.docx": officeZip({ "b.xlsx": neutralXlsx() }) }), 1 << 20, name => names.push(name));
  expect(names).toContain("a.docx/b.xlsx/xl/worksheets/sheet1.xml");
});

test("the expanded-byte limit counts embedded packages' members too", () => {
  const strings = `<sst ${S}><si><t>${"Neutral ".repeat(200)}</t></si></sst>`;
  const inner = officeZip({ "xl/sharedStrings.xml": strings });
  const outer = officeZip({ "word/embeddings/Sheet.xlsx": inner });
  const total = inner.length + Buffer.byteLength(strings);
  expect(() => inspectOfficeZip(outer, total, () => {})).not.toThrow();
  expect(() => inspectOfficeZip(outer, total - 1, () => {})).toThrow();
});
