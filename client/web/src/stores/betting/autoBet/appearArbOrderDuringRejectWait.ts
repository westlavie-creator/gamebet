import type { BetOption } from "@changmen/client-core/models/betOption";
import type { PlatformAccount } from "@/models/platformAccount";
import type { VenueOrder } from "@changmen/venue-adapter/contract";
import { sortVenueOrdersNewestFirst } from "@changmen/venue-adapter/contract";
import { wait } from "@changmen/client-core/shared/wait";
import { isPendingConfirmVenueProvider } from "@changmen/shared/account_multiply";
import { getProvider } from "@/runtime/providers";
import { refreshOrderListAfterBind } from "@/stores/betting/arbOrderBind";

/** 拒单等待期间对单轮询间隔。首轮立即拉，不空等。 */
export const ARB_EARLY_APPEAR_INTERVAL_MS = 500;
/** 另一腿还在 POST 时多给几秒，避免 poller 先于场馆出单结束 */
export const ARB_EARLY_APPEAR_PLACE_SLACK_MS = 4_000;
const ARB_EARLY_APPEAR_MAX_MS = 12_000;
const ODDS_EPS = 0.02;
const STAKE_EPS = 0.51;
const CREATE_AT_SLACK_MS = 15_000;

const inflight = new Map<string, Promise<boolean>>();

export interface AppearArbOrderOpts {
  account: PlatformAccount;
  option: BetOption;
  linkId: number;
  rejectWaitSec?: number;
  placedAt?: number;
}

export function appearArbOrderInflightKey(
  accountId: number,
  linkId: number,
  itemId: string,
): string {
  return `${accountId}:${linkId}:${itemId}`;
}

/** 用本腿金额/赔率/下单时间对上最新场馆单，避免误标 orders[0] */
export function findMatchingArbVenueOrder(
  orders: VenueOrder[],
  option: BetOption,
  placedAt: number,
): VenueOrder | undefined {
  const stake = Number(option.betMoney) || 0;
  const odds = Number(option.odds) || 0;
  const newestFirst = sortVenueOrdersNewestFirst(orders);
  return newestFirst.find((order) => {
    const orderId = String(order.orderId ?? "").trim();
    if (!orderId)
      return false;
    if (Math.abs((Number(order.betMoney) || 0) - stake) > STAKE_EPS)
      return false;
    if (odds > 0 && Math.abs((Number(order.odds) || 0) - odds) > ODDS_EPS)
      return false;
    const created = Number(order.createAt) || 0;
    if (created > 0 && created < placedAt - CREATE_AT_SLACK_MS)
      return false;
    return true;
  });
}

export function appearArbOrderBudgetMs(rejectWaitSec?: number): number {
  const waitMs = Math.max(0, Number(rejectWaitSec) || 0) * 1000;
  return Math.min(ARB_EARLY_APPEAR_MAX_MS, Math.max(waitMs + ARB_EARLY_APPEAR_PLACE_SLACK_MS, ARB_EARLY_APPEAR_PLACE_SLACK_MS));
}

/**
 * [changmen 扩展] 套利 A8 馆（RAY 等）POST 成功后，在拒单等待窗口内并行拉单。
 * 对上本腿才 save + 刷侧栏；不改 5s 拒单判定。
 */
export function appearArbOrderDuringRejectWait(opts: AppearArbOrderOpts): Promise<boolean> {
  const linkId = Number(opts.linkId);
  const itemId = String(opts.option?.itemId ?? "").trim();
  if (!Number.isFinite(linkId) || linkId === 0 || !opts.option)
    return Promise.resolve(false);
  if (isPendingConfirmVenueProvider(opts.account.provider))
    return Promise.resolve(false);

  const key = appearArbOrderInflightKey(Number(opts.account.accountId) || 0, linkId, itemId);
  const running = inflight.get(key);
  if (running)
    return running;

  const task = runAppearArbOrderDuringRejectWait(opts).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, task);
  return task;
}

async function runAppearArbOrderDuringRejectWait(opts: AppearArbOrderOpts): Promise<boolean> {
  const provider = getProvider(opts.account);
  if (!provider?.getOrders)
    return false;

  const placedAt = Number(opts.placedAt) || Date.now();
  const budgetMs = appearArbOrderBudgetMs(opts.rejectWaitSec);
  const maxAttempts = Math.max(1, Math.ceil(budgetMs / ARB_EARLY_APPEAR_INTERVAL_MS));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await provider.getOrders(opts.account);
      const orders = sortVenueOrdersNewestFirst(raw ?? []);
      const hit = findMatchingArbVenueOrder(orders, opts.option, placedAt);
      const orderId = String(hit?.orderId ?? "").trim();
      if (orderId) {
        const { useAccountStore } = await import("@/stores/accountStore");
        await useAccountStore().updateVenueOrders(opts.account, {
          pendingBindLinkId: opts.linkId,
          pendingBindOrderId: orderId,
        });
        refreshOrderListAfterBind();
        return true;
      }
    }
    catch {
      /* 提前露单失败不挡拒单检测 */
    }
    if (attempt < maxAttempts)
      await wait(ARB_EARLY_APPEAR_INTERVAL_MS);
  }
  return false;
}
