// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button class compatibility", () => {
  afterEach(cleanup);

  it("preserves primary text and hover utilities on a bare button", () => {
    render(
      <Button variant="bare" className="text-primary-text hover:text-primary-text">
        Pending issues
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Pending issues" })).toHaveClass(
      "text-primary-text",
      "hover:text-primary-text",
    );
  });

  it("gives buttons with a look of their own the label font, and a bare button the surrounding one", () => {
    render(
      <>
        <Button>Save</Button>
        <Button variant="bare">Open card</Button>
        <Button variant="bare" className="text-xs font-semibold">
          View all
        </Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("text-sm", "font-medium");
    expect(screen.getByRole("button", { name: "Open card" })).not.toHaveClass(
      "text-sm",
      "font-medium",
    );
    expect(screen.getByRole("button", { name: "View all" })).toHaveClass(
      "text-xs",
      "font-semibold",
    );
  });

  it("preserves primary surface and custom-property hover utilities", () => {
    render(
      <Button
        variant="bare"
        className="bg-primary text-primary-foreground hover:bg-[var(--primary-hover-strong)]"
      >
        Continue
      </Button>,
    );
    expect(screen.getByRole("button", { name: "Continue" })).toHaveClass(
      "bg-primary",
      "text-primary-foreground",
      "hover:bg-[var(--primary-hover-strong)]",
    );
  });

  it.each([
    ["primary", "bg-primary", "h-9"],
    ["approve", "bg-primary", "h-9"],
    ["ghost", "border-border", "h-9"],
    ["reject", "text-destructive-text", "h-9"],
    ["link", "text-primary-text", "h-9"],
    ["icon-button", "bg-primary", "size-8"],
    ["icon-danger", "text-destructive-text", "size-8"],
  ])("retains the legacy %s marker's variant and size", (marker, variantClass, sizeClass) => {
    render(<Button className={marker}>Legacy action</Button>);
    const button = screen.getByRole("button", { name: "Legacy action" });
    expect(button).toHaveClass(variantClass, sizeClass);
    expect(button).not.toHaveClass(marker);
  });

  it.each([
    ["ghost reject", "text-destructive-text"],
    ["reject ghost", "border-border"],
  ])("preserves the last legacy variant's priority for %s", (markers, variantClass) => {
    render(<Button className={markers}>Legacy action</Button>);
    const button = screen.getByRole("button", { name: "Legacy action" });
    expect(button).toHaveClass(variantClass);
    expect(button).not.toHaveClass("ghost", "reject");
  });
});
