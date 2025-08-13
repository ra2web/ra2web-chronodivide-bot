import {
    ActionsApi,
    GameApi,
    OrderType,
    PlayerData,
    ProductionApi,
    Vector2,
} from "@chronodivide/game-api";
import { Mission, MissionAction, requestUnits, noop, disbandMission } from "../mission.js";
import { ActionBatcher, BatchableAction } from "../actionBatcher.js";
import { MatchAwareness } from "../../awareness.js";
import { DebugLogger, countBy } from "../../common/utils.js";
import { hasClearWaterLoS, findWaterFiringPoint, pushToPointSafe } from "../../common/navalUtils.js";
import { MissionFactory } from "../missionFactories.js";
import { MissionController } from "../missionController.js";

const SIGHT_RADIUS = 12;

export class AntiSubMission extends Mission<null> {
    private readonly requiredUnits: Record<string, number>;
    private readonly threatPos: Vector2;
    private stage: "gather" | "attack" = "gather";

    constructor(uniqueName: string, threatPos: Vector2, wantSubs: boolean, logger: DebugLogger) {
        super(uniqueName, logger);
        this.threatPos = threatPos;
        this.requiredUnits = wantSubs ? { SUB: 2 } : { DEST: 1, DLPH: 2 };
    }

    getPriority(): number {
        return 85;
    }

    isUnitsLocked(): boolean {
        return false;
    }

    getGlobalDebugText(): string | undefined {
        return `AntiSub → (${this.threatPos.x},${this.threatPos.y})`;
    }

    _onAiUpdate(
        gameApi: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        // If threat disappears
        const hostiles = matchAwareness.getHostilesNearPoint2d(this.threatPos, SIGHT_RADIUS);
        const subsLeft = hostiles.filter(({ unitId }) => {
            const u = gameApi.getUnitData(unitId);
            return u && ["SUB", "DLPH", "SQD"].includes(u.name);
        });
        if (subsLeft.length === 0) {
            return disbandMission();
        }

        // Request units
        const currentComp = countBy(this.getUnitsGameObjectData(gameApi), (u) => u.name);
        const missing = Object.entries(this.requiredUnits).filter(
            ([unit, need]) => (currentComp[unit] || 0) < need,
        );
        if (missing.length > 0) {
            return requestUnits(missing.map(([u]) => u), this.getPriority());
        }

        const squadUnits = this.getUnits(gameApi);

        if (this.stage === "gather") {
            // Move towards threatPos (water tile)
            squadUnits.forEach((u) =>
                pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.AttackMove, this.threatPos),
            );
            const allNear = squadUnits.every(
                (u) => new Vector2(u.tile.rx, u.tile.ry).distanceTo(this.threatPos) <= 4,
            );
            if (allNear) this.stage = "attack";
            return noop();
        }

        // attack stage: each unit pick nearest hostile sub/dolphin
        squadUnits.forEach((u) => {
            let closest: number | null = null;
            let minDist = Infinity;
            for (const { unitId } of subsLeft) {
                const d = new Vector2(gameApi.getUnitData(unitId)!.tile.rx, gameApi.getUnitData(unitId)!.tile.ry).distanceTo(
                    new Vector2(u.tile.rx, u.tile.ry),
                );
                if (d < minDist) {
                    minDist = d;
                    closest = unitId;
                }
            }
            if (closest !== null) {
                actionBatcher.push(BatchableAction.toTargetId(u.id, OrderType.Attack, closest));
            }
        });
        return noop();
    }
}

export class AntiSubMissionFactory implements MissionFactory {
    getName() {
        return "AntiSubMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        if (missionController.getMissions().some((m) => m instanceof AntiSubMission)) return;

        // find hostile subs/dolphins/squids near own naval units or shipyard
        const enemySubs = gameApi.getVisibleUnits(playerData.name, "enemy", (r) =>
            ["SUB", "DLPH", "SQD"].includes(r.name),
        );
        if (enemySubs.length === 0) return;
        // Pick first threat
        const subId = enemySubs[0];
        const data = gameApi.getUnitData(subId);
        if (!data) return;
        const pos = new Vector2(data.tile.rx, data.tile.ry);

        const wantSubs = playerData.country?.side === 1; // Nod (soviet)
        const mission = new AntiSubMission("antiSub_" + gameApi.getCurrentTick(), pos, wantSubs, logger);
        missionController.addMission(mission);
    }

    onMissionFailed() {}
} 