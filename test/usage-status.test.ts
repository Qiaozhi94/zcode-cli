import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import {
  formatClockTime,
  UsageStatusLine,
  usagePollInterval,
  usageStatusText,
  USAGE_POLL_ACTIVE_INTERVAL_MS,
  USAGE_POLL_IDLE_INTERVAL_MS
} from "../packages/zcode-tui/src/usage-status.ts";
import type { PlanQuotaSnapshot } from "../packages/zcode-tui/src/plan-quota.ts";

const fetchedAt = new Date(2026, 8, 10, 14, 32, 5).getTime();

const snapshot: PlanQuotaSnapshot = {
  provider: "bigmodel",
  level: "lite",
  fetchedAt,
  windows: [
    { key: "5h", used: 1100, total: 2000, percentage: 55, nextResetTime: new Date(2026, 8, 10, 19, 29).getTime() },
    { key: "week", used: 5200, total: 10000, percentage: 51, nextResetTime: new Date(2026, 8, 16, 11, 12).getTime() }
  ]
};

describe("usage status text", () => {
  test("renders quota windows with reset times and the quota refresh time", () => {
    const text = usageStatusText(snapshot);

    expect(text).toBeDefined();
    expect(text!.full).toContain("5h 1.1K/2K 55% reset 19:29");
    expect(text!.full).toContain("week 5.2K/10K 51% reset 09-16 11:12");
    expect(text!.full).toContain("updated 14:32:05");
    expect(text!.full).not.toContain("plan");
  });

  test("keeps a compact form with the windows for narrow terminals", () => {
    const text = usageStatusText(snapshot);

    expect(text).toBeDefined();
    expect(text!.compact).toContain("5h 55% reset 19:29");
    expect(text!.compact).toContain("week 51% reset 09-16 11:12");
    expect(text!.compact.length).toBeLessThan(text!.full.length);
  });

  test("renders nothing until a plan quota snapshot exists", () => {
    expect(usageStatusText(undefined)).toBeUndefined();
  });

  test("renders a snapshot without reset times", () => {
    const text = usageStatusText({
      ...snapshot,
      windows: [{ key: "5h", used: 1100, total: 2000, percentage: 55 }]
    });

    expect(text).toBeDefined();
    expect(text!.full).toBe("5h 1.1K/2K 55% · updated 14:32:05");
  });
});

describe("usage status line", () => {
  test("renders nothing until content is set", () => {
    const line = new UsageStatusLine();
    expect(line.render(80)).toEqual([]);
  });

  test("falls back to the compact form before truncating", () => {
    const line = new UsageStatusLine();
    line.setContent(
      "plan 5h 1.1K/2K 55% reset 19:29 · week 5.2K/10K 51% reset 09-16 11:12 · updated 14:32:05",
      "5h 55% reset 19:29 · week 51% reset 09-16 11:12"
    );

    const [wide] = line.render(120);
    expect(wide).toContain("1.1K/2K");

    const [narrow] = line.render(50);
    expect(narrow).toContain("5h 55%");
    expect(narrow).not.toContain("1.1K/2K");
    expect(visibleWidth(narrow ?? "")).toBeLessThanOrEqual(50);
  });

  test("renders nothing when even the compact form does not fit", () => {
    const line = new UsageStatusLine();
    line.setContent("plan 5h 55% reset 19:29", "5h 55% reset 19:29");
    expect(line.render(10)).toEqual([]);
  });
});

describe("usage polling", () => {
  test("polls faster while a turn is active and slower when idle", () => {
    expect(usagePollInterval(true)).toBe(USAGE_POLL_ACTIVE_INTERVAL_MS);
    expect(usagePollInterval(false)).toBe(USAGE_POLL_IDLE_INTERVAL_MS);
    expect(USAGE_POLL_ACTIVE_INTERVAL_MS).toBeLessThan(USAGE_POLL_IDLE_INTERVAL_MS);
  });
});

describe("formatClockTime", () => {
  test("pads hours, minutes, and seconds", () => {
    expect(formatClockTime(new Date(2026, 0, 1, 9, 5, 3).getTime())).toBe("09:05:03");
  });
});
