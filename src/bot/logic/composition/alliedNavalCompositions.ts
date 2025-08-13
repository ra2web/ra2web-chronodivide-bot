import { GameApi, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition, createCanBuildChecker } from "./common";

export const getNavalCompositions = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    productionApi: ProductionApi,
): UnitComposition => {

    const hasNavalYard = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAYARD").length > 0;
    const hasAirforce = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAAIRC" || r.name === "AMRADR").length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GATECH").length > 0;

    // Basic naval formation
    let composition: UnitComposition = {};

    composition.DEST = 3; // Destroyer

    // Aegis cruiser as anti-air unit
    if (hasAirforce) {
        composition.AEGIS = 1; // Aegis Cruiser
    }

    // Carrier and dolphins as advanced units
    if (hasBattleLab) {
        composition.CARRIER = 1; // 1 carrier
        composition.DLPH = 2; // 2 dolphins to counter Giant Squid SQD
    }

    return composition;
}; 