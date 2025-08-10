import { GameApi, PlayerData } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { UnitComposition } from "./common";

// Allied escort composition: provide AA escort that follows and defends the main ground force.
export const getEscortComposition = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition => {
    const hasWarFactory = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAWEAP").length > 0;

    const escort: UnitComposition = {};
    if (hasWarFactory) {
        // IFV as AA escort; number can be tuned later or made threat-aware
        escort.FV = 2;
    }
    return escort;
};


