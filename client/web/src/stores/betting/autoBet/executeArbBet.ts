import type { ViewBet, ViewMatch } from "@/models/match";
import type { ArbAttemptPhase } from "@/stores/betting/autoBet/arbAttemptMetrics";
import type { ArbBetAttemptParams } from "@/stores/betting/autoBet/phases/types";
import type { UserConfig } from "@/types/userConfig";
import { isMapMuteActive } from "@/extensions/mapBetMute";
import { isPrematchFullMarketAllowed } from "@/extensions/prematchFullOnly";
import {
  recordArbAttemptMetric,
} from "@/stores/betting/autoBet/arbAttemptMetrics";
import { checkArbLegs } from "@/stores/betting/autoBet/phases/checkArbLegs";
import { finalizeArbBet } from "@/stores/betting/autoBet/phases/finalizeArbBet";
import { placeArbLegs } from "@/stores/betting/autoBet/phases/placeArbLegs";
import { prepareArbAttempt } from "@/stores/betting/autoBet/phases/prepareArbAttempt";

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = performance.now();
  const value = await run();
  return { value, ms: Math.round(performance.now() - startedAt) };
}

/** 单场单 bet 行的自动套利执行（选号 → 预检 → 下单 → 拒单/绑单/补单/收尾） */
export async function executeArbBet(params: {
  match: ViewMatch;
  bet: ViewBet;
  config: UserConfig;
  setMessage: (msg: string) => void;
}): Promise<void> {
  // [changmen 扩展] 赛前全场过滤：关则恒放行；开则只留下未开赛全场
  if (!isPrematchFullMarketAllowed(params.match, params.bet))
    return;
  // [changmen 扩展] 用户折叠的全场 / 地图：跳过本盘（live 局互斥，不跳过）
  if (isMapMuteActive(params.match.id, params.bet.round, params.match.liveRound))
    return;

  const attempt: ArbBetAttemptParams = { ...params };

  const phaseMsMap: Partial<Record<ArbAttemptPhase, number>> = {};
  const base = { at: Date.now(), matchId: params.match.id, betId: params.bet.id };

  const prepared = await timed(() => prepareArbAttempt(attempt));
  phaseMsMap.prepare = prepared.ms;
  const ready = prepared.value;
  if (!ready) {
    recordArbAttemptMetric({ ...base, phaseMs: phaseMsMap, stop: "skip_prepare" });
    return;
  }

  const checked = await timed(() => checkArbLegs(attempt, ready));
  phaseMsMap.check = checked.ms;
  const checkedValue = checked.value;
  if (!checkedValue) {
    recordArbAttemptMetric({ ...base, phaseMs: phaseMsMap, stop: "skip_check" });
    return;
  }

  // 预检通过后：place 必回传两腿结果，编排层 finalize 必跑（场馆 settle 仍只处理 API 成功腿）
  const placed = await timed(() => placeArbLegs(attempt, checkedValue));
  phaseMsMap.place = placed.ms;

  const finalized = await timed(() => finalizeArbBet(attempt, placed.value));
  phaseMsMap.finalize = finalized.ms;
  recordArbAttemptMetric({ ...base, phaseMs: phaseMsMap, stop: "complete" });
}
