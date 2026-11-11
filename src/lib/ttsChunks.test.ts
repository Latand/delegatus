import { describe, expect, test } from "bun:test";

import { MAX_TTS_MESSAGE_LENGTH, MAX_TTS_TEXT_LENGTH } from "./tts";
import { chunkSpeech, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS } from "./ttsChunks";

function sentences(count: number, word = "sentence"): string {
  return Array.from({ length: count }, (_, index) => `This is ${word} number ${index} in the answer.`).join(" ");
}

describe("chunkSpeech (#1022)", () => {
  test("a message that fits one chunk stays a single request", () => {
    const text = "Short answer that fits in one synthesis request.";
    expect(chunkSpeech(text)).toEqual([{ index: 0, text, start: 0, end: text.length }]);
  });

  test("empty and whitespace-only messages produce no chunks", () => {
    expect(chunkSpeech("")).toEqual([]);
    expect(chunkSpeech("   \n\n\t ")).toEqual([]);
  });

  test("every chunk is an exact slice of the source, in order and without gaps in the text", () => {
    const source = sentences(80);
    const chunks = chunkSpeech(source);
    expect(chunks.length).toBeGreaterThan(1);
    let previousEnd = -1;
    for (const chunk of chunks) {
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
      expect(chunk.start).toBeGreaterThan(previousEnd);
      previousEnd = chunk.end;
    }
    expect(chunks.map((chunk) => chunk.index)).toEqual(chunks.map((_, index) => index));
    /* Nothing is dropped: the spoken words survive the split. */
    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(source);
  });

  test("chunks stay inside the size band and never break a word", () => {
    const chunks = chunkSpeech(sentences(120));
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text.length).toBeGreaterThanOrEqual(MIN_CHUNK_CHARS);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/^\s|\s$/);
      expect(chunk.text[0]).toMatch(/\S/);
    }
  });

  test("splits on sentence boundaries, not mid-sentence", () => {
    const chunks = chunkSpeech(sentences(40));
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text).toMatch(/[.!?…]["'”’)\]]*$/);
  });

  test("prefers a paragraph break once the chunk is long enough", () => {
    const source = `${sentences(12, "alpha")}\n\n${sentences(12, "beta")}`;
    const chunks = chunkSpeech(source);
    const crossing = chunks.filter((chunk) => chunk.text.includes("alpha") && chunk.text.includes("beta"));
    expect(crossing).toEqual([]);
  });

  test("a URL is never cut, not even by the dots inside it", () => {
    const url = "https://example.com/docs/v1.2.3/guide.html?query=a.b.c#section.4";
    const source = `${sentences(20, "before")} ${url} ${sentences(20, "after")}`;
    const chunks = chunkSpeech(source);
    expect(chunks.filter((chunk) => chunk.text.includes(url))).toHaveLength(1);
    for (const chunk of chunks) {
      expect(chunk.text).not.toMatch(/https:\/\/example\.com\/docs\/v1\.2\.3\/guide\.html\?query=a\.b\.c#section\.4.$/);
    }
  });

  test("an unbreakable token longer than the chunk ceiling survives whole", () => {
    const giant = `https://example.com/${"segment/".repeat(200)}end`;
    const chunks = chunkSpeech(`Look here. ${giant} Done reading.`);
    expect(chunks.some((chunk) => chunk.text.includes(giant))).toBe(true);
  });

  test("a single sentence longer than the ceiling splits on whitespace only", () => {
    const source = `${"word ".repeat(600)}end.`;
    const chunks = chunkSpeech(source);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text).toMatch(/^word/);
      expect(chunk.text).toMatch(/(word|end\.)$/);
      expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
    }
  });

  test("no chunk can exceed what one request may carry, whatever the text is", () => {
    /* A bare blob (no scheme, no backticks) reaches the chunker intact. It has
       no word boundary to respect, and the per-request ceiling still has to
       hold or the route refuses the chunk with a 413. */
    const blob = "A".repeat(MAX_TTS_TEXT_LENGTH * 2 + 137);
    const chunks = chunkSpeech(`Here is the payload. ${blob} That was it.`);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_TTS_TEXT_LENGTH);
    expect(chunks.map((chunk) => chunk.text).join("")).toContain(blob);
  });

});

describe("Soniox sentence policy", () => {
  test("short answers emit the first sentence, then at most three sentences", () => {
    const source = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence.";
    const chunks = chunkSpeech(source, { backend: "soniox" });
    expect(chunks.map((c) => c.text)).toEqual(["First sentence.", "Second sentence. Third sentence. Fourth sentence.", "Fifth sentence."]);
    expect(chunkSpeech(source)).toHaveLength(1);
  });
  test("exact slices preserve every character across codepoint caps and paragraphs", () => {
    for (const source of ["Я".repeat(1800), "😀".repeat(1100), "word ".repeat(420), "Dr. Smith paid 3.14 dollars. He said ‘Done!’\n\nНаступний абзац. Ще речення.", "Heading\nList item\nAnother list item"]) {
      const chunks = chunkSpeech(source, { backend: "soniox", language: "uk" });
      expect(chunks.map((c) => c.text.replace(/\s/g, "")).join("")).toBe(source.replace(/\s/g, ""));
      for (const [index, chunk] of chunks.entries()) {
        expect(source.slice(chunk.start, chunk.end)).toBe(chunk.text);
        expect([...chunk.text].length).toBeLessThanOrEqual(index === 0 ? 160 : 360);
        expect(new TextEncoder().encode(chunk.text).length).toBeLessThanOrEqual(4800);
        if (index) expect(chunk.start).toBeGreaterThanOrEqual(chunks[index - 1]!.end);
        expect(chunk.text).not.toMatch(/[\uD800-\uDBFF]$/);
      }
    }
  });
  test("fallback preserves abbreviations and punctuation-free tokens", () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      const source = "Dr. Smith paid 3.14. Next sentence! Last one.";
      expect(chunkSpeech(source, { backend: "soniox" })[0]?.text).toBe("Dr. Smith paid 3.14.");
      expect(chunkSpeech("ж".repeat(900), { backend: "soniox" }).map((c) => c.text).join("")).toBe("ж".repeat(900));
    } finally { Object.defineProperty(Intl, "Segmenter", { value: original, configurable: true }); }
  });
});

test("native sentence segmentation keeps titles and decimal numbers in the first sentence", () => {
  const source = "Dr. Smith paid 3.14 dollars. He left. Another sentence.";
  expect(chunkSpeech(source, { backend: "soniox", language: "en" })[0]!.text).toBe("Dr. Smith paid 3.14 dollars.");
});


test.each(["Привіт світе. Це наступне речення. ", "Привет мир. Это следующее предложение. ", "Hello world. This is another sentence. "])("Fish Audio uses the bounded sentence policy for %s", (sentence) => {
  const text = sentence.repeat(20);
  const chunks = chunkSpeech(text, { backend: "fishaudio" });
  expect([...chunks[0]!.text].length).toBeLessThanOrEqual(160);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map((chunk) => text.slice(chunk.start, chunk.end))).toEqual(chunks.map((chunk) => chunk.text));
  expect(chunks).toEqual(chunkSpeech(text, { backend: "soniox" }));
});


test("ElevenLabs uses short sentence batches", () => {
  const source = "First sentence. Second sentence. Third sentence.";
  const eleven = chunkSpeech(source, { backend: "elevenlabs" });
  expect(eleven).toEqual(chunkSpeech(source, { backend: "fishaudio" }));
  expect(eleven[0]!.text).toBe("First sentence.");
  expect(eleven.length).toBeGreaterThan(1);
});

// Source ranges captured from the previous implementation for accepted inputs.
const compatibilityCases = [
  { name: "empty", source: "" },
  { name: "whitespace", source: " \n\n\t " },
  { name: "sentence batches", source: "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence." },
  { name: "titles and decimals", source: "Dr. Smith paid 3.14 dollars. Mr. Green left! Prof. Brown stayed. A. B. Next? e.g. Example. i.e. Another. etc. Done." },
  { name: "Cyrillic paragraphs", source: ("Це перше речення. Наступне речення! Ще одне?\n\n" + "Слово ".repeat(35) + "Кінець.\n").repeat(4) },
  { name: "emoji at caps", source: "😀".repeat(159) + "x😀" + "🧑‍💻 ".repeat(100) + "Done. " + "😀".repeat(362) },
  { name: "surrogate edges", source: "x".repeat(159) + "😀" + "x".repeat(359) + "😀" + "\ud800x\udc00" + "😀".repeat(181) },
  { name: "combining marks", source: ("e\u0301 а\u0308 ").repeat(230) + "Кінець." },
  { name: "long words", source: "Ж".repeat(1800) },
  { name: "request-sized token", source: "x".repeat(8400) },
  { name: "punctuation and lists", source: ("Heading\nFirst item\nSecond item\n\nHe said ‘Done!’ Then \"Yes.\" Next… [Done!]\n").repeat(20) },
  { name: "whitespace around cuts", source: " \t" + "word  \t".repeat(260) + "End.\n\t " },
  { name: "chunk ceilings", source: "x".repeat(800) + " " + "y".repeat(798) + " End." },
  { name: "blank line variants", source: ("Alpha.\r\n \t\n\v\fBeta\n\nGamma!\n\n").repeat(30) },
];

const previousRanges: Record<string, [number, number][][]> = {
  legacy: [
    [],
    [],
    [[0,81]],
    [[0,115]],
    [[0,572],[574,1055]],
    [[0,800],[801,926],[927,1651]],
    [[0,887]],
    [[0,800],[801,1387]],
    [[0,1800]],
    [[0,4000],[4000,8000],[8000,8400]],
    [[0,400],[402,844],[846,1288],[1290,1479]],
    [[2,797],[800,1595],[1598,1826]],
    [[0,800],[801,1599],[1600,1604]],
    [[0,403],[405,808]],
  ],
  native: [
    [],
    [],
    [[0,15],[16,65],[66,81]],
    [[0,28],[29,67],[68,115]],
    [[0,17],[18,44],[46,263],[264,308],[310,527],[528,572],[574,791],[792,836],[838,1055]],
    [[0,319],[319,854],[855,926],[927,1647],[1647,1651]],
    [[0,161],[161,522],[522,887]],
    [[0,158],[159,518],[519,878],[879,1238],[1239,1387]],
    [[0,160],[160,520],[520,880],[880,1240],[1240,1600],[1600,1800]],
    [[0,160],[160,520],[520,880],[880,1240],[1240,1600],[1600,1960],[1960,2320],[2320,2680],[2680,3040],[3040,3400],[3400,3760],[3760,4120],[4120,4480],[4480,4840],[4840,5200],[5200,5560],[5560,5920],[5920,6280],[6280,6640],[6640,7000],[7000,7360],[7360,7720],[7720,8080],[8080,8400]],
    [[0,7],[8,18],[19,30],[32,73],[74,81],[82,92],[93,104],[106,147],[148,155],[156,166],[167,178],[180,221],[222,229],[230,240],[241,252],[254,295],[296,303],[304,314],[315,326],[328,369],[370,377],[378,388],[389,400],[402,443],[444,451],[452,462],[463,474],[476,517],[518,525],[526,536],[537,548],[550,591],[592,599],[600,610],[611,622],[624,665],[666,673],[674,684],[685,696],[698,739],[740,747],[748,758],[759,770],[772,813],[814,821],[822,832],[833,844],[846,887],[888,895],[896,906],[907,918],[920,961],[962,969],[970,980],[981,992],[994,1035],[1036,1043],[1044,1054],[1055,1066],[1068,1109],[1110,1117],[1118,1128],[1129,1140],[1142,1183],[1184,1191],[1192,1202],[1203,1214],[1216,1257],[1258,1265],[1266,1276],[1277,1288],[1290,1331],[1332,1339],[1340,1350],[1351,1362],[1364,1405],[1406,1413],[1414,1424],[1425,1436],[1438,1479]],
    [[2,160],[163,517],[520,874],[877,1231],[1234,1588],[1591,1826]],
    [[0,160],[160,520],[520,800],[801,1161],[1161,1521],[1521,1604]],
    [[0,6],[13,17],[19,25],[27,33],[40,44],[46,52],[54,60],[67,71],[73,79],[81,87],[94,98],[100,106],[108,114],[121,125],[127,133],[135,141],[148,152],[154,160],[162,168],[175,179],[181,187],[189,195],[202,206],[208,214],[216,222],[229,233],[235,241],[243,249],[256,260],[262,268],[270,276],[283,287],[289,295],[297,303],[310,314],[316,322],[324,330],[337,341],[343,349],[351,357],[364,368],[370,376],[378,384],[391,395],[397,403],[405,411],[418,422],[424,430],[432,438],[445,449],[451,457],[459,465],[472,476],[478,484],[486,492],[499,503],[505,511],[513,519],[526,530],[532,538],[540,546],[553,557],[559,565],[567,573],[580,584],[586,592],[594,600],[607,611],[613,619],[621,627],[634,638],[640,646],[648,654],[661,665],[667,673],[675,681],[688,692],[694,700],[702,708],[715,719],[721,727],[729,735],[742,746],[748,754],[756,762],[769,773],[775,781],[783,789],[796,800],[802,808]],
  ],
  fallback: [
    [],
    [],
    [[0,15],[16,65],[66,81]],
    [[0,28],[29,76],[77,109],[110,115]],
    [[0,17],[18,44],[46,263],[264,308],[310,527],[528,572],[574,791],[792,836],[838,1055]],
    [[0,319],[319,854],[855,926],[927,1647],[1647,1651]],
    [[0,161],[161,522],[522,887]],
    [[0,158],[159,518],[519,878],[879,1238],[1239,1387]],
    [[0,160],[160,520],[520,880],[880,1240],[1240,1600],[1600,1800]],
    [[0,160],[160,520],[520,880],[880,1240],[1240,1600],[1600,1960],[1960,2320],[2320,2680],[2680,3040],[3040,3400],[3400,3760],[3760,4120],[4120,4480],[4480,4840],[4840,5200],[5200,5560],[5560,5920],[5920,6280],[6280,6640],[6640,7000],[7000,7360],[7360,7720],[7720,8080],[8080,8400]],
    [[0,7],[8,18],[19,30],[32,65],[66,73],[74,81],[82,92],[93,104],[106,139],[140,147],[148,155],[156,166],[167,178],[180,213],[214,221],[222,229],[230,240],[241,252],[254,287],[288,295],[296,303],[304,314],[315,326],[328,361],[362,369],[370,377],[378,388],[389,400],[402,435],[436,443],[444,451],[452,462],[463,474],[476,509],[510,517],[518,525],[526,536],[537,548],[550,583],[584,591],[592,599],[600,610],[611,622],[624,657],[658,665],[666,673],[674,684],[685,696],[698,731],[732,739],[740,747],[748,758],[759,770],[772,805],[806,813],[814,821],[822,832],[833,844],[846,879],[880,887],[888,895],[896,906],[907,918],[920,953],[954,961],[962,969],[970,980],[981,992],[994,1027],[1028,1035],[1036,1043],[1044,1054],[1055,1066],[1068,1101],[1102,1109],[1110,1117],[1118,1128],[1129,1140],[1142,1175],[1176,1183],[1184,1191],[1192,1202],[1203,1214],[1216,1249],[1250,1257],[1258,1265],[1266,1276],[1277,1288],[1290,1323],[1324,1331],[1332,1339],[1340,1350],[1351,1362],[1364,1397],[1398,1405],[1406,1413],[1414,1424],[1425,1436],[1438,1471],[1472,1479]],
    [[2,160],[163,517],[520,874],[877,1231],[1234,1588],[1591,1826]],
    [[0,160],[160,520],[520,800],[801,1161],[1161,1521],[1521,1604]],
    [[0,6],[13,17],[19,25],[27,33],[40,44],[46,52],[54,60],[67,71],[73,79],[81,87],[94,98],[100,106],[108,114],[121,125],[127,133],[135,141],[148,152],[154,160],[162,168],[175,179],[181,187],[189,195],[202,206],[208,214],[216,222],[229,233],[235,241],[243,249],[256,260],[262,268],[270,276],[283,287],[289,295],[297,303],[310,314],[316,322],[324,330],[337,341],[343,349],[351,357],[364,368],[370,376],[378,384],[391,395],[397,403],[405,411],[418,422],[424,430],[432,438],[445,449],[451,457],[459,465],[472,476],[478,484],[486,492],[499,503],[505,511],[513,519],[526,530],[532,538],[540,546],[553,557],[559,565],[567,573],[580,584],[586,592],[594,600],[607,611],[613,619],[621,627],[634,638],[640,646],[648,654],[661,665],[667,673],[675,681],[688,692],[694,700],[702,708],[715,719],[721,727],[729,735],[742,746],[748,754],[756,762],[769,773],[775,781],[783,789],[796,800],[802,808]],
  ],
};

describe("chunking compatibility", () => {
  for (const fallback of [false, true]) {
    for (const [caseIndex, { name, source }] of compatibilityCases.entries()) {
      test(`${name} preserves previous chunks with ${fallback ? "fallback" : "native"} segmentation`, () => {
        const segmenter = Intl.Segmenter;
        if (fallback) Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
        try {
          for (const backend of ["legacy", "soniox", "fishaudio", "elevenlabs"]) {
            for (const language of ["en", "uk", "invalid_locale!"]) {
              const policy = backend === "legacy" ? "legacy" : fallback ? "fallback" : "native";
              const expected = previousRanges[policy]![caseIndex]!.map(([start, end], index) => ({
                index, start, end, text: source.slice(start, end),
              }));
              expect(chunkSpeech(source, { backend, language })).toEqual(expected);
              if (backend === "legacy") expect(chunkSpeech(source)).toEqual(expected);
            }
          }
        } finally {
          Object.defineProperty(Intl, "Segmenter", { value: segmenter, configurable: true });
        }
      });
    }
  }
});

/** Count copied/iterated/inspected text, independent of CPU speed or load. */
function measuredChunks(source: string, backend: string | undefined, fallback: boolean) {
  let work = 0;
  const slice = String.prototype.slice;
  const iterate = String.prototype[Symbol.iterator];
  const pointAt = String.prototype.codePointAt;
  const regexTest = RegExp.prototype.test;
  const Segmenter = Intl.Segmenter;
  if (fallback) Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
  const segmenter = Intl.Segmenter?.prototype;
  const segment = segmenter?.segment;
  String.prototype.slice = function (start, end) {
    const result = slice.call(this, start, end);
    work += result.length;
    return result;
  };
  String.prototype[Symbol.iterator] = function* (): Generator<string, undefined, unknown> {
    for (const point of iterate.call(this)) { work++; yield point; }
    return undefined;
  };
  String.prototype.codePointAt = function (index) {
    work++;
    return pointAt.call(this, index);
  };
  RegExp.prototype.test = function (input) {
    work += input.length;
    return regexTest.call(this, input);
  };
  if (segmenter && segment) segmenter.segment = function (input) {
    work += input.length;
    return segment.call(this, input);
  };
  try {
    return { chunks: chunkSpeech(source, backend ? { backend } : undefined), work };
  } finally {
    String.prototype.slice = slice;
    String.prototype[Symbol.iterator] = iterate;
    String.prototype.codePointAt = pointAt;
    RegExp.prototype.test = regexTest;
    if (segmenter && segment) segmenter.segment = segment;
    if (fallback) Object.defineProperty(Intl, "Segmenter", { value: Segmenter, configurable: true });
  }
}

describe("bounded chunking work", () => {
  for (const backend of [undefined, "soniox", "fishaudio", "elevenlabs"]) {
    for (const fallback of [false, true]) {
      const policy = `${backend ?? "default"}/${fallback ? "fallback" : "native"}`;
      test(`${policy} rejects over-limit text before inspecting or copying it`, () => {
        for (const source of ["x".repeat(160_000), "x".repeat(MAX_TTS_MESSAGE_LENGTH + 1), " ".repeat(MAX_TTS_MESSAGE_LENGTH + 1), "😀".repeat(MAX_TTS_MESSAGE_LENGTH / 2 + 1)]) {
          const result = measuredChunks(source, backend, fallback);
          expect(result.work).toBe(0);
          expect(result.chunks).toHaveLength(0);
        }
      });
      test(`${policy} accepts the exact message limit with linear text work`, () => {
        for (const source of [
          "x".repeat(MAX_TTS_MESSAGE_LENGTH),
          "😀".repeat(MAX_TTS_MESSAGE_LENGTH / 2),
          "word ".repeat(MAX_TTS_MESSAGE_LENGTH / 5),
          "Done. ".repeat(Math.floor(MAX_TTS_MESSAGE_LENGTH / 6)),
          "Item\n".repeat(MAX_TTS_MESSAGE_LENGTH / 5),
        ]) {
          const result = measuredChunks(source, backend, fallback);
          expect(result.chunks.length).toBeGreaterThan(0);
          expect(result.work).toBeLessThanOrEqual(20 * source.length);
          expect(result.chunks.map((chunk) => chunk.text.replace(/\s/g, "")).join("")).toBe(source.replace(/\s/g, ""));
        }
      });
    }
  }
});
