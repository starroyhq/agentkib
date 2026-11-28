import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { useUiSurface, type UiSurface } from "./config";

const desktopBadgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-foreground",
        destructive: "border-transparent bg-destructive/10 text-destructive-text",
        ghost: "border-transparent text-foreground",
        link: "border-transparent text-primary-text underline-offset-4",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const webBadgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-[var(--primary-hover-strong)]",
        secondary: "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-[var(--destructive-badge-bg)] text-[var(--destructive-badge-foreground)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-[var(--destructive-badge-bg)]",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary-text underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

type BadgeVariantProps = VariantProps<typeof desktopBadgeVariants>;

function badgeVariants(props?: BadgeVariantProps & { surface?: UiSurface }): string {
  const { surface = "desktop", ...rest } = props ?? {};
  return surface === "web" ? webBadgeVariants(rest) : desktopBadgeVariants(rest);
}

function Badge({
  className,
  variant = "default",
  surface,
  ...props
}: HTMLAttributes<HTMLSpanElement> & BadgeVariantProps & { surface?: UiSurface }) {
  const resolvedSurface = useUiSurface(surface);
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant, surface: resolvedSurface }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
