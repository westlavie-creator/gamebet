/**
 * [changmen 扩展] 补单赔率上下沿。
 * 默认关：补单消费 / anyOdds 重试仍走 config.makeProfit。
 * 开启后替代这两处的最低赔门槛（入队 B()、手动补单、PM 续查不碰）。
 */
import { toFixed } from "@changmen/client-core/shared/format";
import type { MakeupOddsBandPrefs } from "@/types/extensionPrefs";

export function isMakeupOddsBandEnabled(
  prefs: MakeupOddsBandPrefs | null | undefined,
): boolean {
  return prefs?.enabled === true;
}

/**
 * 与 LoseOrder.getOdds(p) 同公式（自动补单）：1 / (1/p − 1/已成赔率)。
 * p≤1 为认亏侧；公式无解时返回 null。
 */
export function hedgeOddsAtProfit(filledOdds: number, profit: number): number | null {
  const filled = Number(filledOdds);
  const p = Number(profit);
  if (!(filled > 1) || !(p > 0) || !Number.isFinite(filled) || !Number.isFinite(p))
    return null;
  const denom = 1 / p - 1 / filled;
  if (!(denom > 0))
    return null;
  const implied = 1 / denom;
  if (!(implied > 1) || !Number.isFinite(implied))
    return null;
  return Number(toFixed(implied));
}

export interface MakeupOddsBandBounds {
  upperOdds: number;
  /** null = 下沿关闭：不高于上沿一律不补 */
  lowerOdds: number | null;
}

export function resolveMakeupOddsBandBounds(
  filledOdds: number,
  prefs: MakeupOddsBandPrefs,
): MakeupOddsBandBounds | null {
  const upperOdds = hedgeOddsAtProfit(filledOdds, prefs.upper);
  if (upperOdds == null)
    return null;
  if (!(Number(prefs.lower) > 0))
    return { upperOdds, lowerOdds: null };
  const lowerOdds = hedgeOddsAtProfit(filledOdds, prefs.lower);
  if (lowerOdds == null || lowerOdds >= upperOdds)
    return { upperOdds, lowerOdds: null };
  return { upperOdds, lowerOdds };
}

function inMakeupOddsBand(odds: number, bounds: MakeupOddsBandBounds): boolean {
  if (!(odds > 0))
    return true;
  if (odds > bounds.upperOdds)
    return false;
  if (bounds.lowerOdds == null)
    return true;
  return odds >= bounds.lowerOdds;
}

/**
 * `sortedDesc` 须已按补单侧赔率从高到低排。
 * 最高价在带内 → `[]`（本轮不补，不落到更差的馆）；
 * 最高价高于上沿 → 只保留仍高于上沿的候选；
 * 最高价低于下沿 → 全部保留（从最好的亏价开始）；
 * 公式无解 → `null`（调用方回退 makeProfit）。
 */
export function filterMakeupOddsBandCandidates<T>(
  sortedDesc: T[],
  getOdds: (item: T) => number,
  filledOdds: number,
  prefs: MakeupOddsBandPrefs,
): T[] | null {
  if (!sortedDesc.length)
    return [];
  const bounds = resolveMakeupOddsBandBounds(filledOdds, prefs);
  // 公式无解（极短已成赔率等）：返回 null，调用方回退 makeProfit，避免整轮永不补
  if (!bounds)
    return null;
  const best = getOdds(sortedDesc[0]);
  if (inMakeupOddsBand(best, bounds))
    return [];
  if (best > bounds.upperOdds)
    return sortedDesc.filter(item => getOdds(item) > bounds.upperOdds);
  return sortedDesc;
}

export function previewMakeupOddsBand(
  filledOdds: number,
  prefs: MakeupOddsBandPrefs,
): MakeupOddsBandBounds | null {
  return resolveMakeupOddsBandBounds(filledOdds, prefs);
}
