/**
 * [changmen 扩展] 补单赔率上下沿。
 * 默认关：补单消费 / anyOdds 重试仍走 config.makeProfit。
 * 开启后替代补单消费 / 拒单即时重试门槛（入队 B() 在开启时跳过；手动补单、PM 续查不碰）。
 *
 * 区间按「已成腿打平赔率 × 系数」，不是初赔/当前赔率，也不是 makeProfit 利润率公式。
 * 例：已成 2 → 打平 2，默认 [2×0.96, 2×1.02] = [1.92, 2.04] 内不补。
 */
import { toFixed } from "@changmen/client-core/shared/format";
import { calcBreakEvenOdds } from "@/domain/betting/makeupStakeCalc";
import { normalizeMakeupOddsBand, type MakeupOddsBandPrefs } from "@/types/extensionPrefs";

export function isMakeupOddsBandEnabled(
  prefs: MakeupOddsBandPrefs | null | undefined,
): boolean {
  return prefs?.enabled === true;
}

function scaleBreakEvenOdds(breakEven: number, factor: number): number | null {
  const scaled = breakEven * factor;
  if (!(scaled > 1) || !Number.isFinite(scaled))
    return null;
  return Number(toFixed(scaled));
}

export interface MakeupOddsBandBounds {
  breakEvenOdds: number;
  upperOdds: number;
  /** null = 下沿关闭：不高于上沿一律不补 */
  lowerOdds: number | null;
}

export function resolveMakeupOddsBandBounds(
  filledOdds: number,
  rawPrefs: MakeupOddsBandPrefs,
): MakeupOddsBandBounds | null {
  const prefs = normalizeMakeupOddsBand(rawPrefs);
  const breakEvenOdds = calcBreakEvenOdds(filledOdds);
  if (breakEvenOdds == null)
    return null;
  const upperOdds = scaleBreakEvenOdds(breakEvenOdds, prefs.upper);
  if (upperOdds == null)
    return null;
  if (!(Number(prefs.lower) > 0))
    return { breakEvenOdds, upperOdds, lowerOdds: null };
  const lowerOdds = scaleBreakEvenOdds(breakEvenOdds, prefs.lower);
  if (lowerOdds == null || lowerOdds >= upperOdds)
    return { breakEvenOdds, upperOdds, lowerOdds: null };
  return { breakEvenOdds, upperOdds, lowerOdds };
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
 * 打平无解 → `null`（调用方回退 makeProfit）。
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

/**
 * 侧栏 / 提示用的展示赔率。关上下沿或手动补单：与 A8 相同 `getOdds(makeProfit)`。
 * 开着时展示打平价（带子中轴），公式失败则回退 makeProfit。
 */
export function makeupDisplayOdds(
  order: { betOdds: number; isCreateOrder: boolean; getOdds: (p?: number) => number },
  makeProfit: number,
  bandPrefs?: MakeupOddsBandPrefs | null,
): number {
  if (order.isCreateOrder || !isMakeupOddsBandEnabled(bandPrefs) || !bandPrefs)
    return order.getOdds(makeProfit);
  const bounds = resolveMakeupOddsBandBounds(order.betOdds, bandPrefs);
  return bounds?.breakEvenOdds ?? order.getOdds(makeProfit);
}
