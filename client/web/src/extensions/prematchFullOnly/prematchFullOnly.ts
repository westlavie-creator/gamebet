/**
 * [changmen 扩展] 只显示并只新开仓「赛前全场」。
 * 默认 off：谓词恒放行，列表返回原数组引用。不进 USERCONFIG / 服务端。
 *
 * liveRound：OB timer 开打（及本页曾 live）视为已开赛。
 * startAt：当前时间 ≥ 开赛时间视为已开赛；startAt 无效则不视为赛前。
 */

import { ref, type Ref } from "vue";
import type { ViewBet, ViewMatch } from "@/models/match";

export type PrematchFullMode = "off" | "liveRound" | "startAt";

export const PREMATCH_FULL_ONLY_LOCAL_KEY = "changmen:prematchFullOnly";
export const PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY = "changmen:prematchFullOnly:seenLive";

const modeRef: Ref<PrematchFullMode> = ref("off");
const seenLiveIds: Ref<Set<string>> = ref(new Set());
let loaded = false;

function parseMode(raw: string | null): PrematchFullMode {
  if (raw === "liveRound" || raw === "startAt")
    return raw;
  return "off";
}

function readLocalMode(): PrematchFullMode {
  try {
    return parseMode(localStorage.getItem(PREMATCH_FULL_ONLY_LOCAL_KEY));
  }
  catch {
    return "off";
  }
}

function writeLocalMode(mode: PrematchFullMode): void {
  try {
    if (mode === "off")
      localStorage.removeItem(PREMATCH_FULL_ONLY_LOCAL_KEY);
    else
      localStorage.setItem(PREMATCH_FULL_ONLY_LOCAL_KEY, mode);
  }
  catch {
    /* private mode / quota */
  }
}

function readSessionSeenLive(): Set<string> {
  try {
    const raw = sessionStorage.getItem(PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY);
    if (!raw)
      return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed))
      return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string" && x.length > 0));
  }
  catch {
    return new Set();
  }
}

function writeSessionSeenLive(ids: Set<string>): void {
  try {
    if (ids.size === 0)
      sessionStorage.removeItem(PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY);
    else
      sessionStorage.setItem(PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY, JSON.stringify([...ids]));
  }
  catch {
    /* ignore quota / private mode */
  }
}

export function ensurePrematchFullOnlyLoaded(): void {
  if (loaded)
    return;
  loaded = true;
  modeRef.value = readLocalMode();
  seenLiveIds.value = readSessionSeenLive();
}

/** 供 Vue computed 订阅 */
export function prematchFullMode(): Ref<PrematchFullMode> {
  ensurePrematchFullOnlyLoaded();
  return modeRef;
}

export function getPrematchFullMode(): PrematchFullMode {
  ensurePrematchFullOnlyLoaded();
  return modeRef.value;
}

export function setPrematchFullMode(mode: PrematchFullMode): void {
  ensurePrematchFullOnlyLoaded();
  const next: PrematchFullMode = parseMode(mode);
  modeRef.value = next;
  writeLocalMode(next);
}

function rememberSeenLive(matchId: number): void {
  const key = String(matchId);
  if (seenLiveIds.value.has(key))
    return;
  const next = new Set(seenLiveIds.value);
  next.add(key);
  seenLiveIds.value = next;
  writeSessionSeenLive(next);
}

/** 仅 liveRound 模式：liveRound>0 时记 sticky。off / startAt 不写。 */
export function notePrematchFullLiveRound(match: Pick<ViewMatch, "id" | "liveRound">): void {
  ensurePrematchFullOnlyLoaded();
  if (modeRef.value !== "liveRound")
    return;
  if ((Number(match.liveRound) || 0) > 0)
    rememberSeenLive(match.id);
}

function isMatchUnstarted(match: Pick<ViewMatch, "id" | "liveRound" | "startAt">, now: number): boolean {
  if (modeRef.value === "startAt") {
    const start = Number(match.startAt) || 0;
    return start > now;
  }
  notePrematchFullLiveRound(match);
  if ((Number(match.liveRound) || 0) > 0)
    return false;
  return !seenLiveIds.value.has(String(match.id));
}

/**
 * off → true。
 * 开启后仅 round===0 且未开赛的全场放行。
 */
export function isPrematchFullMarketAllowed(
  match: Pick<ViewMatch, "id" | "liveRound" | "startAt">,
  bet: Pick<ViewBet, "round">,
  now = Date.now(),
): boolean {
  ensurePrematchFullOnlyLoaded();
  if (modeRef.value === "off")
    return true;
  if (modeRef.value === "liveRound")
    notePrematchFullLiveRound(match);
  if (Number(bet.round) !== 0)
    return false;
  return isMatchUnstarted(match, now);
}

function cloneMatchWithBets(match: ViewMatch, bets: ViewBet[]): ViewMatch {
  return Object.assign(Object.create(Object.getPrototypeOf(match)), match, { bets }) as ViewMatch;
}

/** off → 原数组引用。开启后浅拷贝 bets，无合格盘则丢整场。不 mutate 源 bets。 */
export function filterMatchesForPrematchFull(matches: ViewMatch[], now = Date.now()): ViewMatch[] {
  ensurePrematchFullOnlyLoaded();
  if (modeRef.value === "off")
    return matches;
  const out: ViewMatch[] = [];
  for (const match of matches) {
    const bets = match.bets.filter(bet => isPrematchFullMarketAllowed(match, bet, now));
    if (!bets.length)
      continue;
    if (bets.length === match.bets.length)
      out.push(match);
    else
      out.push(cloneMatchWithBets(match, bets));
  }
  return out;
}

export function resetPrematchFullOnlyForTests(): void {
  loaded = false;
  modeRef.value = "off";
  seenLiveIds.value = new Set();
  try {
    localStorage.removeItem(PREMATCH_FULL_ONLY_LOCAL_KEY);
    sessionStorage.removeItem(PREMATCH_FULL_ONLY_SEEN_LIVE_SESSION_KEY);
  }
  catch {
    /* ignore */
  }
}
