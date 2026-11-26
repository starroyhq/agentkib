// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { MemoryRecord } from "@/core/types";
import { MemoryCard } from "./MemoryCard";

const record: MemoryRecord = {
  id: "memory-one",
  project_id: "workspace-one",
  memory_type: "project_fact",
  content: "Keep project instructions",
  status: "pending",
  created_at: "2026-10-16T00:00:00Z",
};

describe("MemoryCard review", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
  });
  afterEach(cleanup);

  it("exits editing after approval and renders the approved record read only", async () => {
    const review = vi.fn().mockResolvedValue(undefined);
    const view = render(<MemoryCard record={record} onReview={review} />);
    fireEvent.click(screen.getByRole("button", { name: tr("common.edit") }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Approved content" } });
    fireEvent.click(screen.getByRole("button", { name: tr("memory.saveApprove") }));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    view.rerender(
      <MemoryCard
        record={{ ...record, status: "approved", content: "Approved content" }}
        onReview={review}
      />,
    );
    expect(screen.getByText("Approved content")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: tr("memory.invalidate") })).toBeVisible();
  });

  it("hides an open editor when the record is approved by a refresh", () => {
    const review = vi.fn();
    const view = render(<MemoryCard record={record} onReview={review} />);
    fireEvent.click(screen.getByRole("button", { name: tr("common.edit") }));
    view.rerender(<MemoryCard record={{ ...record, status: "approved" }} onReview={review} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText(record.content)).toBeVisible();
  });

  it("locks competing review actions until the callback settles and keeps edited content on failure", async () => {
    let reject!: (reason: Error) => void;
    const review = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
      )
      .mockResolvedValue(undefined);
    render(<MemoryCard record={record} onReview={review} />);
    fireEvent.click(screen.getByRole("button", { name: tr("common.edit") }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Reviewed instructions" } });
    const approve = screen.getByRole("button", { name: tr("memory.saveApprove") });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole("button", { name: tr("common.reject") }));
    expect(review).toHaveBeenCalledExactlyOnceWith(record.id, "approved", "Reviewed instructions");
    expect(approve).toBeDisabled();
    expect(screen.getByRole("button", { name: tr("memory.cancelEdit") })).toBeDisabled();
    expect(screen.getByRole("button", { name: tr("common.reject") })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(approve.querySelector(".animate-spin")).not.toBeInTheDocument();
    await waitFor(() => expect(approve.querySelector(".animate-spin")).toBeInTheDocument());
    await act(async () => reject(new Error("Review unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Review unavailable");
    expect(screen.getByRole("textbox")).toHaveValue("Reviewed instructions");
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(review).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(approve).toBeEnabled());
    expect(review).toHaveBeenLastCalledWith(record.id, "approved", "Reviewed instructions");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    ["pending", "common.approve", "approved"],
    ["pending", "common.reject", "rejected"],
    ["approved", "memory.invalidate", "invalidated"],
  ] as const)(
    "handles %s → %s failures and permits retry",
    async (status, label, desiredStatus) => {
      const review = vi
        .fn()
        .mockRejectedValueOnce(new Error("Review failed"))
        .mockResolvedValue(undefined);
      render(<MemoryCard record={{ ...record, status }} onReview={review} />);
      const action = screen.getByRole("button", { name: tr(label) });
      fireEvent.click(action);
      expect(await screen.findByRole("alert")).toHaveTextContent("Review failed");
      expect(action).toBeEnabled();
      fireEvent.click(action);
      await waitFor(() => expect(review).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(action).toBeEnabled());
      expect(review).toHaveBeenLastCalledWith(record.id, desiredStatus, undefined);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});
