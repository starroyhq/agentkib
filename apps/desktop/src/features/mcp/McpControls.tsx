import { Children, isValidElement, useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

export function McpChoice({
  value,
  onValueChange,
  disabled,
  children,
  "aria-label": label,
}: {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  children: ReactNode;
  "aria-label"?: string;
}) {
  const chosen = Children.toArray(children).find(
    (child) => isValidElement<{ value: string }>(child) && child.props.value === value,
  );
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(String(next));
      }}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue>
          {isValidElement<{ children: ReactNode }>(chosen) ? chosen.props.children : value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}
export function McpDisclosure({
  title,
  description,
  children,
  className,
  defaultOpen,
  open,
  onOpenChange,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const descriptionId = useId();
  return (
    <Collapsible
      className={className}
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
    >
      {description ? (
        <CollapsibleTrigger
          className="group"
          aria-describedby={descriptionId}
          render={
            <Button
              variant="bare"
              size="content"
              className="w-full justify-start gap-2 p-4 text-left"
            />
          }
        >
          <ChevronRight
            size={16}
            aria-hidden="true"
            className="shrink-0 transition-transform group-aria-expanded:rotate-90"
          />
          <span>{title}</span>
          <span
            id={descriptionId}
            aria-hidden="true"
            className="min-w-0 whitespace-normal text-sm font-normal text-muted-foreground"
          >
            {description}
          </span>
        </CollapsibleTrigger>
      ) : (
        <CollapsibleTrigger render={<Button variant="outline" className="w-full justify-start" />}>
          {title}
        </CollapsibleTrigger>
      )}
      <CollapsibleContent className={description ? "grid gap-4 px-4 pb-4" : "grid gap-4 pt-3"}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
