import type { HTMLAttributes } from "react";

import { cn } from "cn";

function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)}
      aria-hidden="true"
      {...props}
    />
  );
}

export { Skeleton };
