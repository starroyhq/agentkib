import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "cn";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "text-sm font-medium bg-primary text-primary-foreground hover:bg-[var(--primary-hover)]",
        outline:
          "text-sm font-medium border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "text-sm font-medium bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "text-sm font-medium hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        destructive:
          "text-sm font-medium bg-[var(--destructive-soft)] text-destructive-text hover:bg-[var(--destructive-soft-hover)] focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        link: "text-sm font-medium text-primary-text underline-offset-4 hover:underline",
        // Takes the surrounding font and color, so a bare button reads like the text around it.
        bare: "rounded-none border-0 bg-transparent text-inherit whitespace-normal shadow-none hover:bg-transparent active:translate-y-0",
      },
      size: {
        default:
          "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-9",
        content: "h-auto min-h-0 w-auto gap-0 px-0 py-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  const legacyClasses = typeof className === "string" ? className : "";
  const legacyVariant = legacyClasses
    .split(/\s+/)
    .reduce<VariantProps<typeof buttonVariants>["variant"]>((current, token) => {
      if (token === "ghost") return "outline";
      if (token === "reject") return "destructive";
      if (token === "icon-danger") return "destructive";
      if (token === "link") return "link";
      return current;
    }, "default");
  const legacySize = legacyClasses
    .split(/\s+/)
    .some((token) => token === "icon-button" || token === "icon-danger")
    ? "icon"
    : size;
  const cleanedClassName = legacyClasses
    .split(/\s+/)
    .filter(
      (token) =>
        !["primary", "ghost", "approve", "reject", "icon-button", "icon-danger", "link"].includes(
          token,
        ),
    )
    .join(" ")
    .trim();

  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(
        buttonVariants({
          variant: variant === "default" ? legacyVariant : variant,
          size: legacySize,
          className: cleanedClassName,
        }),
      )}
      {...props}
    />
  );
}

export { Button, buttonVariants };
