import { GameApi, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition } from "./common";

export const getAlliedCompositions = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    productionApi: ProductionApi,
): UnitComposition => {
    const hasBarracks = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAPILE").length > 0;
    const hasWarFactory = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAWEAP").length > 0;
    const hasAirforce =
        gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAAIRC" || r.name === "AMRADR").length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GATECH").length > 0;

    const includeInfantry = !hasAirforce && !hasBattleLab && hasBarracks;
    return {
        ...(includeInfantry && { E1: 5 }),
        // Ground-first main force; AA (IFV) moved to escort composition
        ...(hasWarFactory && !hasAirforce && { MTNK: 6, FV: 1 }),
        ...(hasWarFactory && hasAirforce && { MTNK: 3 }),
        // Rocketeer can attack ground; keep as part of main force when available
        ...(hasAirforce && { JUMPJET: 6, FV: 1 }),
        ...(hasBattleLab && { SREF: 2, MGTK: 3, FV: 1 }),
    };
};
