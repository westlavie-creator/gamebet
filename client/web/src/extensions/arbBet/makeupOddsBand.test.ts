import { describe, expect, it } from "vitest";
import { LoseOrder } from "@/models/loseOrder";
import {
  filterMakeupOddsBandCandidates,
  hedgeOddsAtProfit,
  isMakeupOddsBandEnabled,
  previewMakeupOddsBand,
  resolveMakeupOddsBandBounds,
} from "@/extensions/arbBet/makeupOddsBand";
import type { MakeupOddsBandPrefs } from "@/types/extensionPrefs";

const on: MakeupOddsBandPrefs = { enabled: true, upper: 1.02, lower: 0.96 };
const off: MakeupOddsBandPrefs = { enabled: false, upper: 1.02, lower: 0.96 };

function item(odds: number, type = "OB") {
  return { type, odds };
}

describe("makeupOddsBand", () => {
  it("is off unless enabled === true", () => {
    expect(isMakeupOddsBandEnabled(undefined)).toBe(false);
    expect(isMakeupOddsBandEnabled(off)).toBe(false);
    expect(isMakeupOddsBandEnabled(on)).toBe(true);
  });

  it("hedgeOddsAtProfit matches LoseOrder.getOdds", () => {
    const order = new LoseOrder({ betOdds: 2, isCreateOrder: false });
    expect(hedgeOddsAtProfit(2, 1.02)).toBe(order.getOdds(1.02));
    expect(hedgeOddsAtProfit(2, 0.96)).toBe(order.getOdds(0.96));
    expect(hedgeOddsAtProfit(2, 1)).toBe(order.getOdds(1));
  });

  it("filled=2 default band is ~1.85–2.08", () => {
    const bounds = previewMakeupOddsBand(2, on);
    expect(bounds?.lowerOdds).toBeCloseTo(1.846, 2);
    expect(bounds?.upperOdds).toBeCloseTo(2.082, 2);
  });

  it("lower 0 disables the loss side", () => {
    const bounds = resolveMakeupOddsBandBounds(2, { enabled: true, upper: 1.02, lower: 0 });
    expect(bounds?.lowerOdds).toBeNull();
    expect(bounds?.upperOdds).toBeGreaterThan(2);
  });

  it("skips the whole tick when best odds sit in the band", () => {
    const filled = 2;
    const items = [item(2.00), item(1.85)];
    const out = filterMakeupOddsBandCandidates(items, i => i.odds, filled, on);
    expect(out).toEqual([]);
  });

  it("does not fall through to a worse quote while best is in-band", () => {
    const out = filterMakeupOddsBandCandidates(
      [item(2.00, "OB"), item(1.80, "RAY")],
      i => i.odds,
      2,
      on,
    );
    expect(out).toEqual([]);
  });

  it("keeps only quotes above the upper bound when best is above", () => {
    const out = filterMakeupOddsBandCandidates(
      [item(2.10, "OB"), item(2.00, "RAY"), item(1.80, "IA")],
      i => i.odds,
      2,
      on,
    );
    expect(out?.map(i => i.type)).toEqual(["OB"]);
  });

  it("places from the least-bad quote when best is below the lower bound", () => {
    const out = filterMakeupOddsBandCandidates(
      [item(1.80, "OB"), item(1.70, "RAY")],
      i => i.odds,
      2,
      on,
    );
    expect(out?.map(i => i.type)).toEqual(["OB", "RAY"]);
  });

  it("returns null when hedge formula cannot be solved so caller can fall back", () => {
    const out = filterMakeupOddsBandCandidates(
      [item(2.00)],
      i => i.odds,
      1.01,
      { enabled: true, upper: 1.02, lower: 0.96 },
    );
    expect(out).toBeNull();
  });
});
