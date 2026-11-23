import { deflateRawSync } from "node:zlib";

/** Neutral Office files created by tests; no external programs or client data. */
/** `trailer` follows each deflate stream inside its member, as a crafted file could. */
export function officeZip(entries: Record<string, string | Buffer>, compressed = true, dataDescriptor = false, trailer = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename), content = Buffer.from(value);
    const encoded = compressed ? Buffer.concat([deflateRawSync(content), trailer]) : content;
    let crc = 0xffffffff;
    for (const byte of content) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(compressed ? 8 : 0, 8);
    local.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 14);
    local.writeUInt32LE(encoded.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(dataDescriptor ? 16 : 0);
    if (dataDescriptor) {
      local.writeUInt16LE(8, 6); descriptor.writeUInt32LE(0x08074b50);
      local.copy(descriptor, 4, 14, 26);
    }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    local.copy(central, 10, 8, 26); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    central.writeUInt16LE(dataDescriptor ? 8 : 0, 8);
    if (dataDescriptor) local.fill(0, 14, 26);
    locals.push(local, name, encoded, descriptor);
    directory.push(central, name);
    offset += local.length + name.length + encoded.length + descriptor.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(directory.length / 2, 8); end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

const NAMESPACES = 'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x="urn:fixture:extension"';
const WORD = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${NAMESPACES}`;
export const officeWordRun = (text: string, properties = "") => `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ""}<w:t>${text}</w:t></w:r>`;
const run = officeWordRun;
const word = (body: string, root = "") => `<w:document ${WORD} ${root}><w:body><w:p>${body}</w:p></w:body></w:document>`;
const sheet = (string: string, root = "") => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${NAMESPACES} ${root}><sheetData><row r="1"><c r="A1" t="inlineStr"><is>${string}</is></c></row></sheetData></worksheet>`;
const slide = (paragraph: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ${NAMESPACES}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:p>${paragraph}</a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const choice = (shown: string, hidden: string) => `<mc:AlternateContent><mc:Choice Requires="x">${hidden}</mc:Choice><mc:Fallback>${shown}</mc:Fallback></mc:AlternateContent>`;
const revision = 'w:id="1" w:author="Reviewer" w:date="2026-01-01T00:00:00Z"';

/** Parts that put text Office does not display between the two displayed
 * halves `left` and `right` of one token: [label, kind, part name, XML]. */
export const hiddenSeparators = (left: string, right: string) => [
  ["Word hidden run", "docx", "word/document.xml", word(run(left) + run(".", "<w:vanish/>") + run(right))],
  ["Word tracked deletion", "docx", "word/document.xml", word(`${run(left)}<w:del ${revision}><w:r><w:delText>.</w:delText></w:r></w:del>${run(right)}`)],
  ["Word tracked insertion in the original view", "docx", "word/document.xml", word(`${run(left)}<w:ins ${revision}>${run(".")}</w:ins>${run(right)}`)],
  ["Word characters outside a text element", "docx", "word/document.xml", word(`${run(left)}<w:r>.</w:r>${run(right)}`)],
  ["Word characters inside an alternative container", "docx", "word/document.xml", word(`${run(left)}<mc:AlternateContent>.<mc:Fallback>${run(right)}</mc:Fallback></mc:AlternateContent>`)],
  ["Word field instruction", "docx", "word/document.xml", word(`${run(left)}<w:r><w:instrText>.</w:instrText></w:r>${run(right)}`)],
  ["Word ignorable element", "docx", "word/document.xml", word(`${run(left)}<x:note>.</x:note>${run(right)}`, 'mc:Ignorable="x"')],
  ["Word unselected choice", "docx", "word/document.xml", word(run(left) + choice(run(right), run(".")))],
  ["Word ruby text", "docx", "word/document.xml", word(`${run(left)}<w:r><w:ruby><w:rubyPr/><w:rt>${run(".")}</w:rt><w:rubyBase>${run(right)}</w:rubyBase></w:ruby></w:r>`)],
  ["Word text box anchored inside the line", "docx", "word/document.xml", word(`${run(left)}<w:r><w:pict><w:txbxContent><w:p>${run(".")}</w:p></w:txbxContent></w:pict></w:r>${run(right)}`)],
  ["Word web-hidden run in the web view", "docx", "word/document.xml", word(run(left) + run(".", "<w:webHidden/>") + run(right))],
  ["Word hidden paragraph mark", "docx", "word/document.xml", `<w:document ${WORD}><w:body><w:p><w:pPr><w:rPr><w:vanish/></w:rPr></w:pPr>${run(left)}</w:p><w:p>${run(right)}</w:p></w:body></w:document>`],
  ["Word deleted paragraph mark", "docx", "word/document.xml", `<w:document ${WORD}><w:body><w:p><w:pPr><w:rPr><w:del ${revision}/></w:rPr></w:pPr>${run(left)}</w:p><w:p>${run(right)}</w:p></w:body></w:document>`],
  ["Word inherited preserved spaces", "docx", "word/document.xml", `<w:document ${WORD} xml:space="preserve"><w:body><w:p><w:r><w:t>${left}\n   </w:t></w:r>${run(right)}</w:p></w:body></w:document>`],
  ["Excel phonetic run", "xlsx", "xl/worksheets/sheet1.xml", sheet(`<r><t>${left}</t></r><rPh sb="0" eb="1"><t>.</t></rPh><r><t>${right}</t></r>`)],
  ["Excel empty phonetic run", "xlsx", "xl/worksheets/sheet1.xml", sheet(`<r><t>${left}</t></r><rPh sb="0" eb="1"><t></t></rPh><r><t>${right}</t></r>`)],
  ["Excel ignorable element", "xlsx", "xl/worksheets/sheet1.xml", sheet(`<r><t>${left}</t></r><x:note>.</x:note><r><t>${right}</t></r>`, 'mc:Ignorable="x"')],
  ["PowerPoint unselected choice", "pptx", "ppt/slides/slide1.xml", slide(`<a:r><a:t>${left}</a:t></a:r>${choice(`<a:r><a:t>${right}</a:t></a:r>`, "<a:r><a:t>.</a:t></a:r>")}`)],
] as const;

/** Move every offset of `zip` by `base`, as if it began `base` bytes into another file. */
function relocated(zip: Buffer, base: number): Buffer {
  const moved = Buffer.from(zip), end = moved.length - 22;
  let position = moved.readUInt32LE(end + 16);
  for (let index = 0; index < moved.readUInt16LE(end + 10); index++) {
    moved.writeUInt32LE(moved.readUInt32LE(position + 42) + base, position + 42);
    position += 46 + moved.readUInt16LE(position + 28) + moved.readUInt16LE(position + 30) + moved.readUInt16LE(position + 32);
  }
  moved.writeUInt32LE(moved.readUInt32LE(end + 16) + base, end + 16);
  return moved;
}

/** A clean archive whose comment holds a second archive that other readers open instead. */
export function commentHidingArchive(clean: Buffer, hidden: Buffer): Buffer {
  // The trailing byte stops the hidden end record's comment length from reaching the end.
  const tail = Buffer.concat([relocated(hidden, clean.length), Buffer.from([0])]);
  const outer = Buffer.from(clean);
  outer.writeUInt16LE(tail.length, outer.length - 2);
  return Buffer.concat([outer, tail]);
}


export function officeParts(kind: "xlsx" | "docx" | "pptx", text = "Neutral report"): Record<string, string> {
  const part = { xlsx: "xl/workbook.xml", docx: "word/document.xml", pptx: "ppt/presentation.xml" }[kind];
  const type = { xlsx: "spreadsheetml.sheet", docx: "wordprocessingml.document", pptx: "presentationml.presentation" }[kind];
  const mime = `application/vnd.openxmlformats-officedocument.${type}.main+xml`;
  const extraType = {
    xlsx: '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    docx: "",
    pptx: '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>',
  }[kind];
  const entries: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="${mime}"/>${extraType}</Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${part}"/></Relationships>`,
    [part]: kind === "xlsx"
      ? '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>'
      : kind === "pptx"
        ? '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
        : `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  if (kind === "xlsx") {
    entries["xl/_rels/workbook.xml.rels"] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    entries["xl/worksheets/sheet1.xml"] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`;
  } else if (kind === "pptx") {
    entries["ppt/_rels/presentation.xml.rels"] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>';
    entries["ppt/slides/slide1.xml"] = `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Report"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
      <p:spPr/>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody>
    </p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
  }
  return entries;
}
