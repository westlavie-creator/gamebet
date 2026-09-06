import type { VenueOrder } from "@changmen/venue-adapter/contract";
import type { PlatformAccount } from "@/models/platformAccount";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BetOption } from "@changmen/client-core/models/betOption";

const getOrders = vi.fn();
const updateVenueOrders = vi.fn();
const refreshOrderListAfterBind = vi.fn();

vi.mock("@changmen/client-core/shared/wait", () => ({
  wait: vi.fn(async () => {}),
}));

vi.mock("@/runtime/providers", () => ({
  getProvider: () => ({ getOrders }),
}));

vi.mock("@/stores/accountStore", () => ({
  useAccountStore: () => ({ updateVenueOrders }),
}));

vi.mock("@/stores/betting/arbOrderBind", () => ({
  refreshOrderListAfterBind: () => refreshOrderListAfterBind(),
}));

function option(partial?: Partial<BetOption>): BetOption {
  return Object.assign(new BetOption("RAY", "m1", "b1", "i-ray", 100, "Home", 1.85), partial);
}

function order(partial: Partial<VenueOrder>): VenueOrder {
  return {
    provider: "RAY",
    orderId: "R1",
    createAt: Date.now(),
    odds: 1.85,
    betMoney: 100,
    reward: 0,
    money: 0,
    status: "none",
    game: "",
    match: "",
    bet: "",
    item: "",
    ...partial,
  };
}

function account(): PlatformAccount {
  return { provider: "RAY", accountId: 7 } as PlatformAccount;
}

describe("findMatchingArbVenueOrder", () => {
  it("picks newest row matching stake and odds", async () => {
    const { findMatchingArbVenueOrder } = await import("./appearArbOrderDuringRejectWait");
    const placedAt = Date.now();
    const hit = findMatchingArbVenueOrder(
      [
        order({ orderId: "old", createAt: placedAt - 60_000, betMoney: 100, odds: 1.85 }),
        order({ orderId: "new", createAt: placedAt - 200, betMoney: 100, odds: 1.85 }),
      ],
      option(),
      placedAt,
    );
    expect(hit?.orderId).toBe("new");
  });

  it("ignores a newer row with different stake", async () => {
    const { findMatchingArbVenueOrder } = await import("./appearArbOrderDuringRejectWait");
    const placedAt = Date.now();
    const hit = findMatchingArbVenueOrder(
      [
        order({ orderId: "other", createAt: placedAt, betMoney: 200, odds: 1.85 }),
        order({ orderId: "ours", createAt: placedAt - 100, betMoney: 100, odds: 1.85 }),
      ],
      option(),
      placedAt,
    );
    expect(hit?.orderId).toBe("ours");
  });
});

describe("appearArbOrderDuringRejectWait", () => {
  beforeEach(() => {
    getOrders.mockReset();
    updateVenueOrders.mockReset();
    updateVenueOrders.mockResolvedValue([]);
    refreshOrderListAfterBind.mockReset();
  });

  it("saves matched RAY order and refreshes sidebar before reject wait ends", async () => {
    getOrders
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([order({ orderId: "ray-88" })]);
    const { appearArbOrderDuringRejectWait } = await import("./appearArbOrderDuringRejectWait");

    const ok = await appearArbOrderDuringRejectWait({
      account: account(),
      option: option(),
      linkId: 42,
      rejectWaitSec: 5,
    });

    expect(ok).toBe(true);
    expect(updateVenueOrders).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "RAY" }),
      expect.objectContaining({ pendingBindLinkId: 42, pendingBindOrderId: "ray-88" }),
    );
    expect(refreshOrderListAfterBind).toHaveBeenCalledOnce();
    expect(getOrders).toHaveBeenCalledTimes(2);
  });

  it("skips PM / PF", async () => {
    const { appearArbOrderDuringRejectWait } = await import("./appearArbOrderDuringRejectWait");
    const ok = await appearArbOrderDuringRejectWait({
      account: { provider: "Polymarket", accountId: 1 } as PlatformAccount,
      option: option(),
      linkId: 9,
      rejectWaitSec: 5,
    });
    expect(ok).toBe(false);
    expect(getOrders).not.toHaveBeenCalled();
  });

  it("dedupes inflight polls for the same leg", async () => {
    let resolveFirst: ((orders: VenueOrder[]) => void) | undefined;
    getOrders.mockImplementationOnce(() => new Promise<VenueOrder[]>((resolve) => {
      resolveFirst = resolve;
    }));
    const { appearArbOrderDuringRejectWait } = await import("./appearArbOrderDuringRejectWait");
    const args = {
      account: account(),
      option: option(),
      linkId: 42,
      rejectWaitSec: 5,
    };
    const a = appearArbOrderDuringRejectWait(args);
    const b = appearArbOrderDuringRejectWait(args);
    resolveFirst?.([order({ orderId: "ray-1" })]);
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(getOrders).toHaveBeenCalledTimes(1);
  });
});
