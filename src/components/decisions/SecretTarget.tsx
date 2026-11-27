import { secretTargetParts } from "@/lib/secretRequests/view";

/** What a request writes to on one line: a long variable name gives way first, with an ellipsis,
    and «→ file» stays whole after it, so a narrow row still says where the secret goes. */
export function SecretTarget({ target, className, ...data }: { target: string; className: string } & Record<`data-${string}`, string>) {
  const { key, filename } = secretTargetParts(target);
  return (
    <span {...data} className={`flex min-w-0 whitespace-nowrap ${className}`} title={target}>
      {key ? <span className="min-w-[2ch] truncate">{key}</span> : null}
      <span className="min-w-0 truncate [flex-shrink:0.001]">{key ? `\u00a0→\u00a0${filename}` : filename}</span>
    </span>
  );
}
