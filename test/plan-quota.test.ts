import { describe, expect, test } from "bun:test";

import {
  formatPlanQuota,
  formatResetTime,
  normalizePlanQuota,
  planQuotaEndpoint,
  PlanQuotaPoller,
  type PlanQuotaSnapshot
} from "../packages/zcode-tui/src/plan-quota.ts";

const now = new Date(2026, 8, 10, 14, 0, 0).getTime();

describe("plan quota endpoint", () => {
  test("derives the monitoring endpoint from provider base URLs", () => {
    expect(planQuotaEndpoint("https://open.bigmodel.cn/api/anthropic")).toBe(
      "https://open.bigmodel.cn/api/monitor/usage/quota/limit"
    );
    expect(planQuotaEndpoint("https://api.z.ai/api/anthropic")).toBe(
      "https://api.z.ai/api/monitor/usage/quota/limit"
    );
  });

  test("rejects unknown hosts and malformed URLs", () => {
    expect(planQuotaEndpoint("https://api.anthropic.com/v1")).toBeUndefined();
    expect(planQuotaEndpoint("not a url")).toBeUndefined();
    expect(planQuotaEndpoint("https://evil.example/api/anthropic")).toBeUndefined();
  });
});

describe("normalizePlanQuota", () => {
  const payload = {
    code: 200,
    data: {
      level: "lite",
      limits: [
        {
          type: "CREDIT_LIMIT",
          unit: 3,
          number: 5,
          usage: 2000,
          currentValue: 264,
          remaining: 1735,
          percentage: 13,
          nextResetTime: 1789039779692
        },
        {
          type: "CREDIT_LIMIT",
          unit: 6,
          number: 1,
          usage: 10000,
          currentValue: 4310,
          remaining: 5689,
          percentage: 43,
          nextResetTime: 1789528372996
        }
      ]
    }
  };

  test("extracts rolling windows with labels and reset times", () => {
    const snapshot = normalizePlanQuota(payload, "bigmodel", now);
    expect(snapshot).toBeDefined();
    expect(snapshot!.provider).toBe("bigmodel");
    expect(snapshot!.level).toBe("lite");
    expect(snapshot!.windows).toHaveLength(2);
    expect(snapshot!.windows[0]).toEqual({
      key: "5h",
      used: 264,
      total: 2000,
      percentage: 13,
      nextResetTime: 1789039779692
    });
    expect(snapshot!.windows[1]!.key).toBe("week");
  });

  test("returns undefined for responses without usable limits", () => {
    expect(normalizePlanQuota({ code: 200, data: { limits: [] } }, "bigmodel")).toBeUndefined();
    expect(normalizePlanQuota(null, "bigmodel")).toBeUndefined();
    expect(normalizePlanQuota({ data: {} }, "bigmodel")).toBeUndefined();
  });
});

describe("formatPlanQuota", () => {
  test("renders usage, percentage, and reset time per window", () => {
    const snapshot = normalizePlanQuota({
      data: {
        limits: [
          { unit: 3, number: 5, usage: 2000, currentValue: 264, percentage: 13, nextResetTime: new Date(2026, 8, 10, 15, 56).getTime() },
          { unit: 6, number: 1, usage: 10000, currentValue: 4310, percentage: 43, nextResetTime: new Date(2026, 8, 16, 9, 5).getTime() }
        ]
      }
    }, "bigmodel", now)!;

    const text = formatPlanQuota(snapshot, now);
    expect(text.full).toContain("5h 264/2K 13% reset 15:56");
    expect(text.full).toContain("week 4.3K/10K 43% reset 09-16 09:05");
    expect(text.full).not.toContain("plan");
    expect(text.compact).toBe("5h 13% reset 15:56 · week 43% reset 09-16 09:05");
  });
});

describe("formatResetTime", () => {
  test("shows the clock time for today and the date otherwise", () => {
    const todayEvening = new Date(2026, 8, 10, 21, 30).getTime();
    const otherDay = new Date(2026, 8, 16, 9, 5).getTime();
    expect(formatResetTime(todayEvening, now)).toBe("21:30");
    expect(formatResetTime(otherDay, now)).toBe("09-16 09:05");
  });
});

describe("PlanQuotaPoller", () => {
  test("fetches the resolved target and delivers a normalized snapshot", async () => {
    let requestedUrl = "";
    let requestedAuth = "";
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedAuth = String(new Headers(init?.headers).get("Authorization"));
      return new Response(JSON.stringify({
        data: { limits: [{ unit: 3, number: 5, usage: 2000, currentValue: 264, percentage: 13 }] }
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const results: PlanQuotaSnapshot[] = [];
    const poller = new PlanQuotaPoller({
      resolve: () => ({ provider: "bigmodel", endpoint: "https://open.bigmodel.cn/api/monitor/usage/quota/limit", apiKey: "secret" }),
      onResult: (snapshot) => results.push(snapshot),
      fetchImpl,
      intervalMs: 3_600_000
    });
    await poller.refresh();
    poller.stop();

    expect(requestedUrl).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(requestedAuth).toBe("secret");
    expect(results).toHaveLength(1);
    expect(results[0]!.windows[0]!.key).toBe("5h");
  });

  test("keeps polling when no target resolves and survives HTTP failures", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const results: PlanQuotaSnapshot[] = [];
    const poller = new PlanQuotaPoller({
      resolve: () => undefined,
      onResult: (snapshot) => results.push(snapshot),
      fetchImpl,
      intervalMs: 3_600_000
    });
    await poller.refresh();
    poller.stop();

    const failing = new PlanQuotaPoller({
      resolve: () => ({ provider: "bigmodel", endpoint: "https://open.bigmodel.cn/api/monitor/usage/quota/limit", apiKey: "secret" }),
      onResult: (snapshot) => results.push(snapshot),
      fetchImpl,
      intervalMs: 3_600_000
    });
    await failing.refresh();
    failing.stop();

    expect(results).toHaveLength(0);
  });
});
