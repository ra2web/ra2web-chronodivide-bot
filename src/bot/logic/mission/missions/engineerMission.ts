import { ActionsApi, GameApi, OrderType, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import { DebugLogger } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";

const CAPTURE_COOLDOWN_TICKS = 120;

/**
 * A mission that tries to send an engineer into a building (e.g. to capture tech building or repair bridge)
 */
export class EngineerMission extends Mission {
    private hasAttemptedCaptureWith: {
        unitId: number;
        gameTick: number;
    } | null = null;

    constructor(
        uniqueName: string,
        private priority: number,
        private captureTargetId: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    public _onAiUpdate(
        gameApi: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const engineerTypes = ["ENGINEER", "SENGINEER"];
        const engineers = this.getUnitsOfTypes(gameApi, ...engineerTypes);
        if (engineers.length === 0) {
            // Perhaps we deployed already (or the unit was destroyed), end the mission.
            if (this.hasAttemptedCaptureWith !== null) {
                return disbandMission();
            }
            return requestUnits(engineerTypes, this.priority);
        } else if (
            !this.hasAttemptedCaptureWith ||
            gameApi.getCurrentTick() > this.hasAttemptedCaptureWith.gameTick + CAPTURE_COOLDOWN_TICKS
        ) {
            actionsApi.orderUnits(
                engineers.map((engineer) => engineer.id),
                OrderType.Capture,
                this.captureTargetId,
            );
            // Add a cooldown to deploy attempts.
            this.hasAttemptedCaptureWith = {
                unitId: engineers[0].id,
                gameTick: gameApi.getCurrentTick(),
            };
        }
        return noop();
    }

    public getGlobalDebugText(): string | undefined {
        return undefined;
    }

    public getPriority() {
        return this.priority;
    }
}

// Only try to capture tech buildings within this radius of the starting point.
const MAX_TECH_CAPTURE_RADIUS = 50;

const TECH_CHECK_INTERVAL_TICKS = 300;

export class EngineerMissionFactory implements MissionFactory {
    private lastCheckAt = 0;

    getName(): string {
        return "EngineerMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        if (!(gameApi.getCurrentTick() > this.lastCheckAt + TECH_CHECK_INTERVAL_TICKS)) {
            return;
        }
        this.lastCheckAt = gameApi.getCurrentTick();
        const eligibleTechBuildings = gameApi.getVisibleUnits(
            playerData.name,
            "hostile",
            (r) => r.capturable && r.produceCashAmount > 0,
        );

        eligibleTechBuildings.forEach((techBuildingId) => {
            missionController.addMission(new EngineerMission("capture-" + techBuildingId, 100, techBuildingId, logger));
        });
    }

    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission<any>,
        failureReason: undefined,
        missionController: MissionController,
    ): void {}
}
