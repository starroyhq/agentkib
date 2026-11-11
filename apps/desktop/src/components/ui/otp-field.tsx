"use client";

import { OTPField as OTPFieldPrimitive } from "@base-ui/react/otp-field";

import { cn } from "cn";

/** One box per character; typing, paste and backspace move between boxes. */
function OtpField({
  className,
  length,
  ...props
}: OTPFieldPrimitive.Root.Props & { length: number }) {
  return (
    <OTPFieldPrimitive.Root
      data-slot="otp-field"
      length={length}
      className={cn("flex flex-wrap gap-2", className)}
      {...props}
    >
      {Array.from({ length }, (_, index) => (
        <OTPFieldPrimitive.Input
          key={index}
          data-slot="otp-field-input"
          className="size-10 rounded-lg border border-input bg-transparent text-center font-mono text-lg transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30"
        />
      ))}
    </OTPFieldPrimitive.Root>
  );
}

export { OtpField };
