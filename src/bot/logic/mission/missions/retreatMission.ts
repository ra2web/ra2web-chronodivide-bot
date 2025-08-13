import { DebugLogger } from "../../common/utils.js";
import { ActionsApi, GameApi, OrderType, PlayerData, ProductionApi, Vector2 } from "@chronodivide/game-api";
import { Mission, MissionAction, disbandMission, requestSpecificUnits } from "../mission.js";
import { ActionBatcher } from "../actionBatcher.js";
import { MatchAwareness } from "../../awareness.js";

export class RetreatMission extends Mission {
    private createdAt: number | null = null;

    constructor(
        uniqueName: string,
        private retreatToPoint: Vector2,
        private withUnitIds: number[],
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    public     _onAiUpdate(
        gameApi: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        if (!this.createdAt) {
            this.createdAt = gameApi.getCurrentTick();
        }
        if (this.getUnitIds().length > 0) {
            // Only send the order once we have managed to claim some units.
            actionsApi.orderUnits(
                this.getUnitIds(),
                OrderType.AttackMove,
                this.retreatToPoint.x,
                this.retreatToPoint.y,
            );
            return disbandMission();
        }
        if (this.createdAt && gameApi.getCurrentTick() > this.createdAt + 240) {
            // Disband automatically after 240 ticks in case we couldn't actually claim any units.
            return disbandMission();
        } else {
            return requestSpecificUnits(this.withUnitIds, 1000);
        }
    }

    public getGlobalDebugText(): string | undefined {
        return `retreat with ${this.withUnitIds.length} units`;
    }

    public getPriority() {
        return 100;
    }
}
