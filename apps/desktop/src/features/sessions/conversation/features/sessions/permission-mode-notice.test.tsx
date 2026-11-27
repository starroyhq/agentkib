// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "../../desktop-reader-test-utils";
import { PermissionModeNotice, permissionModeSummaryCopy } from "@agentkib/session-ui";

describe("compact Claude permission notice", () => {
  afterEach(cleanup);

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "renders only the short risk label without expandable explanatory prose in %s",
    (locale) => {
      for (const mode of ["auto", "dontAsk", "bypassPermissions", null] as const) {
        const view = render(
          <PermissionModeNotice
            locale={locale}
            permission={{ mode, possiblyAuto: true, ...(mode !== null ? { previous: true } : {}) }}
            compact
          />,
        );
        const key = mode ?? "possiblyAuto";
        const notice = screen.getByRole("status");
        expect(notice).toHaveTextContent(permissionModeSummaryCopy[locale][key]);
        expect(notice).not.toHaveTextContent(
          /由分类器审核操作|Shift\+Tab|auto mode is active|change it in the original/i,
        );
        expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        expect(screen.queryByRole("button")).toBeNull();
        view.unmount();
      }
    },
  );

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "renders the same concise status label without compact mode in %s",
    (locale) => {
      for (const mode of ["auto", "dontAsk", "bypassPermissions"] as const) {
        const view = render(
          <PermissionModeNotice permission={{ mode, previous: true }} locale={locale} />,
        );
        const notice = screen.getByRole("status");
        expect(notice).toHaveTextContent(permissionModeSummaryCopy[locale][mode]);
        expect(notice).not.toHaveTextContent(
          /由分类器审核操作|Shift\+Tab|auto mode is active|change it in the original/i,
        );
        expect(notice.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
        expect(screen.queryByRole("button")).toBeNull();
        view.unmount();
      }
    },
  );
});
