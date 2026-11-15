// @vitest-environment jsdom
import { memo, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { changeLocale, initializeI18n, tr, formatDateTime } from "./i18n";
import { useI18n } from "./useI18n";

const instant = "2026-09-07T08:00:00Z";
const View = memo(function View() {
  const { tr, formatDateTime, formatNumber, localizeMessage } = useI18n();
  const [count, setCount] = useState(0);
  return (
    <div>
      <button onClick={() => setCount(count + 1)}>{tr("sessions.more")}</button>
      <output data-testid="counter">{count}</output>
      <time>{formatDateTime(instant)}</time>
      <span>{formatNumber(123456)}</span>
      <p>{localizeMessage({ key: "nav.settings" })}</p>
    </div>
  );
});

afterEach(cleanup);
describe("reactive internationalization", () => {
  it("updates memoized content and formatters without remounting state or requiring parent renders", async () => {
    await initializeI18n("en-US");
    const { container } = render(<View />);
    const original = screen.getByRole("button");
    fireEvent.click(original);
    try {
      for (const locale of ["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("button", { name: tr("sessions.more") })).toBe(original);
        expect(screen.getByTestId("counter").textContent).toBe("1");
        expect(container.querySelector("time")?.textContent).toBe(formatDateTime(instant, locale));
        expect(screen.getByText(new Intl.NumberFormat(locale).format(123456))).toBeTruthy();
        expect(screen.getByText(tr("nav.settings"))).toBeTruthy();
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
});
