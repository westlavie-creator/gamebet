import type { BetOption } from "@changmen/client-core/models/betOption";
import type { BetResult } from "@changmen/client-core/models/betResult";
import type { PlatformAccount } from "@/models/platformAccount";
import type { VenueOrder } from "@changmen/venue-adapter/contract";
import {
  isVenueLegConfirmedUnfilled,
  isVenueLegPendingConfirm,
} from "@changmen/venue-adapter/contract";
import { resolveVenueLegOutcome } from "@/domain/betting/resolveVenueLegOutcome";
import { refreshOrderListAfterBind } from "@/stores/betting/arbOrderBind";
import { useAccountStore } from "@/stores/accountStore";
import { isPendingConfirmVenueProvider, isPolymarketProvider, isPredictFunProvider } from "@changmen/shared/account_multiply";
import { persistPolymarketExecutionReject } from "@/stores/account/pmRejectOrder";
import { wait } from "@changmen/client-core/shared/wait";

export interface ArbLegSettleResult {
  orders: VenueOrder[];
  /** 确认未成交（可补单） */
  rejected: boolean;
  /** PF 仍待确认（OPEN）；PM FOK 不应出现 */
  pendingConfirm: boolean;
}

export interface SettleArbLegOpts {
  rejectWaitSec?: number;
  /** [changmen 扩展] SaveOrder 直写最终 Link，缩短占位窗口 */
  pendingBindLinkId?: number;
  /** [changmen 扩展] PM 未成交落库用（stake/盘口） */
  betOption?: BetOption;
}

/** 本地一轮 timeout 后续跟。仅 PF（挂单可能仍 OPEN）。PM FOK 窗后只有 filled/unfilled。 */
export const PENDING_CONFIRM_FOLLOW_ROUNDS = 6;
export const PENDING_CONFIRM_FOLLOW_GAP_MS = 2_000;

/** 套利单腿：场馆 resolveLegOutcome（wait → 拉单 / PM settle） */
export async function settleArbLeg(
  account: PlatformAccount,
  result?: BetResult,
  rejectWaitSecOrOpts?: number | SettleArbLegOpts,
): Promise<ArbLegSettleResult> {
  const opts: SettleArbLegOpts = typeof rejectWaitSecOrOpts === "number"
    || rejectWaitSecOrOpts == null
    ? { rejectWaitSec: rejectWaitSecOrOpts }
    : rejectWaitSecOrOpts;
  const pendingBindOrderId = String(result?.orderId ?? "").trim() || undefined;
  // [changmen 扩展] RAY 等 A8 馆 POST 无 orderId：拒单等待期间并行对单，先露侧栏。
  if (opts.pendingBindLinkId && opts.betOption) {
    const option = opts.betOption;
    const linkId = opts.pendingBindLinkId;
    void import("@/stores/betting/autoBet/appearArbOrderDuringRejectWait")
      .then(({ appearArbOrderDuringRejectWait }) => appearArbOrderDuringRejectWait({
        account,
        option,
        linkId,
        rejectWaitSec: opts.rejectWaitSec,
      }))
      .catch(() => {});
  }
  // [changmen 扩展] 首轮拉单已带最终 Link 落库（venueOrders.stampPendingBindLink），
  // 侧栏无需等不确定重拉 / 另一腿 settle。PF 不经 Client_SaveOrder，跳过。
  const canRefreshEarly = Boolean(opts.pendingBindLinkId)
    && !isPredictFunProvider(account.provider);
  let refreshedSidebar = false;
  const outcome = await resolveVenueLegOutcome(
    account,
    result,
    async () => {
      const orders = await useAccountStore().updateVenueOrders(account, {
        pendingBindLinkId: opts.pendingBindLinkId,
        pendingBindOrderId,
        // 官方 delayed：matched 后 trades 可能滞后；等 orderId 出现再 save
        waitForOrderId: pendingBindOrderId,
      });
      if (canRefreshEarly && !refreshedSidebar && orders?.length) {
        refreshedSidebar = true;
        refreshOrderListAfterBind();
      }
      return orders;
    },
    {
      confirmPostAccepted: isPendingConfirmVenueProvider(account.provider) && Boolean(result),
      rejectWaitSec: opts.rejectWaitSec,
      pmConditionId: String(opts.betOption?.betId ?? "").trim() || undefined,
    },
  );
  let rejected = isVenueLegConfirmedUnfilled(outcome);
  let pendingConfirm = isVenueLegPendingConfirm(outcome);
  // PM 官方无 timeout；编排只认 filled/unfilled。venue 若仍漏 timeout → 未成交。
  if (isPolymarketProvider(account.provider) && pendingConfirm) {
    rejected = true;
    pendingConfirm = false;
  }
  if (rejected && result && isPolymarketProvider(account.provider)) {
    try {
      await persistPolymarketExecutionReject(account, result, "unfilled", {
        betOption: opts.betOption,
        linkId: opts.pendingBindLinkId,
      });
    }
    catch {
      /* 拒单落库失败不阻断 settle 回传 */
    }
  }
  return {
    orders: outcome.orders,
    rejected,
    pendingConfirm,
  };
}

/**
 * 跟到已成交 / 未成交。
 * PF：timeout / 仍 pending → 续跟；耗尽仍未知则保持 pendingConfirm。
 * PM：venue 已把内部 timeout 收成 unfilled，一轮即返回。
 * 非 pending-confirm 馆：一轮即返回。
 */
export async function settleArbLegUntilTerminal(
  account: PlatformAccount,
  result?: BetResult,
  rejectWaitSecOrOpts?: number | SettleArbLegOpts,
): Promise<ArbLegSettleResult> {
  const needFollow = isPredictFunProvider(account.provider) && Boolean(result);
  const rounds = needFollow ? PENDING_CONFIRM_FOLLOW_ROUNDS : 1;
  let last: ArbLegSettleResult = { orders: [], rejected: false, pendingConfirm: false };
  for (let round = 0; round < rounds; round++) {
    last = await settleArbLeg(account, result, rejectWaitSecOrOpts);
    if (!last.pendingConfirm)
      return last;
    if (round < rounds - 1)
      await wait(PENDING_CONFIRM_FOLLOW_GAP_MS * (round + 1));
  }
  return last;
}
