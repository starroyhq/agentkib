// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@agentkib/ui/dropdown-menu";

describe("DropdownMenu destructive roles", () => {
  afterEach(cleanup);

  it("separates text and icon roles while retaining disabled behavior", async () => {
    const onDelete = vi.fn();
    const onDisabledDelete = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>Session actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <svg aria-hidden="true" />
            Delete session
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" disabled onClick={onDisabledDelete}>
            <svg aria-hidden="true" />
            Delete permanently
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = await screen.findByRole("menuitem", { name: "Delete session" });
    const disabled = screen.getByRole("menuitem", { name: "Delete permanently" });
    for (const menuItem of [item, disabled]) {
      expect(menuItem).toHaveAttribute("data-variant", "destructive");
      expect(menuItem).toHaveClass(
        "data-[variant=destructive]:text-destructive-text",
        "data-[variant=destructive]:focus:text-destructive-text",
        "data-[variant=destructive]:*:[svg]:text-destructive-icon",
      );
      expect(menuItem).not.toHaveClass("data-[variant=destructive]:*:[svg]:text-destructive-text");
      expect(menuItem.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    expect(disabled).toHaveAttribute("aria-disabled", "true");
    expect(disabled).toHaveAttribute("data-disabled");
    expect(disabled).toHaveClass("data-disabled:pointer-events-none", "data-disabled:opacity-50");
    fireEvent.click(disabled);
    expect(onDisabledDelete).not.toHaveBeenCalled();
    expect(item).toBeVisible();
    fireEvent.click(item);
    expect(onDelete).toHaveBeenCalledOnce();
  });
});
