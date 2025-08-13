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
    const canBuildTeslaTank = canBuild("TTNK");
    const canBuildDesolate = canBuild("DESO");

    const hasBarracks = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NAHAND").length > 0;
    const hasWarFactory = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NAWEAP").length > 0;
    const hasRadar = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NARADR").length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NATECH").length > 0;

    const includeInfantry = !hasBattleLab && hasBarracks;
    return {
        ...(includeInfantry && { E2: 10 }),
        ...(canBuildDesolate && { DESO: 1 }),
        ...(hasWarFactory && { HTNK: 5, HTK: 1 }),
        ...(hasRadar && { V3: 1, HTK: 1 }),
        ...(canBuildTeslaTank && { TTNK: 1 }),
        ...(hasBattleLab && { APOC: 2 }),
    };
};
