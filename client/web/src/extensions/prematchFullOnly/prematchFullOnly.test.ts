import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewBet, ViewMatch } from "@/models/match";
import {
  PREMATCH_FULL_ONLY_LOCAL_KEY,
  PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY,
  filterMatchesForPrematchFull,
  getPrematchFullMode,
  isPrematchFullMarketAllowed,
  notePrematchFullLiveRound,
  resetPrematchFullOnlyForTests,
  setPrematchFullMode,
} from "@/extensions/prematchFullOnly/prematchFullOnly";

function mockWebStorage() {
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const api = (data: Map<string, string>) => ({
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
  vi.stubGlobal("localStorage", api(local));
  vi.stubGlobal("sessionStorage", api(session));
}

function match(partial: Partial<ViewMatch> & { id: number }): ViewMatch {
  return {
    title: "A vs B",
    game: "lol",
    liveRound: 0,
    startAt: Date.now() + 3_600_000,
    bets: [],
    ...partial,
  } as ViewMatch;
}

function bet(round: number, id = round + 1): ViewBet {
  return { id, round, homeName: "A", awayName: "B" } as ViewBet;
}

describe("prematchFullOnly", () => {
  beforeEach(() => {
    mockWebStorage();
    resetPrematchFullOnlyForTests();
  });

  afterEach(() => {
    resetPrematchFullOnlyForTests();
  });

  it("defaults and bad values are off; allowed is always true; filter keeps same reference", () => {
    expect(getPrematchFullMode()).toBe("off");
    const m = match({ id: 1, bets: [bet(0), bet(1)] });
    expect(isPrematchFullMarketAllowed(m, bet(1))).toBe(true);
    expect(isPrematchFullMarketAllowed(m, bet(0))).toBe(true);
    const list = [m];
    expect(filterMatchesForPrematchFull(list)).toBe(list);
    setPrematchFullMode("nope" as never);
    expect(getPrematchFullMode()).toBe("off");
  });

  it("persists liveRound / startAt and clears storage on off", () => {
    setPrematchFullMode("liveRound");
    expect(localStorage.getItem(PREMATCH_FULL_ONLY_LOCAL_KEY)).toBe("liveRound");
    setPrematchFullMode("startAt");
    expect(localStorage.getItem(PREMATCH_FULL_ONLY_LOCAL_KEY)).toBe("startAt");
    setPrematchFullMode("off");
    expect(localStorage.getItem(PREMATCH_FULL_ONLY_LOCAL_KEY)).toBeNull();
  });

  it("liveRound: unstarted full match allowed; maps and live full match not", () => {
    setPrematchFullMode("liveRound");
    const upcoming = match({ id: 1, liveRound: 0 });
    expect(isPrematchFullMarketAllowed(upcoming, bet(0))).toBe(true);
    expect(isPrematchFullMarketAllowed(upcoming, bet(1))).toBe(false);
    expect(isPrematchFullMarketAllowed(upcoming, bet(2))).toBe(false);
    const live = match({ id: 2, liveRound: 1 });
    expect(isPrematchFullMarketAllowed(live, bet(0))).toBe(false);
    expect(isPrematchFullMarketAllowed(live, bet(1))).toBe(false);
  });

  it("liveRound sticky: once live, full match stays blocked after liveRound returns to 0", () => {
    setPrematchFullMode("liveRound");
    const m = match({ id: 9, liveRound: 2 });
    expect(isPrematchFullMarketAllowed(m, bet(0))).toBe(false);
    expect(JSON.parse(sessionStorage.getItem(PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY)!)).toContain("9");
    const betweenMaps = match({ id: 9, liveRound: 0 });
    expect(isPrematchFullMarketAllowed(betweenMaps, bet(0))).toBe(false);
  });

  it("off does not write sticky even if liveRound > 0", () => {
    notePrematchFullLiveRound(match({ id: 3, liveRound: 1 }));
    expect(sessionStorage.getItem(PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY)).toBeNull();
    expect(isPrematchFullMarketAllowed(match({ id: 3, liveRound: 1 }), bet(0))).toBe(true);
  });

  it("startAt: future full match allowed; past / invalid start not; ignores liveRound", () => {
    setPrematchFullMode("startAt");
    const now = 1_700_000_000_000;
    expect(isPrematchFullMarketAllowed(match({ id: 1, startAt: now + 1, liveRound: 5 }), bet(0), now)).toBe(true);
    expect(isPrematchFullMarketAllowed(match({ id: 1, startAt: now, liveRound: 0 }), bet(0), now)).toBe(false);
    expect(isPrematchFullMarketAllowed(match({ id: 1, startAt: now - 1, liveRound: 0 }), bet(0), now)).toBe(false);
    expect(isPrematchFullMarketAllowed(match({ id: 1, startAt: 0, liveRound: 0 }), bet(0), now)).toBe(false);
    expect(isPrematchFullMarketAllowed(match({ id: 1, startAt: now + 1 }), bet(1), now)).toBe(false);
  });

  it("filter clones bets and does not mutate source", () => {
    setPrematchFullMode("liveRound");
    const full = bet(0, 10);
    const map1 = bet(1, 11);
    const source = match({ id: 1, liveRound: 0, bets: [full, map1] });
    const out = filterMatchesForPrematchFull([source]);
    expect(source.bets).toHaveLength(2);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toBe(source);
    expect(out[0].bets).toEqual([full]);
    expect(out[0].id).toBe(1);
  });

  it("filter drops matches with no qualifying bets", () => {
    setPrematchFullMode("liveRound");
    const live = match({ id: 2, liveRound: 1, bets: [bet(0), bet(1)] });
    const mapsOnly = match({ id: 3, liveRound: 0, bets: [bet(1), bet(2)] });
    expect(filterMatchesForPrematchFull([live, mapsOnly])).toEqual([]);
  });

  it("filter keeps original match reference when all bets already qualify", () => {
    setPrematchFullMode("liveRound");
    const onlyFull = match({ id: 4, liveRound: 0, bets: [bet(0)] });
    const out = filterMatchesForPrematchFull([onlyFull]);
    expect(out[0]).toBe(onlyFull);
  });
});
