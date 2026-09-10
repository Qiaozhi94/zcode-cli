import {
  truncateToWidth,
  visibleWidth,
  type Component
} from "@earendil-works/pi-tui";

import { formatPlanQuota, type PlanQuotaSnapshot } from "./plan-quota.ts";

export const USAGE_POLL_ACTIVE_INTERVAL_MS = 2_000;
export const USAGE_POLL_IDLE_INTERVAL_MS = 10_000;

const horizontalPadding = 1;
const sectionSeparator = " · ";

function paddedTwoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

export function formatClockTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${paddedTwoDigits(date.getHours())}:${paddedTwoDigits(date.getMinutes())}:${paddedTwoDigits(date.getSeconds())}`;
}

export function usagePollInterval(active: boolean): number {
  return active ? USAGE_POLL_ACTIVE_INTERVAL_MS : USAGE_POLL_IDLE_INTERVAL_MS;
}

/**
 * Plan-quota line shown below the footer: rolling quota windows with their
 * reset times, then when the quota data itself was last refreshed. Renders
 * nothing until a plan quota snapshot exists.
 */
export function usageStatusText(planQuota: PlanQuotaSnapshot | undefined): { full: string; compact: string } | undefined {
  if (!planQuota) return undefined;
  const plan = formatPlanQuota(planQuota);
  return {
    full: `${plan.full} · updated ${formatClockTime(planQuota.fetchedAt)}`,
    compact: plan.compact
  };
}

export class UsageStatusLine implements Component {
  private full?: string;
  private compact?: string;

  setContent(text?: string, compactText?: string): void {
    this.full = text || undefined;
    this.compact = compactText || undefined;
  }

  render(width: number): string[] {
    if (width <= 0 || !this.full) return [];
    const innerWidth = Math.max(0, width - horizontalPadding);
    if (visibleWidth(this.full) <= innerWidth) return [` ${this.full}`];
    const compact = this.compact ?? this.full;
    if (visibleWidth(compact) > innerWidth) return [];
    return [` ${truncateToWidth(compact, innerWidth, "…")}`];
  }

  invalidate(): void {}
}
