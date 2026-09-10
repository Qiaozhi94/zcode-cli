import { asString, isRecord } from "./types.ts";
import { formatTokens } from "./goal-status.ts";

/**
 * GLM Coding Plan quota, as exposed by the same monitoring API the provider
 * consoles use (verified against open.bigmodel.cn and api.z.ai):
 *   GET {provider-origin}/api/monitor/usage/quota/limit
 *   Authorization: <api key>
 * The response carries rolling windows (e.g. 5-hour and weekly prompt
 * allowances) with usage, remaining quota, and the next reset timestamp.
 */
export const PLAN_QUOTA_LIMIT_PATH = "/api/monitor/usage/quota/limit";

export const PLAN_QUOTA_POLL_INTERVAL_MS = 30_000;
const PLAN_QUOTA_REQUEST_TIMEOUT_MS = 8_000;

export interface PlanQuotaWindow {
  key: string;
  used?: number;
  total?: number;
  percentage?: number;
  nextResetTime?: number;
}

export interface PlanQuotaSnapshot {
  provider: string;
  level?: string;
  windows: PlanQuotaWindow[];
  fetchedAt: number;
}

export interface PlanQuotaTarget {
  provider: string;
  endpoint: string;
  apiKey: string;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? number : undefined;
}

/** Derive the monitoring-API origin from the provider's own base URL. */
export function planQuotaEndpoint(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    if (!host.endsWith("z.ai") && !host.endsWith("bigmodel.cn")) return undefined;
    return `${url.origin}${PLAN_QUOTA_LIMIT_PATH}`;
  } catch {
    return undefined;
  }
}

function windowKey(unit: number, count: number, index: number): string {
  if (unit === 3) return `${count}h`;
  if (unit === 4) return count === 1 ? "day" : `${count}d`;
  if (unit === 6) return count === 1 ? "week" : `${count}w`;
  return `window${index + 1}`;
}

export function normalizePlanQuota(
  payload: unknown,
  provider: string,
  fetchedAt: number = Date.now()
): PlanQuotaSnapshot | undefined {
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
  const limits = data && Array.isArray(data.limits) ? data.limits.filter(isRecord) : [];
  const windows = limits.flatMap((item, index): PlanQuotaWindow[] => {
    const percentage = finiteNumber(item.percentage);
    const used = nonNegativeNumber(item.currentValue);
    const total = nonNegativeNumber(item.usage);
    const nextResetTime = nonNegativeNumber(item.nextResetTime);
    if (percentage === undefined && used === undefined && total === undefined) return [];
    const unit = nonNegativeNumber(item.unit);
    const count = nonNegativeNumber(item.number);
    return [{
      key: unit !== undefined && count !== undefined ? windowKey(unit, count, index) : `window${index + 1}`,
      used,
      total,
      percentage,
      nextResetTime
    }];
  });
  if (windows.length === 0) return undefined;
  return {
    provider,
    level: asString(data?.level),
    windows,
    fetchedAt
  };
}

function paddedTwoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatResetTime(timestamp: number, now: number): string {
  const reset = new Date(timestamp);
  const time = `${paddedTwoDigits(reset.getHours())}:${paddedTwoDigits(reset.getMinutes())}`;
  const current = new Date(now);
  const isToday = reset.getFullYear() === current.getFullYear()
    && reset.getMonth() === current.getMonth()
    && reset.getDate() === current.getDate();
  return isToday ? time : `${paddedTwoDigits(reset.getMonth() + 1)}-${paddedTwoDigits(reset.getDate())} ${time}`;
}

export function formatPlanQuota(
  snapshot: PlanQuotaSnapshot,
  now: number = Date.now()
): { full: string; compact: string } {
  const full = [];
  const compact = [];
  for (const window of snapshot.windows) {
    const usage = window.used !== undefined && window.total
      ? `${formatTokens(window.used)}/${formatTokens(window.total)}`
      : undefined;
    const percentage = window.percentage !== undefined ? `${window.percentage}%` : undefined;
    const reset = window.nextResetTime !== undefined
      ? `reset ${formatResetTime(window.nextResetTime, now)}`
      : undefined;
    full.push([window.key, usage, percentage, reset].filter(Boolean).join(" "));
    compact.push([window.key, percentage, reset].filter(Boolean).join(" "));
  }
  return { full: full.join(" · "), compact: compact.join(" · ") };
}

export interface PlanQuotaPollerOptions {
  resolve: () => PlanQuotaTarget | undefined;
  onResult: (snapshot: PlanQuotaSnapshot) => void;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

/**
 * Polls the plan quota endpoint on a slow cadence. The target is re-resolved
 * before every fetch so model/provider switches are picked up; targets without
 * an API key or from unknown hosts resolve to undefined and are skipped.
 */
export class PlanQuotaPoller {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly options: PlanQuotaPollerOptions) {}

  start(delay: number = PLAN_QUOTA_POLL_INTERVAL_MS): void {
    this.schedule(delay);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(delay: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
    this.timer.unref?.();
  }

  async refresh(): Promise<void> {
    const target = this.options.resolve();
    const fetchImpl = this.options.fetchImpl ?? fetch;
    if (target) {
      try {
        const response = await fetchImpl(target.endpoint, {
          headers: {
            Authorization: target.apiKey,
            Accept: "application/json"
          },
          signal: AbortSignal.timeout(PLAN_QUOTA_REQUEST_TIMEOUT_MS)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const snapshot = normalizePlanQuota(await response.json(), target.provider);
        if (snapshot) this.options.onResult(snapshot);
      } catch {
        // Plan quota is supplementary; keep the previous snapshot on failures.
      }
    }
    this.schedule(this.options.intervalMs ?? PLAN_QUOTA_POLL_INTERVAL_MS);
  }
}
