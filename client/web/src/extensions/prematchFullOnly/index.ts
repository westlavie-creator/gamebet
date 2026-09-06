/**
 * [changmen 扩展] 赛前全场过滤（HomeView 投影 + 新开仓早退）。
 * 默认 off，与 mapBetMute / 补单 / 体育板隔离。
 */

export {
  PREMATCH_FULL_ONLY_LOCAL_KEY,
  PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY,
  ensurePrematchFullOnlyLoaded,
  prematchFullMode,
  getPrematchFullMode,
  setPrematchFullMode,
  notePrematchFullLiveRound,
  isPrematchFullMarketAllowed,
  filterMatchesForPrematchFull,
  resetPrematchFullOnlyForTests,
  type PrematchFullMode,
} from "@/extensions/prematchFullOnly/prematchFullOnly";
