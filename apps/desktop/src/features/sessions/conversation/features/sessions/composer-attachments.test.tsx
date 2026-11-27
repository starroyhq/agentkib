// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSER_ATTACHMENT_PREVIEW_MAX_BYTES,
  ComposerAttachmentStrip,
  SessionComposerInput,
  classifyAttachmentFile,
  composerAttachmentCopy,
  parseDelimitedPreview,
  parseTextPreview,
  splitAttachmentFilename,
  type ComposerAttachmentCardItem,
} from "@agentkib/session-ui";

const copy = {
  listLabel: composerAttachmentCopy("zh-CN").listLabel,
  preview: "预览附件",
  uploading: "上传中",
  uploadFailed: "上传失败",
  retry: "重试",
  remove: (name: string) => `移除附件: ${name}`,
};

describe("ComposerAttachmentStrip", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders image thumbnail cards and opens preview on click", () => {
    const onPreview = vi.fn();
    const onRemove = vi.fn();
    const item: ComposerAttachmentCardItem = {
      key: "img-1",
      name: "dashboard-shot.png",
      file: new File(["png"], "dashboard-shot.png", { type: "image/png" }),
      previewUrl: "blob:preview-1",
    };

    render(
      <ComposerAttachmentStrip
        items={[item]}
        copy={copy}
        onPreview={onPreview}
        onRemove={onRemove}
      />,
    );

    const previewButton = screen.getByRole("button", { name: "预览附件: dashboard-shot.png" });
    expect(previewButton.querySelector("img")).toHaveAttribute("src", "blob:preview-1");
    fireEvent.click(previewButton);
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(item);
  });

  it("renders CSV mini-table, text mini-lines, and binary icon previews while slicing large files", async () => {
    const csvFile = new File(
      ['Region,Revenue,Growth\n"North, East",1200,+14%\nSouth,980,+8%\n'],
      "quarterly-revenue-summary-2026.csv",
      { type: "text/csv" },
    );
    const codeFile = new File(
      ["export function sum(a: number, b: number) {\n  return a + b;\n}\n"],
      "calculator.ts",
      { type: "text/typescript" },
    );
    const pdfFile = new File(["%PDF-1.7 binary"], "architecture-proposal.pdf", {
      type: "application/pdf",
    });

    const csvSliceSpy = vi.spyOn(csvFile, "slice");
    const pdfSliceSpy = vi.spyOn(pdfFile, "slice");

    render(
      <ComposerAttachmentStrip
        items={[
          { key: "csv", name: csvFile.name, file: csvFile },
          { key: "code", name: codeFile.name, file: codeFile },
          { key: "pdf", name: pdfFile.name, file: pdfFile },
        ]}
        copy={copy}
        onRemove={vi.fn()}
      />,
    );

    const csvCard = screen.getByRole("group", { name: "quarterly-revenue-summary-2026.csv" });
    await waitFor(() =>
      expect(csvCard.querySelector('[data-attachment-preview="table"]')).not.toBeNull(),
    );
    expect(csvCard.querySelector("table")).toHaveTextContent("North, East");
    expect(csvSliceSpy).toHaveBeenCalledWith(0, COMPOSER_ATTACHMENT_PREVIEW_MAX_BYTES);

    const codeCard = screen.getByRole("group", { name: "calculator.ts" });
    await waitFor(() =>
      expect(codeCard.querySelector('[data-attachment-preview="text"]')).not.toBeNull(),
    );
    expect(codeCard).toHaveTextContent("export function sum");

    const pdfCard = screen.getByRole("group", { name: "architecture-proposal.pdf" });
    expect(pdfCard.querySelector('[data-attachment-preview="icon"]')).not.toBeNull();
    expect(pdfCard).toHaveTextContent("PDF");
    expect(pdfSliceSpy).not.toHaveBeenCalled();
  });

  it("overlays upload progress directly on the card and exposes status in aria-label", async () => {
    const item: ComposerAttachmentCardItem = {
      key: "up-1",
      name: "release-notes.md",
      file: new File(["# Release"], "release-notes.md", { type: "text/markdown" }),
      uploading: true,
      percent: 45,
    };

    render(<ComposerAttachmentStrip items={[item]} copy={copy} onRemove={vi.fn()} />);

    const card = screen.getByRole("listitem", { name: "release-notes.md · 上传中 45%" });
    expect(card).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    const progress = await screen.findByRole("progressbar", { name: "上传中" });
    expect(progress).toHaveAttribute("aria-valuenow", "45");
    expect(within(card).getByRole("progressbar", { name: "上传中" })).toBe(progress);
  });

  it("shows failure badge and retry button directly on failed cards", () => {
    const onRetry = vi.fn();
    const item: ComposerAttachmentCardItem = {
      key: "fail-1",
      name: "metrics.csv",
      file: new File(["a,b\n1,2"], "metrics.csv", { type: "text/csv" }),
      failed: true,
    };

    render(
      <ComposerAttachmentStrip items={[item]} copy={copy} onRetry={onRetry} onRemove={vi.fn()} />,
    );

    const card = screen.getByRole("listitem", { name: "metrics.csv · 上传失败" });
    expect(within(card).getByRole("status")).toHaveTextContent("上传失败");
    const retry = within(card).getByRole("button", { name: "重试" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(item);
  });

  it("removes attachments via mouse click and keyboard Delete or Backspace", () => {
    const onRemove = vi.fn();
    const imageItem: ComposerAttachmentCardItem = {
      key: "img",
      name: "shot.png",
      file: new File(["png"], "shot.png", { type: "image/png" }),
      previewUrl: "blob:shot",
    };
    const fileItem: ComposerAttachmentCardItem = {
      key: "doc",
      name: "notes.txt",
      file: new File(["hello"], "notes.txt", { type: "text/plain" }),
    };

    render(
      <ComposerAttachmentStrip
        items={[imageItem, fileItem]}
        copy={copy}
        onPreview={vi.fn()}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "移除附件: shot.png" }));
    expect(onRemove).toHaveBeenNthCalledWith(1, imageItem);

    const previewButton = screen.getByRole("button", { name: "预览附件: shot.png" });
    previewButton.focus();
    fireEvent.keyDown(previewButton, { key: "Delete" });
    expect(onRemove).toHaveBeenNthCalledWith(2, imageItem);

    const fileCard = screen.getByRole("group", { name: "notes.txt" });
    fileCard.focus();
    fireEvent.keyDown(fileCard, { key: "Backspace" });
    expect(onRemove).toHaveBeenNthCalledWith(3, fileItem);
  });

  it("disables and dims removal while sending or awaiting confirmation", () => {
    const onRemove = vi.fn();
    const item: ComposerAttachmentCardItem = {
      key: "locked-1",
      name: "report.csv",
      file: new File(["k,v\n1,2"], "report.csv", { type: "text/csv" }),
    };

    render(
      <ComposerAttachmentStrip items={[item]} copy={copy} removeDisabled onRemove={onRemove} />,
    );

    const removeButton = screen.getByRole("button", { name: "移除附件: report.csv" });
    expect(removeButton).toBeDisabled();
    expect(removeButton.className).toContain("disabled:opacity-55");

    fireEvent.click(removeButton);
    const fileCard = screen.getByRole("group", { name: "report.csv" });
    fileCard.focus();
    fireEvent.keyDown(fileCard, { key: "Delete" });
    fireEvent.keyDown(fileCard, { key: "Backspace" });
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("classifies file formats and splits extensions for middle truncation", () => {
    expect(classifyAttachmentFile("sales.csv").previewMode).toBe("table");
    expect(classifyAttachmentFile("table.tsv").delimiter).toBe("\t");
    expect(classifyAttachmentFile("config.json").previewMode).toBe("text");
    expect(classifyAttachmentFile("deck.pptx").previewMode).toBe("icon");
    expect(classifyAttachmentFile("bundle.zip").previewMode).toBe("icon");
    expect(classifyAttachmentFile("icon.svg", "image/svg+xml").previewMode).toBe("icon");

    expect(splitAttachmentFilename("monthly-report-2026-q4.csv")).toEqual({
      stem: "monthly-report-2026-q4",
      ext: ".csv",
    });
    expect(splitAttachmentFilename("Makefile")).toEqual({ stem: "Makefile", ext: "" });

    expect(parseDelimitedPreview('a,b\n"c,d",e\n', ",")).toEqual([
      ["a", "b"],
      ["c,d", "e"],
    ]);
    expect(parseDelimitedPreview("binary\0data", ",")).toBeNull();
    expect(parseTextPreview("\nfirst\nsecond\n")).toEqual(["first", "second"]);
    expect(parseTextPreview("bin\0ary")).toBeNull();
  });

  it("renders the attachment strip above the composer textarea", () => {
    const item: ComposerAttachmentCardItem = {
      key: "top-1",
      name: "summary.csv",
      file: new File(["a,b\n1,2"], "summary.csv", { type: "text/csv" }),
    };

    render(
      <SessionComposerInput
        editor={{ "aria-label": "输入消息" }}
        beforeEditor={<ComposerAttachmentStrip items={[item]} copy={copy} onRemove={vi.fn()} />}
        toolbar={null}
      />,
    );

    const strip = screen.getByRole("list", { name: copy.listLabel });
    const editor = screen.getByRole("textbox", { name: "输入消息" });
    expect(strip.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
