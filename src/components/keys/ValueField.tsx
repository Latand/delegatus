"use client";

import { Eye, EyeOff } from "lucide-react";
import type { ComponentPropsWithRef } from "react";

type InputProps = Omit<ComponentPropsWithRef<"input">, "value" | "defaultValue" | "name" | "type">;
type Reveal = { shown: boolean; label: string; toggle: () => void; className: string };

/** Write-only input shared by Keys and Decisions. The eye only changes its type. */
export function ValueField({ reveal, ...input }: InputProps & { reveal?: Reveal }) {
  return (
    <>
      <input {...input} type={reveal?.shown ? "text" : "password"} autoComplete="off" autoCorrect="off"
        autoCapitalize="none" spellCheck={false} data-1p-ignore="" data-lpignore="true" data-bwignore="" />
      {reveal ? (
        <button type="button" aria-label={reveal.label} aria-pressed={reveal.shown} disabled={input.disabled}
          className={reveal.className} onClick={reveal.toggle}>
          {reveal.shown ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
        </button>
      ) : null}
    </>
  );
}
