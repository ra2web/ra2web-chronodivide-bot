import { ActionsApi, GameApi, OrderType, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { Mission, MissionAction, disbandMission, noop, requestSpecificUnits, requestUnits } from "../mission.js";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import { DebugLogger } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";

const DEPLOY_COOLDOWN_TICKS = 30;

/**
 * A mission that tries to create an MCV (if it doesn't exist) and deploy it somewhere it can be deployed.
 */
export class ExpansionMission extends Mission {
    private hasAttemptedDeployWith: {
        unitId: number;
        gameTick: number;
    } | null = null;

    constructor(
        uniqueName: string,
        private priority: number,
        private selectedMcv: number | null,
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
        const mcvTypes = ["AMCV", "SMCV"];
        const mcvs = this.getUnitsOfTypes(gameApi, ...mcvTypes);
        if (mcvs.length === 0) {
            // Perhaps we deployed already (or the unit was destroyed), end the mission.
            if (this.hasAttemptedDeployWith !== null) {
                return disbandMission();
            }
            // We need an mcv!
            if (this.selectedMcv) {
                return requestSpecificUnits([this.selectedMcv], this.priority);
            } else {
                return requestUnits(mcvTypes, this.priority);
            }
        } else if (
            !this.hasAttemptedDeployWith ||
            gameApi.getCurrentTick() > this.hasAttemptedDeployWith.gameTick + DEPLOY_COOLDOWN_TICKS
        ) {
            actionsApi.orderUnits(
                mcvs.map((mcv) => mcv.id),
                OrderType.DeploySelected,
            );
            // Add a cooldown to deploy attempts.
            this.hasAttemptedDeployWith = {
                unitId: mcvs[0].id,
                gameTick: gameApi.getCurrentTick(),
            };
        }
        return noop();
    }

    public getGlobalDebugText(): string | undefined {
        return `Expand with MCV ${this.selectedMcv}`;
    }

    public getPriority() {
        return this.priority;
    }
}

export class ExpansionMissionFactory implements MissionFactory {
    getName(): string {
        return "ExpansionMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        // At this point, only expand if we have a loose MCV.
        const mcvs = gameApi.getVisibleUnits(playerData.name, "self", (r) =>
            gameApi.getGeneralRules().baseUnit.includes(r.name),
        );
        mcvs.forEach((mcv) => {
            missionController.addMission(new ExpansionMission("expand-with-" + mcv, 100, mcv, logger));
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
