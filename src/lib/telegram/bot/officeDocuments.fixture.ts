import { deflateRawSync } from "node:zlib";

/** Neutral Office files created by tests; no external programs or client data. */
export function officeZip(entries: Record<string, string | Buffer>, compressed = true, dataDescriptor = false): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename), content = Buffer.from(value);
    const encoded = compressed ? deflateRawSync(content) : content;
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

export function officeParts(kind: "xlsx" | "docx", text = "Neutral report"): Record<string, string> {
  const part = kind === "xlsx" ? "xl/workbook.xml" : "word/document.xml";
  const mime = kind === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
  const entries: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="${mime}"/>${kind === "xlsx" ? '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' : ""}</Types>`,
    "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${part}"/></Relationships>`,
    [part]: kind === "xlsx"
      ? '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>'
      : `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  if (kind === "xlsx") {
    entries["xl/_rels/workbook.xml.rels"] = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
    entries["xl/worksheets/sheet1.xml"] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c></row></sheetData></worksheet>`;
  }
  return entries;
}

/** BIFF8 workbook with one LABEL cell, in a version-3 compound file. */
export function legacyWorkbook(text = "Neutral report"): Buffer {
  const record = (id: number, body: Buffer) => {
    const header = Buffer.alloc(4); header.writeUInt16LE(id); header.writeUInt16LE(body.length, 2);
    return Buffer.concat([header, body]);
  };
  const bof = (kind: number) => { const body = Buffer.alloc(16); body.writeUInt16LE(0x600); body.writeUInt16LE(kind, 2); return record(0x809, body); };
  const bound = Buffer.alloc(14); bound.writeUInt32LE(42); bound[6] = 6; bound.write("Report", 8);
  const label = Buffer.alloc(9 + text.length * 2); label.writeUInt16LE(text.length, 6); label[8] = 1; label.write(text, 9, "utf16le");
  const workbook = Buffer.concat([bof(5), record(0x85, bound), record(0x0a, Buffer.alloc(0)), bof(0x10), record(0x204, label), record(0x0a, Buffer.alloc(0))]);
  const file = Buffer.alloc(5632);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(file);
  file.writeUInt16LE(0x3e, 24); file.writeUInt16LE(3, 26); file.writeUInt16LE(0xfffe, 28); file.writeUInt16LE(9, 30); file.writeUInt16LE(6, 32);
  file.writeUInt32LE(1, 44); file.writeUInt32LE(4096, 56); file.writeInt32LE(-2, 60); file.writeInt32LE(-2, 68);
  file.fill(0xff, 76, 512); file.writeUInt32LE(1, 76);
  for (const [index, name, type, start, size] of [[0, "Root Entry", 5, -2, 0], [1, "Workbook", 2, 2, 4096]] as const) {
    const at = 512 + index * 128;
    file.write(name, at, "utf16le"); file.writeUInt16LE((name.length + 1) * 2, at + 64); file[at + 66] = type; file[at + 67] = 1;
    file.writeInt32LE(-1, at + 68); file.writeInt32LE(-1, at + 72); file.writeInt32LE(index === 0 ? 1 : -1, at + 76);
    file.writeInt32LE(start, at + 116); file.writeUInt32LE(size, at + 120);
  }
  file.fill(0xff, 1024, 1536); file.writeInt32LE(-2, 1024); file.writeInt32LE(-3, 1028);
  for (let sector = 2; sector <= 9; sector++) file.writeInt32LE(sector === 9 ? -2 : sector + 1, 1024 + sector * 4);
  workbook.copy(file, 1536);
  return file;
}
