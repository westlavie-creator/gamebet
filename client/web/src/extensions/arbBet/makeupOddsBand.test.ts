import { describe, expect, it } from "vitest";
import { LoseOrder } from "@/models/loseOrder";
import {
  filterMakeupOddsBandCandidates,
  isMakeupOddsBandEnabled,
  makeupDisplayOdds,
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

  it("filled=2 default band is 打平2 × 0.96/1.02", () => {
    const bounds = previewMakeupOddsBand(2, on);
    expect(bounds?.breakEvenOdds).toBe(2);
    expect(bounds?.lowerOdds).toBeCloseTo(1.92, 3);
    expect(bounds?.upperOdds).toBeCloseTo(2.04, 3);
  });

  it("uses break-even of the filled leg, not the filled odds themselves", () => {
    const bounds = previewMakeupOddsBand(1.8, on);
    expect(bounds?.breakEvenOdds).toBeCloseTo(2.25, 2);
    expect(bounds?.lowerOdds).toBeCloseTo(2.25 * 0.96, 2);
    expect(bounds?.upperOdds).toBeCloseTo(2.25 * 1.02, 2);
  });

  it("skips 2.20 when filled is 1.8 (in BE band, would be a false profit if using filled×k)", () => {
    const out = filterMakeupOddsBandCandidates([item(2.20)], i => i.odds, 1.8, on);
    expect(out).toEqual([]);
  });

  it("places 2.00 as a loss when filled is 1.8 (below BE×0.96)", () => {
    const out = filterMakeupOddsBandCandidates([item(2.00)], i => i.odds, 1.8, on);
    expect(out?.map(i => i.odds)).toEqual([2]);
  });

  it("lower 0 disables the loss side", () => {
    const bounds = resolveMakeupOddsBandBounds(2, { enabled: true, upper: 1.02, lower: 0 });
    expect(bounds?.lowerOdds).toBeNull();
    expect(bounds?.upperOdds).toBeCloseTo(2.04, 3);
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

  it("treats a cleared lower as default 0.96, not as disable-loss", () => {
    const out = filterMakeupOddsBandCandidates(
      [item(2.00)],
      i => i.odds,
      2,
      { enabled: true, upper: 1.02, lower: null as unknown as number },
    );
    expect(out).toEqual([]);
  });

  it("returns null when break-even cannot be solved so caller can fall back", () => {
    const out = filterMakeupOddsBandCandidates(
      [item(2.00)],
      i => i.odds,
      1,
      { enabled: true, upper: 1.02, lower: 0.96 },
    );
    expect(out).toBeNull();
  });

  it("display odds match getOdds(makeProfit) when the band is off", () => {
    const order = new LoseOrder({ betOdds: 2, isCreateOrder: false });
    expect(makeupDisplayOdds(order, 1.01, off)).toBe(order.getOdds(1.01));
    expect(makeupDisplayOdds(order, 1.01, undefined)).toBe(order.getOdds(1.01));
  });

  it("display odds use break-even when the band is on", () => {
    const order = new LoseOrder({ betOdds: 2, isCreateOrder: false });
    expect(makeupDisplayOdds(order, 1.01, on)).toBe(2);
  });

  it("display odds stay on typed odds for manual isCreateOrder", () => {
    const order = new LoseOrder({ betOdds: 1.88, isCreateOrder: true });
    expect(makeupDisplayOdds(order, 1.01, on)).toBe(1.88);
  });
});
