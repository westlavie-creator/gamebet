import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetMapBetMuteForTests,
  toggleMapMute,
} from "@/extensions/mapBetMute";
import {
  resetPrematchFullOnlyForTests,
  setPrematchFullMode,
} from "@/extensions/prematchFullOnly";
import { executeArbBet } from "@/stores/betting/autoBet/executeArbBet";
import { createDefaultUserConfig } from "@/types/userConfig";

const prepareArbAttempt = vi.hoisted(() => vi.fn());
const checkArbLegs = vi.hoisted(() => vi.fn());
const placeArbLegs = vi.hoisted(() => vi.fn());
const finalizeArbBet = vi.hoisted(() => vi.fn());
const recordArbAttemptMetric = vi.hoisted(() => vi.fn());

vi.mock("@/stores/betting/autoBet/phases/prepareArbAttempt", () => ({
  prepareArbAttempt,
}));
vi.mock("@/stores/betting/autoBet/phases/checkArbLegs", () => ({
  checkArbLegs,
}));
vi.mock("@/stores/betting/autoBet/phases/placeArbLegs", () => ({
  placeArbLegs,
}));
vi.mock("@/stores/betting/autoBet/phases/finalizeArbBet", () => ({
  finalizeArbBet,
}));
vi.mock("@/stores/betting/autoBet/arbAttemptMetrics", () => ({
  recordArbAttemptMetric,
}));

function mockSessionStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
  });
}

describe("executeArbBet orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionStorage();
    resetMapBetMuteForTests();
    resetPrematchFullOnlyForTests();
  });

  it("[changmen 扩展] 折叠全场时不进 prepare", async () => {
    toggleMapMute(1, 0);
    await executeArbBet({
      match: { id: 1, liveRound: 5 } as never,
      bet: { id: 10, round: 0 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });
    expect(prepareArbAttempt).not.toHaveBeenCalled();
    expect(recordArbAttemptMetric).not.toHaveBeenCalled();
  });

  it("[changmen 扩展] 折叠地图3+ 时不进 prepare", async () => {
    toggleMapMute(1, 5);
    await executeArbBet({
      match: { id: 1, liveRound: 0 } as never,
      bet: { id: 10, round: 5 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });
    expect(prepareArbAttempt).not.toHaveBeenCalled();
    expect(recordArbAttemptMetric).not.toHaveBeenCalled();
  });

  it("[changmen 扩展] 折叠后该局变 live 仍进 prepare", async () => {
    toggleMapMute(1, 5);
    prepareArbAttempt.mockResolvedValue(null);
    await executeArbBet({
      match: { id: 1, liveRound: 5 } as never,
      bet: { id: 10, round: 5 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });
    expect(prepareArbAttempt).toHaveBeenCalled();
  });

  it("[changmen 扩展] 折叠地图1 时不进 prepare", async () => {
    toggleMapMute(1, 1);
    await executeArbBet({
      match: { id: 1, liveRound: 0 } as never,
      bet: { id: 10, round: 1 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });
    expect(prepareArbAttempt).not.toHaveBeenCalled();
    expect(recordArbAttemptMetric).not.toHaveBeenCalled();
  });

  it("预检通过后 place 失败结果仍调用 finalize", async () => {
    const ready = { linkId: 1 };
    const checked = { ...ready, waitSec: 10 };
    const placed = {
      ...checked,
      placeOutcomeA: "api_failed",
      placeOutcomeB: "not_attempted",
    };
    prepareArbAttempt.mockResolvedValue(ready);
    checkArbLegs.mockResolvedValue(checked);
    placeArbLegs.mockResolvedValue(placed);
    finalizeArbBet.mockResolvedValue(undefined);

    await executeArbBet({
      match: { id: 1 } as never,
      bet: { id: 10 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });

    expect(placeArbLegs).toHaveBeenCalled();
    expect(finalizeArbBet).toHaveBeenCalledWith(expect.anything(), placed);
    expect(recordArbAttemptMetric).toHaveBeenCalledWith(
      expect.objectContaining({ stop: "complete" }),
    );
  });

  it("预检失败不 place / finalize", async () => {
    prepareArbAttempt.mockResolvedValue({ linkId: 1 });
    checkArbLegs.mockResolvedValue(null);

    await executeArbBet({
      match: { id: 1 } as never,
      bet: { id: 10 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });

    expect(placeArbLegs).not.toHaveBeenCalled();
    expect(finalizeArbBet).not.toHaveBeenCalled();
    expect(recordArbAttemptMetric).toHaveBeenCalledWith(
      expect.objectContaining({ stop: "skip_check" }),
    );
  });

  it("[changmen 扩展] 赛前全场 off 时未折叠的地图仍进 prepare", async () => {
    prepareArbAttempt.mockResolvedValue(null);
    await executeArbBet({
      match: { id: 1, liveRound: 0, startAt: Date.now() + 86_400_000 } as never,
      bet: { id: 10, round: 1 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });
    expect(prepareArbAttempt).toHaveBeenCalled();
  });

  it("[changmen 扩展] 赛前全场 liveRound 模式下地图不进 prepare", async () => {
    setPrematchFullMode("liveRound");
    await executeArbBet({
      match: { id: 1, liveRound: 0, startAt: Date.now() + 86_400_000 } as never,
      bet: { id: 10, round: 1 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });
    expect(prepareArbAttempt).not.toHaveBeenCalled();
    expect(recordArbAttemptMetric).not.toHaveBeenCalled();
  });

  it("[changmen 扩展] 赛前全场 liveRound 模式下滚球全场不进 prepare", async () => {
    setPrematchFullMode("liveRound");
    await executeArbBet({
      match: { id: 1, liveRound: 1, startAt: Date.now() + 86_400_000 } as never,
      bet: { id: 10, round: 0 } as never,
      config: createDefaultUserConfig(),
      setMessage: vi.fn(),
    });
    expect(prepareArbAttempt).not.toHaveBeenCalled();
  });
});
