import { GameApi, PlayerData } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition } from "./common";

export const getAlliedCompositions = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition => {
    const hasWarFactory = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAWEAP").length > 0;
    const hasAirforce =
        gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAAIRC" || r.name === "AMRADR").length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GATECH").length > 0;

    const composition: UnitComposition = {
        // 基础步兵单位
        E1: hasBattleLab ? 3 : 5,  // 有战斗实验室时减少步兵数量
    };

    // 战车工厂单位
    if (hasWarFactory) {
        composition.MTNK = hasBattleLab ? 2 : 3;  // 有战斗实验室时减少灰熊坦克数量
        composition.FV = 3;  // 保持一定数量的多功能步兵车
    }

    // 空军单位
    if (hasAirforce) {
        composition.JUMPJET = 6;  // 火箭飞行兵
    }

    // 战斗实验室单位
    if (hasBattleLab) {
        composition.SREF = 2;  // 光棱坦克
        composition.MGTK = 3;  // 幻影坦克
    }

    return composition;
};
