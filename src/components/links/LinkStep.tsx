import type { ReactNode } from "react";

/** One numbered step. A step that cannot act yet stays in place, greyed. */
export function LinkStep({ n, title, waiting = false, children }: { n: number; title: string; waiting?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3" data-linked-step={n} data-waiting={waiting ? "" : undefined}>
      <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sunken text-ui font-semibold text-primary">{n}</span>
      <div className={`min-w-0 flex-1 space-y-2 ${waiting ? "text-muted" : ""}`}>
        <h4 className={`text-body font-semibold ${waiting ? "text-muted" : "text-primary"}`}>{title}</h4>
        {children}
      </div>
    </li>
  );
}
