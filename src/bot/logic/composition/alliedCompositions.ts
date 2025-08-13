import { GameApi, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { createCanBuildChecker, UnitComposition } from "./common.js";

export const getAlliedCompositions = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    productionApi: ProductionApi,
): UnitComposition => {
    const canBuild = createCanBuildChecker(productionApi);
    const canBuildSniper = canBuild("SNIPE");
    const canBuildRocketeer = canBuild("JUMPJET");
    const canBuildTankDestroyer = canBuild("TNKD");

    const hasBarracks = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAPILE").length > 0;
    const hasWarFactory = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAWEAP").length > 0;
    const hasAirforce =
        gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAAIRC" || r.name === "AMRADR").length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GATECH").length > 0;

    const includeInfantry = !canBuildRocketeer && !hasBattleLab && hasBarracks;

    return {
        ...(includeInfantry && { E1: 5 }),
        ...(canBuildSniper && { SNIPE: 1 }),
        ...(hasWarFactory && !canBuildRocketeer && { MTNK: 6, FV: 1 }),
        ...(hasWarFactory && canBuildRocketeer && { MTNK: 3 }),
        ...(canBuildTankDestroyer && { TNKD: 1 }),
        // Rocketeer can attack ground; keep as part of main force when available
        ...(canBuildRocketeer && { JUMPJET: 6, FV: 1 }),
        ...(hasBattleLab && { SREF: 2, MGTK: 3, FV: 1 }),
    };
};
