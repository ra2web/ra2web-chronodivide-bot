import { GameApi, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition, createCanBuildChecker } from "./common";

export const getNavalCompositions = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    productionApi: ProductionApi,
): UnitComposition => {

    const hasNavalYard = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NAYARD").length > 0;
    const hasAirforce = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NARADR").length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NATECH").length > 0;

    // Basic naval formation
    let composition: UnitComposition = {};

    // Dreadnought as advanced unit
    composition.DRED = 1; // Dreadnought as main battle ship

    return composition;
}; 