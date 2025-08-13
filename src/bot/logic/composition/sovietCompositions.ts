import { GameApi, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition, createCanBuildChecker } from "./common.js";

export const getSovietComposition = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    productionApi: ProductionApi,
): UnitComposition => {
    const canBuild = createCanBuildChecker(productionApi);

    // 单个单位检查
    const canBuildInfantry = canBuild("E2");
    const canBuildDesolate = canBuild("DESO");
    const canBuildRhinoTank = canBuild("HTNK");
    const canBuildWarMiner = canBuild("HTK");
    const canBuildV3Rocket = canBuild("V3");
    const canBuildTeslaTank = canBuild("TTNK");
    const canBuildApocalypse = canBuild("APOC");
    const canBuildSHK = canBuild("SHK");

    const includeInfantry = !canBuildApocalypse && canBuildInfantry;

    // 构建组合对象
    const composition: UnitComposition = {};

    // 放射兵
    if (canBuildDesolate) {
        composition.DESO = 1;
    }

    if (canBuildSHK) {
        composition.SHK = 1;
    }

    // 基础步兵组合
    if (includeInfantry) {
        composition.E2 = 10;
    } else {
        composition.E2 = 1;
    }

    // 犀牛坦克组合
    if (canBuildRhinoTank) {
        composition.HTNK = 5;
    }

    // V3火箭组合
    if (canBuildV3Rocket) {
        composition.V3 = 1;
    }

    // 防空履带车 (支持犀牛坦克或V3火箭)
    if (canBuildWarMiner && (canBuildRhinoTank || canBuildV3Rocket)) {
        composition.HTK = 1;
    }

    // 磁能坦克
    if (canBuildTeslaTank) {
        composition.TTNK = 1;
    }

    // 天启坦克组合 (作战实验室科技)
    if (canBuildApocalypse) {
        composition.APOC = 2;
    }

    return composition;
};
