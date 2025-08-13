import { GameApi, PlayerData } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition } from "./common";

export const getSovietComposition = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition => {
    const hasBarracks = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NAHAND").length > 0;
    const hasWarFactory = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NAWEAP").length > 0;
    const hasRadar = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NARADR").length > 0;
    const hasBattleLab = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NATECH").length > 0;

    const includeInfantry = !hasBattleLab && hasBarracks;
    return {
        ...(includeInfantry && { E2: 10 }),
        ...(hasWarFactory && { HTNK: 5, HTK: 1 }),
        ...(hasRadar && { V3: 1, HTK: 1 }),
        ...(hasBattleLab && { APOC: 2 }),
    };
};
