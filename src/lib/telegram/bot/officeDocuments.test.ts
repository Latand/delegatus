import { expect, test } from "bun:test";
import { formulaReading, type FormulaSource, inspectOfficePackage, type RangeBox, inspectOfficeZip, officeXmlText, wordStyles } from "./officeDocuments";
import { commentHidingArchive, hiddenSeparators, officeParts, officeWordRun as wordRun, officeZip } from "./officeDocuments.fixture";

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
  // The three run-joining readings and the displayed reading of a consumer that understands the choice.
  expect(lines("word/document.xml", xml).filter(line => line.includes(secret))).toHaveLength(4);
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

const MC = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x="urn:fixture:extension"';
const word = (body: string, root = "") => `<w:document ${W} ${MC} ${root}><w:body><w:p>${body}</w:p></w:body></w:document>`;
const choice = (shown: string, hidden: string) => `<mc:AlternateContent><mc:Choice Requires="x">${hidden}</mc:Choice><mc:Fallback>${shown}</mc:Fallback></mc:AlternateContent>`;

test.each(hiddenSeparators("Alpha", "Beta"))("%s does not split the displayed text", (_label, _kind, name, xml) => {
  expect(lines(name, xml)).toContain("AlphaBeta");
});

test("a displayed separator keeps the halves apart in every reading", () => {
  for (const xml of [word(wordRun("Alpha") + wordRun(".") + wordRun("Beta")), word(wordRun("Alpha") + wordRun(".", '<w:vanish w:val="0"/>') + wordRun("Beta")),
    word(wordRun("Alpha") + choice(wordRun(".") + wordRun("Beta"), wordRun(".") + wordRun("Beta")))]) {
    expect(lines("word/document.xml", xml).some(line => line.includes("AlphaBeta"))).toBe(false);
  }
});

test("a choice whose namespaces a consumer understands replaces its fallback", () => {
  const xml = word(wordRun("Alpha") + `<mc:AlternateContent><mc:Choice Requires="x">${wordRun("Beta")}</mc:Choice><mc:Fallback>${wordRun("Gamma")}</mc:Fallback></mc:AlternateContent>`);
  const text = lines("word/document.xml", xml);
  expect(text).toContain("AlphaBeta");
  expect(text).toContain("AlphaGamma");
});

test("text hidden through a Word style is left out, and direct formatting overrides the style", () => {
  const styles = wordStyles(Buffer.from(`<w:styles ${W}><w:style w:type="character" w:styleId="Quiet"><w:rPr><w:vanish/></w:rPr></w:style><w:style w:type="character" w:styleId="Quieter"><w:basedOn w:val="Quiet"/></w:style></w:styles>`));
  expect(styles).toBeDefined();
  const hiddenByStyle = word(wordRun("Alpha") + wordRun(".", '<w:rStyle w:val="Quieter"/>') + wordRun("Beta"));
  expect(officeXmlText("word/document.xml", Buffer.from(hiddenByStyle), styles)!.split("\n")).toContain("AlphaBeta");
  const shownDirectly = word(wordRun("Alpha") + wordRun(".", '<w:rStyle w:val="Quiet"/><w:vanish w:val="false"/>') + wordRun("Beta"));
  expect(officeXmlText("word/document.xml", Buffer.from(shownDirectly), styles)!.split("\n").some(line => line.includes("AlphaBeta"))).toBe(false);
  expect(wordStyles(Buffer.from(`<worksheet ${S}/>`))).toBeUndefined();
});

test("a part offering more alternative namespaces than can be inspected throws", () => {
  const prefixes = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
  const declarations = prefixes.map(prefix => `xmlns:${prefix}="urn:fixture:${prefix}"`).join(" ");
  const branches = (count: number) => prefixes.slice(0, count).map(prefix => `<mc:AlternateContent><mc:Choice Requires="${prefix}">${wordRun("One")}</mc:Choice><mc:Fallback>${wordRun("Two")}</mc:Fallback></mc:AlternateContent>`).join("");
  expect(() => officeXmlText("word/document.xml", Buffer.from(word(branches(6), declarations)))).not.toThrow();
  expect(() => officeXmlText("word/document.xml", Buffer.from(word(branches(7), declarations)))).toThrow();
});

test("large displayed-text parts refuse before alternative readings can block the Viewer", () => {
  const runs = Array.from({ length: 30_001 }, () => "<w:r><w:t>x</w:t></w:r>").join("");
  const started = performance.now();
  expect(() => officeXmlText("word/document.xml", Buffer.from(word(runs, 'mc:Ignorable="x"')))).toThrow(/synchronous work bound/);
  expect(performance.now() - started).toBeLessThan(3000);
});

test("an archive comment cannot hide a second archive from inspection", () => {
  const entries = { "[Content_Types].xml": "<Types/>", "docProps/custom.xml": "<property>Neutral</property>" };
  const clean = officeZip(entries);
  expect(() => inspectOfficeZip(commentHidingArchive(clean, officeZip({ "docProps/custom.xml": "<property>Other</property>" })), 1 << 20, () => {})).toThrow();
  const commented = Buffer.concat([clean, Buffer.from("note")]);
  commented.writeUInt16LE(4, clean.length - 2);
  expect(() => inspectOfficeZip(commented, 1 << 20, () => {})).toThrow();
  expect(() => inspectOfficeZip(clean, 1 << 20, () => {})).not.toThrow();
});

/* ---- computed spreadsheet text -------------------------------------------- */

const column = (number: number) => String.fromCharCode(64 + number);
/* A source that reports what was asked: `<ref>` for a cell of this sheet, `<Sheet!ref>` for one of another, `[from-to]` for a range. */
const echo: FormulaSource = {
  cell: (sheet, reference) => `<${sheet === null ? "" : `${sheet}!`}${reference}>`,
  range: (sheet, box) => `[${sheet === null ? "" : `${sheet}!`}${column(box.column1)}${box.row1}-${column(box.column2)}${box.row2}]`,
};
const reading = (formula: string) => formulaReading(formula, echo);

test.each([
  ['B2&" "&C2', "<B2> <C2>", 2],
  ["SUM(B2:B10)", "[B2-B10]", 1],
  ['IF(D2>0,"yes","no")', "<D2>yesno", 1],
  ["$A$1&A$1&$B1", "<A1><A1><B1>", 3],
  ["a1&b1", "<A1><B1>", 2],
  ['"say ""hi"" "&A1', 'say "hi" <A1>', 1],
  ["LOG10(A1)&ATAN2(B1,C3)", "<A1><B1><C3>", 3],
  ['Sheet2!A1&"-"&B1', "<Sheet2!A1>-<B1>", 2],
  ["'Q 1'!A1&C3", "<Q 1!A1><C3>", 2],
  ["'It''s'!A1&C3", "<It's!A1><C3>", 2],
  ["Keys!A1:B2&C3", "[Keys!A1-B2]<C3>", 2],
  ["'Q 1'!$A$1:$B$2", "[Q 1!A1-B2]", 1],
  ["B2:A1", "[A1-B2]", 1],
  ["A:B", "[A1-B1048576]", 1],
  ["TEXTJOIN(\"\",TRUE,A1:B1)", "[A1-B1]", 1],
  ["Staff[Name]&A1", "<A1>", 1],
  ["A1.5+1E3", "", 0],
] as const)("the reading of =%s is %j with %d references", (formula, text, references) => {
  expect(reading(formula)).toEqual({ text, references });
});

test("a range of whole rows spans every column", () => {
  const boxes: RangeBox[] = [];
  formulaReading("Keys!3:1", { ...echo, range: (_sheet, box) => { boxes.push(box); return ""; } });
  expect(boxes).toEqual([{ column1: 1, row1: 1, column2: 16384, row2: 3 }]);
});

test.each([
  "[1]Other!A1&C3",
  "'[1]Other'!A1&C3",
  "Sheet1:Sheet3!A1&C3",
])("the reading of =%s leaves out what lives in another workbook or in several sheets", formula => {
  expect(reading(formula)?.text).toBe("<C3>");
});

test("a formula that names more cells than the bound cannot be read", () => {
  expect(reading(Array(64).fill("A1").join("&"))).toEqual({ text: "<A1>".repeat(64), references: 64 });
  expect(reading(Array(65).fill("A1").join("&"))).toBeNull();
  expect(reading(Array(65).fill("A1:B2").join("&"))).toBeNull();
});

test("a reading that passes the character limit, or a source out of work, cannot be read", () => {
  expect(formulaReading("A1&A1", echo, 7)).toBeNull();
  expect(formulaReading("A1&A1", echo, 8)).toEqual({ text: "<A1><A1>", references: 2 });
  expect(formulaReading("A1:B2", { ...echo, range: () => null })).toBeNull();
});

test("a part reads the text its formulas join from shared strings, inline strings and later cells", () => {
  const sheet = `<worksheet ${S}><sheetData><row><c r="A1"><f>B1&amp;C1&amp;D1</f></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Mid</t><rPh sb="0" eb="1"><t>Hidden</t></rPh></is></c><c r="D1"><f>"-"&amp;E1</f><v>-9</v></c><c r="E1"><v>42</v></c></row></sheetData></worksheet>`;
  const text = officeXmlText("xl/worksheets/sheet1.xml", Buffer.from(sheet), undefined, { sharedStrings: ["Start"] })!.split("\n");
  expect(text).toContain("StartMid-9");
  expect(text).toContain("-42");
  /* A phonetic guide is not part of what a cell shows, so a formula does not join it. */
  expect(text).not.toContain("StartMidHidden-9");
});

/* A two-sheet workbook written the way library writers do: text in the shared strings, no stored result for any formula. */
const twoSheets = (report: string, keys: string, strings: string[], flag = '<calcPr fullCalcOnLoad="1"/>') => officeZip({
  ...officeParts("xlsx"),
  "xl/workbook.xml": `<workbook ${S} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/><sheet name="Key Sheet" sheetId="2" r:id="rId2"/></sheets>${flag}</workbook>`,
  "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData>${report}</sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet ${S}><sheetData>${keys}</sheetData></worksheet>`,
  "xl/sharedStrings.xml": `<sst ${S}>${strings.map(text => `<si><t>${text}</t></si>`).join("")}</sst>`,
  "xl/_rels/workbook.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
});
const readParts = (bytes: Buffer) => {
  const parts = new Map<string, { lines: string[]; consent: boolean }>();
  inspectOfficePackage(bytes, 1 << 22, (name, _content, text, consent) => { parts.set(name, { lines: text?.split("\n") ?? [], consent }); });
  return parts;
};

test("a formula reads the text cells of a range and of a sheet named in the workbook", () => {
  const strings = ["Left", "Middle", "Right", "Other"];
  const report = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1"><v>7</v></c>'
    + '<c r="E1"><f>CONCAT(A1:C1)</f></c><c r="F1"><f>SUM(D1:D9)&amp;"|"</f></c><c r="G1"><f>\'Key Sheet\'!A1&amp;\'key sheet\'!B2</f></c><c r="H1"><f>TEXTJOIN("",TRUE,\'Key Sheet\'!A1:B2)</f></c></row>';
  const keys = '<row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1"><v>5</v></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><t>Tail</t></is></c></row>';
  const part = readParts(twoSheets(report, keys, strings)).get("xl/worksheets/sheet1.xml")!;
  expect(part.consent).toBe(false);
  expect(part.lines).toContain("LeftMiddleRight");
  expect(part.lines).toContain("OtherTail");
  expect(part.lines).toContain("OtherLeftTail");
});

test("a range reads rows in order, and only the columns it names", () => {
  const strings = ["a", "b", "c", "d"];
  const report = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row><row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2" t="s"><v>3</v></c></row>'
    + '<row r="9"><c r="E9"><f>A1:C2</f></c><c r="F9"><f>B:C</f></c><c r="G9"><f>1:1</f></c></row>';
  const lines = readParts(twoSheets(report, "", strings)).get("xl/worksheets/sheet1.xml")!.lines;
  expect(lines).toContain("abdd");
  expect(lines).toContain("bd");
  expect(lines).toContain("abc");
});

test("a range over more cells than the package may visit asks for consent", () => {
  /* 3 600 distinct ranges over a sheet of 6 000 text cells visit 21 600 000 cells, past the package's 20 000 000, though each reads no text. */
  const heavy = Array.from({ length: 6000 }, (_, row) => `<row r="${row + 1}"><c r="A${row + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join("");
  const letters = (number: number) => (number > 26 ? letters(Math.floor((number - 1) / 26)) : "") + column(((number - 1) % 26) + 1);
  const many = (count: number) => Array.from({ length: count }, (_, at) => `<row r="${at + 1}"><c r="C${at + 1}"><f>LEN('Key Sheet'!B1:${letters(at + 2)}6000)</f></c></row>`).join("");
  expect(readParts(twoSheets(many(3000), heavy, [])).get("xl/worksheets/sheet1.xml")!.consent).toBe(false);
  expect(readParts(twoSheets(many(3600), heavy, [])).get("xl/worksheets/sheet1.xml")!.consent).toBe(true);
});

test("a range that many formulas name is read once, whatever their number", () => {
  const heavy = Array.from({ length: 6000 }, (_, row) => `<row r="${row + 1}"><c r="A${row + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join("");
  const same = Array.from({ length: 4000 }, (_, at) => `<row r="${at + 1}"><c r="C${at + 1}"><f>LEN('Key Sheet'!B1:B6000)</f></c></row>`).join("");
  expect(readParts(twoSheets(same, heavy, [])).get("xl/worksheets/sheet1.xml")!.consent).toBe(false);
});

test("a long range keeps its ends in each formula that joins it, and its whole text once", () => {
  const rows = Array.from({ length: 400 }, (_, row) => `<row r="${row + 1}"><c r="A${row + 1}" t="inlineStr"><is><t>${String(row).padStart(3, "0")}</t></is></c></row>`).join("");
  const report = '<row r="1"><c r="C1"><f>"["&amp;\'Key Sheet\'!A1:A400&amp;"|"</f></c><c r="D1"><f>\'Key Sheet\'!A1:A400</f></c></row>';
  const lines = readParts(twoSheets(report, rows, [])).get("xl/worksheets/sheet1.xml")!.lines;
  const whole = Array.from({ length: 400 }, (_, row) => String(row).padStart(3, "0")).join("");
  expect(lines.filter(line => line === whole)).toHaveLength(1);
  /* Lines end where the ends meet, so the head and the tail show on neighbouring lines. */
  expect(lines).toContain(`[${whole.slice(0, 256)}`);
  expect(lines).toContain(`${whole.slice(-256)}|`);
});

test("a formula that joins formula cells with no stored result reads what those cells join", () => {
  const strings = ["Left", "Right"];
  const report = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><f>A1</f></c><c r="D1"><f>C1&amp;B1</f></c></row>';
  const part = readParts(twoSheets(report, "", strings)).get("xl/worksheets/sheet1.xml")!;
  expect(part.consent).toBe(false);
  expect(part.lines).toContain("LeftRight");
});

test("a cell with a stored result that only joins what it names is read as stored and as recalculated", () => {
  /* A reader that recalculates shows what the formula joins, one that does not shows the stored result: each view is read. */
  const strings = ["Left", "Right"];
  const report = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="str"><f>A1</f><v>Stale</v></c><c r="D1"><f>C1&amp;B1</f></c><c r="E1" t="str"><f>UPPER(A1)</f><v>LEFT</v></c><c r="F1"><f>E1&amp;B1</f></c></row>';
  const lines = readParts(twoSheets(report, "", strings)).get("xl/worksheets/sheet1.xml")!.lines;
  expect(lines).toContain("StaleRight");
  expect(lines).toContain("LeftRight");
  /* A function's result is only the stored one. */
  expect(lines).toContain("LEFTRight");
});

test("formula cells that name one another in a loop, or in a chain too deep to follow, ask for consent", () => {
  const consent = (report: string) => readParts(twoSheets(report, "", [])).get("xl/worksheets/sheet1.xml")!.consent;
  expect(consent('<row r="1"><c r="A1"><f>B1</f></c><c r="B1"><f>A1</f></c></row>')).toBe(true);
  expect(consent('<row r="1"><c r="A1"><f>A1</f></c></row>')).toBe(true);
  const chain = (length: number) => `<row r="1">${Array.from({ length }, (_, at) => `<c r="${letters(at + 1)}1"><f>${letters(at + 2)}1</f></c>`).join("")}</row>`;
  function letters(number: number): string { return (number > 26 ? letters(Math.floor((number - 1) / 26)) : "") + column(((number - 1) % 26) + 1); }
  expect(consent(chain(20))).toBe(false);
  expect(consent(chain(80))).toBe(true);
});

test("the recalculation flag alone asks for no consent, and computed text beyond the reading bound does", () => {
  const workbook = (rows: string, flag = '<calcPr fullCalcOnLoad="1"/>') => officeZip({
    ...officeParts("xlsx"),
    "xl/workbook.xml": `<workbook ${S}><sheets/>${flag}</workbook>`,
    "xl/worksheets/sheet1.xml": `<worksheet ${S}><sheetData>${rows}</sheetData></worksheet>`,
  });
  const consent = (bytes: Buffer) => {
    let asked = false;
    inspectOfficePackage(bytes, 1 << 22, (_name, _content, _text, requiresConsent) => { asked ||= requiresConsent; });
    return asked;
  };
  const refs = (count: number) => Array(count).fill("A1").join("&amp;");
  const row = (text: string, formula: string) => `<row><c r="A1" t="inlineStr"><is><t>${text}</t></is></c><c r="B1"><f>${formula}</f></c></row>`;
  expect(consent(workbook(""))).toBe(false);
  expect(consent(workbook(row("Alpha", "SUM(A2:A9)&amp;A1")))).toBe(false);
  expect(consent(workbook(row("Alpha", refs(64))))).toBe(false);
  expect(consent(workbook(row("Alpha", refs(65))))).toBe(true);
  /* Sixty-four copies of a 30 000-character cell outgrow what the package's own size allows. */
  expect(consent(workbook(row("x".repeat(30_000), refs(64))))).toBe(true);
  expect(consent(workbook(row("x".repeat(30_000), refs(2))))).toBe(false);
});
