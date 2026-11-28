import * as React from "react";
import { cn } from "cn";

function Disclosure({ className, ...props }: React.ComponentProps<"details">) {
  return <details data-slot="disclosure" className={cn(className)} {...props} />;
}

function DisclosureSummary({ className, ...props }: React.ComponentProps<"summary">) {
  return <summary data-slot="disclosure-summary" className={cn(className)} {...props} />;
}

export { Disclosure, DisclosureSummary };
