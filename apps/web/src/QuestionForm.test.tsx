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
