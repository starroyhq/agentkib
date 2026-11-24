// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionComposerInput } from "@agentkib/session-ui";
import { afterEach, describe, expect, it, vi } from "vitest";

const file = new File(["copied from Finder"], "copied.txt");
const emptyClipboard = { files: [], types: [], getData: () => "" };

function composer(
  overrides: {
    context?: string;
    disabled?: boolean;
    readClipboardFiles?: () => Promise<File[] | undefined>;
  } = {},
  onFiles = vi.fn(),
) {
  return (
    <SessionComposerInput
      editor={{ "aria-label": "Message" }}
      editorContextKey={overrides.context ?? "session"}
      attachments={{
        inputRef: null,
        label: "Attachment",
        disabled: overrides.disabled,
        onFiles,
      }}
      readClipboardFiles={overrides.readClipboardFiles}
      toolbar={null}
    />
  );
}

describe("clipboard and drop attachment intake", () => {
  afterEach(cleanup);

  it.each([emptyClipboard, { ...emptyClipboard, types: ["text/uri-list"] }])(
    "asks the desktop clipboard when the browser hides its file objects",
    async (fallbackClipboard) => {
      const readClipboardFiles = vi.fn().mockResolvedValue([file]);
      const onFiles = vi.fn();
      render(composer({ readClipboardFiles }, onFiles));
      const editor = screen.getByRole("textbox", { name: "Message" });
      const plainText = {
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? "Hello" : ""),
      };
      expect(fireEvent.paste(editor, { clipboardData: plainText })).toBe(true);
      expect(readClipboardFiles).not.toHaveBeenCalled();

      const browserFile = new File(["image"], "image.png", { type: "image/png" });
      fireEvent.paste(editor, { clipboardData: { files: [browserFile] } });
      expect(onFiles).toHaveBeenLastCalledWith([browserFile]);
      expect(readClipboardFiles).not.toHaveBeenCalled();

      expect(fireEvent.paste(editor, { clipboardData: fallbackClipboard })).toBe(false);
      await waitFor(() => expect(onFiles).toHaveBeenLastCalledWith([file]));
      expect(readClipboardFiles).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("acknowledges unreadable desktop file offers but leaves an empty clipboard unnoticed", async () => {
    const readClipboardFiles = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);
    const onFiles = vi.fn();
    render(composer({ readClipboardFiles }, onFiles));
    const editor = screen.getByRole("textbox");
    const form = editor.closest("form");
    await act(async () => {
      fireEvent.paste(editor, { clipboardData: emptyClipboard });
    });
    expect(form).not.toHaveAttribute("data-attachment-rejected");

    await act(async () => {
      fireEvent.paste(editor, { clipboardData: emptyClipboard });
    });
    expect(form).toHaveAttribute("data-attachment-rejected");
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("discards a delayed clipboard response after the composer changes session", async () => {
    let resolve!: (files: File[]) => void;
    const pending = new Promise<File[]>((onResolve) => {
      resolve = onResolve;
    });
    const readClipboardFiles = vi.fn(() => pending);
    const onFiles = vi.fn();
    const view = render(composer({ readClipboardFiles }, onFiles));
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: emptyClipboard });
    view.rerender(composer({ context: "another-session", readClipboardFiles }, onFiles));

    await act(async () => resolve([file]));

    expect(onFiles).not.toHaveBeenCalled();
  });

  it("does not read the native clipboard when this composer cannot receive attachments", () => {
    const readClipboardFiles = vi.fn();
    const onFiles = vi.fn();
    render(composer({ disabled: true, readClipboardFiles }, onFiles));
    const editor = screen.getByRole("textbox");
    fireEvent.paste(editor, { clipboardData: emptyClipboard });
    expect(editor.closest("form")).toHaveAttribute("data-attachment-rejected");
    expect(readClipboardFiles).not.toHaveBeenCalled();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("signals an unreadable file reference without interpreting ordinary clipboard text as a path", () => {
    const onFiles = vi.fn();
    render(composer({}, onFiles));
    const editor = screen.getByRole("textbox");
    const data = {
      files: [],
      types: ["text/plain", "text/uri-list"],
      getData: (format: string) =>
        format === "text/uri-list" ? "file:///private/copied.txt" : "copied.txt",
    };
    expect(fireEvent.paste(editor, { clipboardData: data })).toBe(false);
    expect(editor.closest("form")).toHaveAttribute("data-attachment-rejected");
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("rejects a directory drop without confusing a zero-byte file for a directory", () => {
    const onFiles = vi.fn();
    render(composer({}, onFiles));
    const editor = screen.getByRole("textbox");
    const emptyFile = new File([], "empty.txt");
    const directory = new File([], "folder");
    const items = [
      {
        kind: "file",
        getAsFile: () => directory,
        webkitGetAsEntry: () => ({ isDirectory: true }),
      },
      {
        kind: "file",
        getAsFile: () => emptyFile,
        webkitGetAsEntry: () => ({ isDirectory: false }),
      },
    ];
    expect(
      fireEvent.drop(editor, { dataTransfer: { files: [directory], items: items.slice(0, 1) } }),
    ).toBe(false);
    expect(onFiles).not.toHaveBeenCalled();
    expect(editor.closest("form")).toHaveAttribute("data-attachment-rejected");
    expect(fireEvent.drop(editor, { dataTransfer: { files: [directory, emptyFile], items } })).toBe(
      false,
    );
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([emptyFile]);
  });
});
