import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UserQuestionRequest } from "@agentkib/web-client";
import { QuestionForm } from "./QuestionForm";

afterEach(cleanup);
const request: UserQuestionRequest = {
  requestId: "request",
  turnId: "turn",
  supported: true,
  questions: [
    {
      id: "one",
      question: "选择方案",
      options: [{ label: "方案 A", description: "说明 A" }, { label: "方案 B" }],
      multiSelect: false,
      allowCustom: true,
    },
    {
      id: "two",
      question: "选择功能",
      options: [{ label: "搜索" }, { label: "目录" }],
      multiSelect: true,
      allowCustom: false,
    },
  ],
};
it("requires all questions and submits original option labels", () => {
  const submit = vi.fn();
  render(<QuestionForm request={request} locale="zh-CN" enabled busy={false} onSubmit={submit} />);
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/方案 A/));
  fireEvent.click(screen.getByLabelText("搜索"));
  fireEvent.click(screen.getByLabelText("目录"));
  fireEvent.click(screen.getByRole("button"));
  expect(submit).toHaveBeenCalledWith({ one: ["方案 A"], two: ["搜索", "目录"] });
});
it("custom single choice replaces selected option and requires nonempty text", () => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={{ ...request, questions: [request.questions[0]] }}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  fireEvent.click(screen.getByLabelText(/方案 A/));
  fireEvent.click(screen.getByLabelText("自定义回答"));
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "自己的方案" } });
  fireEvent.click(screen.getByRole("button"));
  expect(submit).toHaveBeenCalledWith({ one: ["自己的方案"] });
});
it("expired or unauthorized questions cannot submit", () => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={request}
      locale="zh-CN"
      enabled={false}
      busy={false}
      onSubmit={submit}
    />,
  );
  expect(screen.getByRole("button")).toBeDisabled();
  expect(screen.getByLabelText("搜索")).toBeDisabled();
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  expect(submit).not.toHaveBeenCalled();
});

it("accepts the 4096-character boundary and blocks oversized programmatic input", () => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={{ ...request, questions: [request.questions[0]] }}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  fireEvent.click(screen.getByLabelText("自定义回答"));
  const input = screen.getByRole("textbox");
  expect(input).toHaveAttribute("maxlength", "4096");
  fireEvent.change(input, { target: { value: "x".repeat(4096) } });
  fireEvent.click(screen.getByRole("button"));
  expect(submit).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: "x".repeat(4097) } });
  expect(screen.getByRole("alert")).toHaveTextContent("4096");
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  expect(submit).toHaveBeenCalledTimes(1);
});

it("matches the native single-answer UTF-8 byte boundary", () => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={{ ...request, questions: [request.questions[0]] }}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  fireEvent.click(screen.getByLabelText("自定义回答"));
  const input = screen.getByRole("textbox");
  for (const value of ["文".repeat(2730), "文".repeat(2730) + "ab"]) {
    fireEvent.change(input, { target: { value } });
    fireEvent.click(screen.getByRole("button"));
  }
  expect(submit).toHaveBeenCalledTimes(2);
  fireEvent.change(input, { target: { value: "文".repeat(2731) } });
  expect(screen.getByRole("alert")).toHaveTextContent("8192");
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  expect(submit).toHaveBeenCalledTimes(2);
});

it("rejects a custom answer that duplicates a selected multi-choice option", () => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={{ ...request, questions: [{ ...request.questions[0], multiSelect: true }] }}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  fireEvent.click(screen.getByLabelText(/方案 A/));
  fireEvent.click(screen.getByLabelText("自定义回答"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "方案 A" } });
  expect(screen.getByRole("alert")).toHaveTextContent("重复");
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "新方案" } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button")).toBeEnabled();
});

it("counts the complete UTF-8 JSON body, including context", () => {
  const submit = vi.fn();
  const questions = Array.from({ length: 9 }, (_, i) => ({
    ...request.questions[0],
    id: String(i),
    question: `问题 ${i}`,
    options: [],
  }));
  render(
    <QuestionForm
      request={{ ...request, questions }}
      requestContext={{ sessionId: "s".repeat(64), bootId: "b".repeat(43), expectedRevision: 123 }}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  screen.getAllByLabelText("自定义回答").forEach((input) => fireEvent.click(input));
  screen
    .getAllByRole("textbox")
    .forEach((input) => fireEvent.change(input, { target: { value: "文".repeat(2700) } }));
  expect(screen.getByRole("alert")).toHaveTextContent("总量");
  expect(screen.getByRole("button")).toBeDisabled();
  fireEvent.submit(screen.getByRole("button").closest("form")!);
  expect(submit).not.toHaveBeenCalled();
  screen
    .getAllByRole("textbox")
    .forEach((input) => fireEvent.change(input, { target: { value: "文".repeat(1000) } }));
  expect(screen.getByRole("button")).toBeEnabled();
});

it.each(["__proto__", "constructor", "toString"])("supports native prototype-named ID %s", (id) => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={{ ...request, questions: [{ ...request.questions[0], id }] }}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  fireEvent.click(screen.getByLabelText(/方案 A/));
  fireEvent.click(screen.getByRole("button"));
  expect(submit.mock.calls[0][0]).toEqual(Object.fromEntries([[id, ["方案 A"]]]));
  fireEvent.click(screen.getByLabelText("自定义回答"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "自己的方案" } });
  fireEvent.click(screen.getByRole("button"));
  expect(submit.mock.calls[1][0]).toEqual(Object.fromEntries([[id, ["自己的方案"]]]));
});

it("keeps prototype-named multi-choice answers independent", () => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={{ ...request, questions: [{ ...request.questions[1], id: "__proto__" }] }}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  fireEvent.click(screen.getByLabelText("搜索"));
  fireEvent.click(screen.getByLabelText("目录"));
  fireEvent.click(screen.getByLabelText("搜索"));
  fireEvent.click(screen.getByRole("button"));
  expect(submit.mock.calls[0][0]).toEqual(Object.fromEntries([["__proto__", ["目录"]]]));
});

it.each([
  { ...request, supported: false },
  { ...request, questions: null },
  { ...request, questions: [{ ...request.questions[0], options: null }] },
  { ...request, questions: [{ ...request.questions[0], options: [null] }] },
  { ...request, questions: [{ ...request.questions[0], question: {} }] },
  { ...request, questions: [request.questions[0], request.questions[0]] },
])("safely displays unsupported or malformed native contracts", (native) => {
  const submit = vi.fn();
  render(
    <QuestionForm
      request={native as unknown as UserQuestionRequest}
      locale="zh-CN"
      enabled
      busy={false}
      onSubmit={submit}
    />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("此问题已失效或暂时无法回答");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
});
