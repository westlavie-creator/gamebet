import type { BetOption } from "@changmen/client-core/models/betOption";
import type { PlatformAccount } from "@/models/platformAccount";
import type { AccountStoreContext } from "@/stores/account/context";
import { ElNotification } from "element-plus";
import { BetResult } from "@changmen/client-core/models/betResult";
import { publishBettingEvent } from "@/realtime/publishBetting";
import { getProvider } from "@/runtime/providers";
import {
  bettingDetailHtml,
  bettingLoadingMessageHtml,
  bettingNotifyAccountLine,
  bettingResultMessageHtml,
} from "@/shared/a8Notify";
import { playOrderSuccessSound } from "@/shared/orderSound";
import { settleArbLegUntilTerminal } from "@/stores/betting/autoBet/arbLegSettle";
import { attachPolymarketDetectionQuote } from "@/domain/polymarket/attachDetectionQuote";
import { attachPredictFunDetectionQuote } from "@/domain/predictfun/attachDetectionQuote";
import { resolveVenueStakeFromPlanCny, type ResolveVenueStakeOpts } from "@changmen/venue-adapter/adaptation";
import { isPendingConfirmVenueProvider } from "@changmen/shared/account_multiply";
import { useMessageStore } from "@/stores/messageStore";
import { persistPolymarketMatchedBuyOrder } from "@/stores/account/pmOptimisticOrder";
import { persistPolymarketExecutionReject } from "@/stores/account/pmRejectOrder";
import { legRejectWaitSec } from "@/stores/betting/autoBet/rejectWait";
import { markSuccessfulBet } from "@/stores/betting/successMarkers";
import { useUserStore } from "@/stores/userStore";

export type CheckBettingOpts = ResolveVenueStakeOpts;

export interface PlaceBetOpts {
  /** [changmen 扩展] 套利/补单最终 Link；PM api_failed 落库用 */
  linkId?: number;
}

/**
 * delayed 受理后：跟到已成交 / 未成交再提示。
 * PF 仍 pendingConfirm（挂单 OPEN）→ 不报成/不成。
 * PM FOK 窗后只有成交/未成交，不会停在 pendingConfirm。
 */
function notifyPendingVenueConfirm(
  store: AccountStoreContext,
  account: PlatformAccount,
  accountLine: string,
  detailHtml: string,
  result: BetResult,
  option: BetOption,
  toastSeconds: number,
) {
  void (async () => {
    const { rejected, pendingConfirm } = await settleArbLegUntilTerminal(account, result, {
      rejectWaitSec: 0,
      betOption: option,
    });
    if (pendingConfirm)
      return;
    const titleSuffix = rejected ? "未成交" : "已成交";
    ElNotification({
      title: "",
      message: bettingResultMessageHtml(
        account.provider,
        accountLine,
        detailHtml,
        `<p>${result.message || ""}</p>`,
        titleSuffix,
      ),
      type: rejected ? "error" : "success",
      dangerouslyUseHTMLString: true,
      duration: toastSeconds === 0 ? 3000 : toastSeconds * 1000,
      customClass: `notification ${account.provider}`,
    });
    if (!rejected) {
      void playOrderSuccessSound({ betRowId: option.betId });
      void publishBettingEvent(option);
      // PF/PM：受理≠成交；成功计数推迟到 filled
      if (isPendingConfirmVenueProvider(account.provider)) {
        const betRowId = Number(option.bet?.id ?? option.betId);
        if (Number.isFinite(betRowId) && betRowId > 0)
          markSuccessfulBet(account, betRowId, option.target, option.odds);
      }
    }
    if (isPendingConfirmVenueProvider(account.provider)) {
      try {
        const { refreshAccountBalance } = await import("@/stores/account/balanceRefresh");
        await refreshAccountBalance(store, account);
      }
      catch {
        /* 刷新失败不阻断 toast */
      }
      try {
        const { refreshOrderListAfterBind } = await import("@/stores/betting/arbOrderBind");
        refreshOrderListAfterBind();
      }
      catch {
        /* 侧栏刷新失败不阻断 toast */
      }
    }
  })();
}

export async function checkBetting(
  _store: AccountStoreContext,
  account: PlatformAccount | undefined,
  option: BetOption,
  opts?: CheckBettingOpts,
) {
  if (!account) {
    option.checkError = `场馆${option.type}没有可用账号`;
    return option;
  }
  const provider = getProvider(account);
  if (!provider) {
    option.checkError = `场馆${option.type}不被支持`;
    return option;
  }
  try {
    attachPolymarketDetectionQuote(option);
    attachPredictFunDetectionQuote(option);
    // [A8 适配] 编排 Plan CNY → 场馆原币（CNY / U / PM）；预检后不改，跌价由各场馆 checkBet 拒单
    option.betMoney = resolveVenueStakeFromPlanCny(account, option.betMoney, option.odds, opts);
    return await provider.checkBet(account, option);
  }
  catch (e) {
    option.checkError = e instanceof Error ? e.message : JSON.stringify(e);
    return option;
  }
  finally {
    option.saveLog(account);
  }
}

export async function placeBet(
  store: AccountStoreContext,
  account: PlatformAccount | undefined,
  option: BetOption,
  toastSeconds = 10,
  opts?: PlaceBetOpts,
) {
  if (!account)
    return new BetResult(option.type, false, "无可用账号");
  const provider = getProvider(account);
  if (!provider)
    return new BetResult(option.type, false, "平台不支持");

  const platformLabel = store.getPlatformName(account.platformId, account.platformName);
  const accountLine = bettingNotifyAccountLine(account, platformLabel);
  const detailHtml = bettingDetailHtml({
    matchTitle: option.match?.title,
    betName: option.bet?.getBetName(),
    target: option.target,
    itemOdds: option.item?.getOdds(option.target),
    betMoney: option.betMoney,
    odds: option.odds,
    betCount: option.betCount,
  });

  const loading = ElNotification({
    title: "",
    message: bettingLoadingMessageHtml(account.provider, accountLine, detailHtml),
    dangerouslyUseHTMLString: true,
    duration: 10_000,
    customClass: `notification loading ${account.provider}`,
  });

  const beginTime = Date.now();
  let result: BetResult = new BetResult(account.provider, false, "未知错误");
  try {
    if (!option.data) {
      option = await checkBetting(store, account, option);
    }
    if (!option.data) {
      result = new BetResult(option.type, false, option.checkError || "预检失败");
    }
    else {
      result = await provider.betting(account, option);
      // [changmen 扩展] 套利 A8 馆（RAY）POST 无 orderId：立刻并行对单刷侧栏，不挡后续拒单等待
      // 已有 orderId 时 settle 会精确 waitForOrderId，勿再走金额/赔率模糊匹配（易误绑上笔）
      if (
        result.success
        && !result.pending
        && opts?.linkId
        && !String(result.orderId ?? "").trim()
        && !isPendingConfirmVenueProvider(account.provider)
      ) {
        const linkId = opts.linkId;
        void import("@/stores/betting/autoBet/appearArbOrderDuringRejectWait")
          .then(({ appearArbOrderDuringRejectWait }) => appearArbOrderDuringRejectWait({
            account,
            option,
            linkId,
            placedAt: Number(result.beginTime) || beginTime || Date.now(),
            rejectWaitSec: legRejectWaitSec(useUserStore().config, account.provider),
          }))
          .catch(() => {});
      }
      // PM matched：官方 POST 成交即真相，立刻落库，勿干等 /data/trades
      if (result.success && !result.pending && account.provider === "Polymarket") {
        try {
          const saved = await persistPolymarketMatchedBuyOrder(account, option, result);
          // 供手动/正EV：乐观落库失败时回退 waitForOrderId
          if (saved)
            result.tip = { pmOptimisticSaved: true };
        }
        catch {
          /* 乐观落库失败不阻断下单成功；后续 Io.f / updateVenueOrders 仍可补 */
        }
      }
      // PM 已 POST 未成交（含无官方 orderId）：落库 Reject，供拒单率统计
      else if (!result.success && account.provider === "Polymarket") {
        try {
          if (Number(beginTime) > 0)
            result.beginTime = beginTime;
          await persistPolymarketExecutionReject(account, result, "api_failed", {
            betOption: option,
            linkId: opts?.linkId,
          });
        }
        catch {
          /* 拒单落库失败不阻断下单结果回传 */
        }
      }
    }
  }
  catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const message = raw.includes("Failed to fetch dynamically imported module")
      ? "页面资源已过期（服务端刚发版），请刷新页面后重试"
      : raw;
    result = new BetResult(
      account.provider,
      false,
      message,
      option.data,
    );
    // POST 前抛错 / 页面过期：不落拒单（无 pmPosted）
  }
  finally {
    loading.close();
    const notifyType = result.pending ? "warning" : result.success ? "success" : "error";
    const statusSuffix = result.pending ? "确认中" : "";
    ElNotification({
      title: "",
      message: bettingResultMessageHtml(
        account.provider,
        accountLine,
        detailHtml,
        `<p>${result.message || ""}</p>`,
        statusSuffix,
      ),
      type: notifyType,
      dangerouslyUseHTMLString: true,
      customClass: `notification ${account.provider}`,
      duration: toastSeconds === 0 ? 3000 : toastSeconds * 1000,
    });
    useMessageStore().delayMessage(account, Date.now() - beginTime);
    result.saveLog(account, beginTime);
    if (result.success && !result.pending) {
      void playOrderSuccessSound({ betRowId: option.betId });
      void publishBettingEvent(option);
    }
    if (
      result.pending
      && !option.loseOrder
      && isPendingConfirmVenueProvider(account.provider)
      && !option.deferPostAcceptSettlement
    ) {
      notifyPendingVenueConfirm(
        store,
        account,
        accountLine,
        detailHtml,
        result,
        option,
        toastSeconds,
      );
    }
  }
  return result;
}
