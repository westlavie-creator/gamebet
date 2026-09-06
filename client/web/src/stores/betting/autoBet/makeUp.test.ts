import type { ViewBet, ViewMatch } from "@/models/match";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultUserConfig } from "@/types/userConfig";
import { LoseOrder } from "@/models/loseOrder";

const getDefaultOdds = vi.hoisted(() => vi.fn(async () => 0));
const a8Tip = vi.hoisted(() => vi.fn());
const wait = vi.hoisted(() => vi.fn(async () => {}));
const createOrder = vi.hoisted(() => vi.fn());
const has = vi.hoisted(() => vi.fn((_id?: number) => false));
const extensionPrefs = vi.hoisted(() => ({
  makeupOddsBand: { enabled: false, upper: 1.02, lower: 0.96 },
}));

vi.mock("@/api/report", () => ({ getDefaultOdds }));
vi.mock("@/shared/a8Notify", () => ({ a8Tip }));
vi.mock("@changmen/client-core/shared/wait", () => ({ wait }));
vi.mock("@/stores/userStore", () => ({
  useUserStore: () => ({ extensionPrefs }),
}));

import { allowMakeUpForLeg, enqueueMakeUpOrder } from "@/stores/betting/autoBet/makeUp";

function makeMatchBet() {
  const bet = {
    id: 100,
    getBetName: () => "地图1",
  } as unknown as ViewBet;
  const match = {
    id: 1,
    title: "A vs B",
  } as unknown as ViewMatch;
  return { match, bet };
}

describe("allowMakeUpForLeg (A8 B)", () => {
  const setMessage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    getDefaultOdds.mockResolvedValue(0);
    extensionPrefs.makeupOddsBand = { enabled: false, upper: 1.02, lower: 0.96 };
  });

  it("denies when makeUp_odds <= failedLegOdds and tips", async () => {
    const { match, bet } = makeMatchBet();
    const config = { ...createDefaultUserConfig(), makeUp: true, makeUp_odds: 2 };
    const ok = await allowMakeUpForLeg(match, bet, "Home", 2.3, config, setMessage);
    expect(ok).toBe(false);
    expect(a8Tip).toHaveBeenCalledWith(
      "不予补单提醒",
      expect.stringContaining("当前赔率:2.3"),
      3000,
    );
    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining("不予补单"));
  });

  it("allows when failedLegOdds is below makeUp_odds ceiling", async () => {
    const { match, bet } = makeMatchBet();
    const config = { ...createDefaultUserConfig(), makeUp: true, makeUp_odds: 2 };
    const ok = await allowMakeUpForLeg(match, bet, "Home", 1.85, config, setMessage);
    expect(ok).toBe(true);
    expect(a8Tip).not.toHaveBeenCalled();
  });

  it("denies on makeUp_defaultOdds vs API初赔", async () => {
    const { match, bet } = makeMatchBet();
    getDefaultOdds.mockResolvedValueOnce(2.5);
    const config = { ...createDefaultUserConfig(), makeUp: true, makeUp_defaultOdds: 2 };
    const ok = await allowMakeUpForLeg(match, bet, "Away", 1.5, config, setMessage);
    expect(ok).toBe(false);
    expect(getDefaultOdds).toHaveBeenCalledWith({
      matchId: 1,
      betId: 100,
      team: "Away",
    });
    expect(a8Tip).toHaveBeenCalledWith(
      "不予补单提醒",
      expect.stringContaining("初赔赔率:2.5"),
      3000,
    );
  });

  it("skips 初赔/当前赔率 caps when makeupOddsBand is on", async () => {
    extensionPrefs.makeupOddsBand = { enabled: true, upper: 1.02, lower: 0.96 };
    const { match, bet } = makeMatchBet();
    getDefaultOdds.mockResolvedValueOnce(2.5);
    const config = {
      ...createDefaultUserConfig(),
      makeUp: true,
      makeUp_odds: 2,
      makeUp_defaultOdds: 2,
    };
    const ok = await allowMakeUpForLeg(match, bet, "Home", 2.3, config, setMessage);
    expect(ok).toBe(true);
    expect(getDefaultOdds).not.toHaveBeenCalled();
    expect(a8Tip).not.toHaveBeenCalled();
  });
});

describe("enqueueMakeUpOrder (A8 B before createOrder)", () => {
  const setMessage = vi.fn();
  const loseStore = {
    orders: new Map<number, LoseOrder>(),
    has: (id: number) => has(id),
    createOrder,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    has.mockReturnValue(false);
    getDefaultOdds.mockResolvedValue(0);
    extensionPrefs.makeupOddsBand = { enabled: false, upper: 1.02, lower: 0.96 };
  });

  it("does not enqueue when failedLegOdds exceeds makeUp_odds", async () => {
    const { match, bet } = makeMatchBet();
    const config = { ...createDefaultUserConfig(), makeUp: true, makeUp_odds: 2 };
    const ok = await enqueueMakeUpOrder({
      loseStore: loseStore as never,
      match,
      bet,
      config,
      setMessage,
      linkId: 1,
      accountId: 9,
      target: "Home",
      betMoney: 100,
      betOdds: 1.9,
      failedLegOdds: 2.4,
      failedPlatformLabel: "OB",
    });
    expect(ok).toBe(false);
    expect(createOrder).not.toHaveBeenCalled();
    expect(a8Tip).toHaveBeenCalledWith("不予补单提醒", expect.any(String), 3000);
    expect(a8Tip).not.toHaveBeenCalledWith("补单提醒", expect.any(String), 3000);
  });

  it("enqueues when B passes (failedLegOdds under ceiling)", async () => {
    const { match, bet } = makeMatchBet();
    const config = { ...createDefaultUserConfig(), makeUp: true, makeUp_odds: 2 };
    const ok = await enqueueMakeUpOrder({
      loseStore: loseStore as never,
      match,
      bet,
      config,
      setMessage,
      linkId: 1,
      accountId: 9,
      target: "Home",
      betMoney: 100,
      betOdds: 1.9,
      failedLegOdds: 1.85,
      failedPlatformLabel: "OB",
    });
    expect(ok).toBe(true);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(a8Tip).toHaveBeenCalledWith(
      "补单提醒",
      "OB 下单失败，创建补单队列",
      3000,
    );
  });

  it("overwrites same betId via createOrder (A8 Map.set)", async () => {
    const { match, bet } = makeMatchBet();
    has.mockReturnValue(true);
    const config = { ...createDefaultUserConfig(), makeUp: true };
    const ok = await enqueueMakeUpOrder({
      loseStore: loseStore as never,
      match,
      bet,
      config,
      setMessage,
      linkId: 2,
      accountId: 10,
      target: "Away",
      betMoney: 120,
      betOdds: 2.0,
      failedLegOdds: 1.7,
      failedPlatformLabel: "RAY",
    });
    expect(ok).toBe(true);
    expect(createOrder).toHaveBeenCalledTimes(1);
    expect(createOrder.mock.calls[0][0]).toMatchObject({
      betId: 100,
      accountId: 10,
      betMoney: 120,
      betOdds: 2.0,
      target: "Away",
      linkId: 2,
    });
  });
});
