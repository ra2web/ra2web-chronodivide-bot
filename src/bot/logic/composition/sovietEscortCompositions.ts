import { GameApi, PlayerData } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition } from "./common";

// Soviet escort composition: provide AA escort for ground-first attacks.
export const getEscortComposition = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition => {
    const hasWarFactory = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "NAWEAP").length > 0;

    const escort: UnitComposition = {};
    if (hasWarFactory) {
        // HTK (Flak Track) as AA escort
        escort.HTK = 2;
    }
    return escort;
};


