// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PropsWithChildren } from "react";
import { api } from "@/core/api";
import type { ContextDoctorReport, ContextDoctorSummary } from "@/core/types";
import { homeKeys, useHomeDoctorReport } from "./home-query";

vi.mock("@/core/api", () => ({ api: { workspaceDoctorReport: vi.fn() } }));

afterEach(cleanup);

describe("workspace diagnostic summary cache", () => {
  it("updates existing summary entries when fresh diagnostics are loaded", async () => {
    const oldSummary = {
      workspace_id: "workspace",
      error_count: 0,
      warning_count: 2,
    } as ContextDoctorSummary;
    const freshSummary = { ...oldSummary, warning_count: 0 };
    const otherSummary = { ...oldSummary, workspace_id: "other" };
    const report = { summary: freshSummary, issues: [], matrix: [] } as ContextDoctorReport;
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const sharedKey = homeKeys.doctorSummaries(["workspace", "other"]);
    const unrelatedKey = homeKeys.doctorSummaries(["other"]);
    queryClient.setQueryData(sharedKey, { workspace: oldSummary, other: otherSummary });
    queryClient.setQueryData(unrelatedKey, { other: otherSummary });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useHomeDoctorReport("workspace"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(sharedKey)).toEqual({
      workspace: freshSummary,
      other: otherSummary,
    });
    expect(queryClient.getQueryData(unrelatedKey)).toEqual({ other: otherSummary });
  });

  it("removes a failed report from every summary cache and restores it only where requested", async () => {
    const summary = {
      workspace_id: "workspace",
      error_count: 0,
      warning_count: 0,
    } as ContextDoctorSummary;
    const other = { ...summary, workspace_id: "other" };
    const report = { summary, issues: [], matrix: [] } as ContextDoctorReport;
    const failure = new Error("Diagnostic read failed");
    vi.mocked(api.workspaceDoctorReport)
      .mockResolvedValueOnce(report)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(report);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const homeKey = homeKeys.doctorSummaries(["workspace", "other"]);
    const listKey = homeKeys.doctorSummaries(["workspace"]);
    const otherKey = homeKeys.doctorSummaries(["other"]);
    client.setQueryData(homeKey, { workspace: summary, other });
    client.setQueryData(listKey, { workspace: summary });
    client.setQueryData(otherKey, { other });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useHomeDoctorReport("workspace"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(failure);
    expect(client.getQueryData(homeKey)).toEqual({ other });
    expect(client.getQueryData(listKey)).toEqual({});
    expect(client.getQueryData(otherKey)).toEqual({ other });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(homeKey)).toEqual({ workspace: summary, other });
    expect(client.getQueryData(listKey)).toEqual({ workspace: summary });
    expect(client.getQueryData(otherKey)).toEqual({ other });
  });
});
