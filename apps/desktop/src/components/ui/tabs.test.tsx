// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@agentkib/ui/tabs";

describe("Tabs readable states", () => {
  afterEach(cleanup);

  it.each(["default", "line"] as const)(
    "keeps inactive %s labels readable while preserving selection and disabled behavior",
    (variant) => {
      const onValueChange = vi.fn();
      render(
        <Tabs defaultValue="overview" onValueChange={onValueChange}>
          <TabsList variant={variant}>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="details">
              <svg aria-hidden="true" />
              Details
            </TabsTrigger>
            <TabsTrigger value="unavailable" disabled>
              Unavailable
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview">Overview content</TabsContent>
          <TabsContent value="details">Details content</TabsContent>
        </Tabs>,
      );
      const overview = screen.getByRole("tab", { name: "Overview" });
      const details = screen.getByRole("tab", { name: "Details" });
      const unavailable = screen.getByRole("tab", { name: "Unavailable" });
      expect(overview).toHaveAttribute("aria-selected", "true");
      expect(details).toHaveClass("text-tab-inactive-foreground");
      expect(details).not.toHaveClass("text-foreground/60");
      expect(details.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      expect(unavailable).toHaveAttribute("aria-disabled", "true");
      expect(unavailable).toHaveAttribute("data-disabled");
      expect(unavailable).toHaveClass("disabled:opacity-50", "aria-disabled:opacity-50");
      fireEvent.click(unavailable);
      expect(onValueChange).not.toHaveBeenCalled();
      expect(overview).toHaveAttribute("aria-selected", "true");
      fireEvent.click(details);
      expect(details).toHaveAttribute("aria-selected", "true");
      expect(details).toHaveAttribute("data-active");
      expect(details).toHaveClass("data-active:text-foreground");
      expect(overview).toHaveAttribute("aria-selected", "false");
      expect(screen.getByRole("tabpanel")).toHaveTextContent("Details content");
      expect(onValueChange.mock.calls[0][0]).toBe("details");
    },
  );
});
