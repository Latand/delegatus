import { Fragment } from "react";

/**
 * A branch on a line of its own (variant 3, frame 3a): it wraps only after a
 * «/», never inside a segment at a hyphen, and a segment wider than the line
 * ends in an ellipsis, with the whole name in the title.
 */
export function BranchName({ branch, className = "" }: { branch: string; className?: string }) {
  const segments = branch.split(/(?<=\/)/);
  return (
    <span className={`block [overflow-wrap:normal] ${className}`} title={branch} data-branch-name="">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index ? <wbr /> : null}
          <span className="inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom" data-branch-segment="">{segment}</span>
        </Fragment>
      ))}
    </span>
  );
}
