import { GameApi, PlayerData } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition } from "./common";

export const getAlliedNavalCompositions = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition => {
    // 检查科技前置条件
    const hasNavalYard = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAYARD").length > 0;
    const hasAirforce = gameApi.getVisibleUnits(playerData.name, "self", 
        (r) => r.name === "GAAIRC" || r.name === "AMRADR"
    ).length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GATECH").length > 0;

    const composition: UnitComposition = {
        // DEBUG: 原始数量为3，调试时减少到2
        DEST: 2,  // DEBUG: 减少驱逐舰数量
    };

    // 有空指部/美国空指部时可以建造神盾巡洋舰
    if (hasAirforce) {
        // DEBUG: 原始数量为2，调试时减少到1
        composition.AEGIS = 1;  // DEBUG: 减少神盾巡洋舰数量
    }

    // 有作战实验室时可以建造海豚和航母
    if (hasBattleLab) {
        // DEBUG: 原始数量为2，调试时减少到1
        composition.DLPH = 1;   // DEBUG: 减少海豚数量
        composition.CARRIER = 1; // 保持航母数量不变
    }

    return composition;
}; 