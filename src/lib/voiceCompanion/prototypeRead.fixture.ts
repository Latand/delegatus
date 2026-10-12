import type { BoardTask } from "@/lib/tasks/types";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const prototypePicture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
export function prototypeTask(id = "review-task", project = "fixture"): BoardTask {
  const at = "2026-10-10T12:00:00.000Z";
  const media = { id: "a".repeat(64), mime: "image/png" as const, bytes: prototypePicture.length };
  const screens = ["Board", "Details", "Agents", "Questions", "History", "Menu"];
  const round: PrototypeReviewRound = {
    id: `pr_${"b".repeat(32)}`, taskId: id, project, title: "Свіжа добірка прототипів", createdAt: at,
    source: { conversationId: null }, publicationKey: "fixture-publication", inputDigest: "c".repeat(64),
    variants: [44, 44, 40].map((count, index) => ({ number: index + 1, name: ["Рядок", "Панель", "Картки"][index],
      description: (["Деталі залишаються в рядку задачі. ", "Деталі відкриваються у бічній панелі. ", "Кожна задача займає окрему картку. "][index]
        + "Повний опис розташування елементів і поведінки меню. ".repeat(3)).trim(), videos: [],
      frames: Array.from({ length: count }, (_, n) => ({ image: { ...media }, ...(n < 16 ? { original: { ...media } } : {}),
        caption: `${screens[Math.floor(n / 8) % screens.length]} · ${[1440, 1000, 390][Math.floor(n / 4) % 3]} px · ${n % 4 < 2 ? "uk" : "en"} · ${n % 2 ? "dark" : "light"}${n === 0 ? ". Today: rows retain their order." : ""}`,
        width: [1440, 1000, 390][Math.floor(n / 4) % 3], lang: n % 4 < 2 ? "uk" as const : "en" as const })),
    })),
    questions: ["Розміщення", "Порядок", "Щільність"].map((text, n) => ({ id: `question-${n}`, text: `${text}: який варіант обрати?`,
      options: [{ label: "Зверху", recommended: true }, { label: "У рядку" }, { label: "У панелі" }] })),
  };
  return { id, project, text: "Меню робочих задач", status: "inbox", placement: "unplaced", assignments: [], createdAt: at, updatedAt: at, prototypeReviews: [round] };
}

/** Stores real, independently addressed pictures so both provider paths exercise pinned reads. */
export async function storePrototypePictures(task: BoardTask, picture = prototypePicture): Promise<void> {
  const { prototypeRoot, storedMediaPath } = await import("@/lib/prototypeReview/store");
  for (const round of task.prototypeReviews ?? []) {
    fs.mkdirSync(path.join(prototypeRoot(), round.id), { recursive: true });
    for (const variant of round.variants) {
      for (const frame of variant.frames) for (const [kind, media] of [["image", frame.image], ["original", frame.original]] as const) {
        if (!media) continue;
        const bytes = Buffer.concat([picture, Buffer.from(`${variant.number} ${kind}`)]);
        media.id = createHash("sha256").update(bytes).digest("hex"); media.bytes = bytes.length;
        fs.writeFileSync(storedMediaPath(fs.realpathSync(prototypeRoot()), round.id, media), bytes);
      }
    }
  }
}
