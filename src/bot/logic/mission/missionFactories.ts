import { GameApi, PlayerData } from "@chronodivide/game-api";
import { ExpansionMissionFactory } from "./missions/expansionMission.js";
import { Mission } from "./mission.js";
import { MatchAwareness } from "../awareness.js";
import { ScoutingMissionFactory } from "./missions/scoutingMission.js";
import { AttackMissionFactory } from "./missions/attackMission.js";
import { MissionController } from "./missionController.js";
import { DefenceMissionFactory } from "./missions/defenceMission.js";
import { DebugLogger } from "../common/utils.js";
import { EngineerMissionFactory } from "./missions/engineerMission.js";
import { NavalMissionFactory } from "./missions/navalMission.js";

export interface MissionFactory {
    getName(): string;

    /**
     * Queries the factory for new missions to be spawned.
     *
     * @param gameApi
     * @param playerData
     * @param matchAwareness
     * @param missionController
     */
    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void;

    /**
     * Called when any mission fails - can be used to trigger another mission in response.
     */
    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission<any>,
        failureReason: any,
        missionController: MissionController,
        logger: DebugLogger,
    ): void;
}

export const createMissionFactories = () => [
    new ExpansionMissionFactory(),
    new ScoutingMissionFactory(),
    new AttackMissionFactory(),
    new DefenceMissionFactory(),
    new EngineerMissionFactory(),
    new NavalMissionFactory(),
];
