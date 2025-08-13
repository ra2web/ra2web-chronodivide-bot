import {
    ActionsApi,
    GameApi,
    OrderType,
    PlayerData,
    ProductionApi,
    Vector2,
} from "@chronodivide/game-api";
import { Mission, MissionAction, requestUnits, noop, disbandMission } from "../mission.js";
import { ActionBatcher } from "../actionBatcher.js";
import { MatchAwareness } from "../../awareness.js";
import { DebugLogger, countBy } from "../../common/utils.js";
import { MissionFactory } from "../missionFactories.js";
import { MissionController } from "../missionController.js";
import { pushToPointSafe } from "../../common/navalUtils.js";

const ESCORT_SUB_COUNT = 3;
const ESCORT_HYD_COUNT = 2;
const ESCORT_PRIORITY = 101;

/**
 * A mission that ensures each Dreadnought (DRED) has a personal escort of 3 Submarines (SUB) and 2 Sea Scorpions (HYD).
 */
export class DreadEscortMission extends Mission<null> {
    private readonly dreadId: number;

    constructor(uniqueName: string, dreadId: number, private loggerCtx: DebugLogger) {
        super(uniqueName, loggerCtx);
        this.dreadId = dreadId;
    }

    getDreadId() {
        return this.dreadId;
    }

    getPriority(): number {
        return ESCORT_PRIORITY;
    }

    // Allow higher priority missions to steal subs if needed, but default keeps them.
    isUnitsLocked(): boolean {
        return true; // lock escort units so they stay with the dreadnought
    }

    getGlobalDebugText(): string | undefined {
        return `MixedEscort→DRED#${this.dreadId}`;
    }

    _onAiUpdate(
        gameApi: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const dread = gameApi.getUnitData(this.dreadId);
        if (!dread) {
            // Dreadnought destroyed – mission ends.
            return disbandMission();
        }

        // Ensure required escort units are present.
        const currentSelfComp = countBy(this.getUnitsGameObjectData(gameApi), (u) => u.name);
        const subCount = currentSelfComp["SUB"] || 0;
        const hydCount = currentSelfComp["HYD"] || 0;
        
        // Check for missing units and request them
        const missingUnits = [];
        if (subCount < ESCORT_SUB_COUNT) {
            const missingSubs = ESCORT_SUB_COUNT - subCount;
            missingUnits.push(...Array(missingSubs).fill("SUB"));
        }
        if (hydCount < ESCORT_HYD_COUNT) {
            const missingHyds = ESCORT_HYD_COUNT - hydCount;
            missingUnits.push(...Array(missingHyds).fill("HYD"));
        }
        
        if (missingUnits.length > 0) {
            return requestUnits(missingUnits, this.getPriority());
        }

        // Follow the dreadnought – order escort units to AttackMove towards the dread's current tile.
        const dest = new Vector2(dread.tile.rx, dread.tile.ry);
        this.getUnits(gameApi).forEach((unit) => {
            pushToPointSafe(gameApi, actionBatcher, unit.id, OrderType.AttackMove, dest);
        });
        return noop();
    }
}

export class DreadEscortMissionFactory implements MissionFactory {
    getName() {
        return "DreadEscortMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        // Find all visible friendly dreadnoughts.
        const dreadIds = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "DRED");
        if (dreadIds.length === 0) return;

        // For each dread, ensure an escort mission exists.
        dreadIds.forEach((dreadId) => {
            const exists = missionController
                .getMissions()
                .some(
                    (m): m is DreadEscortMission => m instanceof DreadEscortMission && m.getDreadId() === dreadId,
                );
            if (!exists) {
                const mission = new DreadEscortMission(`escortDred_${dreadId}`, dreadId, logger);
                missionController.addMission(mission);
            }
        });
    }

    onMissionFailed() {
        // No special handling
    }
} 