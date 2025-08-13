import {
    ActionsApi,
    GameApi,
    OrderType,
    PlayerData,
    ProductionApi,
    Vector2,
    LandType,
    SpeedType,
    MovementZone,
} from "@chronodivide/game-api";
import { Mission, MissionAction, requestUnits, noop, disbandMission, grabCombatants } from "../mission.js";
import { ActionBatcher, BatchableAction } from "../actionBatcher.js";
import { MatchAwareness } from "../../awareness.js";
import { DebugLogger, countBy } from "../../common/utils.js";
import { pushToPointSafe } from "../../common/navalUtils.js";
import { MissionFactory } from "../missionFactories.js";
import { MissionController } from "../missionController.js";

/**
 * Defend against Allied destroyer coastal harassment: gather 3 Rhinos (MTNK) to go to the shore and attack DEST.
 */
export class AntiCoastShipMission extends Mission<null> {
    private readonly requiredUnits: Record<string, number> = { MTNK: 3 };
    private readonly targetId: number;
    private readonly targetPos: Vector2;
    private stage: "gather" | "attack" = "gather";

    constructor(uniqueName: string, targetId: number, targetPos: Vector2, logger: DebugLogger) {
        super(uniqueName, logger);
        this.targetId = targetId;
        this.targetPos = targetPos;
    }

    getPriority(): number {
        return 500;
    }

    isUnitsLocked(): boolean {
        return false;
    }

    getGlobalDebugText(): string | undefined {
        return `AntiCoast → DEST#${this.targetId}`;
    }

    _onAiUpdate(
        gameApi: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        // Check if destroyer is still alive
        const destData = gameApi.getUnitData(this.targetId);
        if (!destData) {
            return disbandMission();
        }
        this.targetPos.set(destData.tile.rx, destData.tile.ry);

        // Count existing MTNK
        const currentComp = countBy(this.getUnitsGameObjectData(gameApi), (u) => u.name);
        const missing = Object.entries(this.requiredUnits).filter(
            ([unit, want]) => (currentComp[unit] || 0) < want,
        );
        if (missing.length > 0) {
            // Request to build missing tanks and immediately grab all available combat units nearby to participate in coastal defense
            const requested = requestUnits(missing.map(([u]) => u), this.getPriority());
            const grab = grabCombatants(playerData.startLocation, this.getPriority());
            // Return grab, let MissionController assign free combat units; requests will be recorded in updateUnitTypes
            return grab;
        }

        const squadUnits = this.getUnits(gameApi);
        if (this.stage === "gather") {
            // simple gather: units move towards rally point near base
            const rally = playerData.startLocation;
            const allClose = squadUnits.every(
                (u) => new Vector2(u.tile.rx, u.tile.ry).distanceTo(rally) <= 4,
            );
            if (!allClose) {
                squadUnits.forEach((u) => pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.Move, rally));
                return noop();
            }
            this.stage = "attack";
        }

        // ATTACK stage
        squadUnits.forEach((u) => {
            // Ground units use AttackMove to within 2 tiles of destroyer's current shore position
            pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.AttackMove, this.targetPos);
        });
        return noop();
    }
}

export class AntiCoastShipMissionFactory implements MissionFactory {
    getName() {
        return "AntiCoastShipMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        // skip if mission already exists
        if (missionController.getMissions().some((m) => m instanceof AntiCoastShipMission)) return;

        // List of ships of interest
        const COAST_THREAT_UNITS = ["DEST", "AEGIS", "CARRIER", "DRED", "HYD"];

        const coastThreats = gameApi
            .getVisibleUnits(playerData.name, "enemy", (r) => COAST_THREAT_UNITS.includes(r.name))
            .filter((id) => {
                const u = gameApi.getUnitData(id);
                if (!u) return false;
                if (u.rules.movementZone !== MovementZone.Water) return false;

                // Try pathfinding; if land route can approach and endpoint is <= 6 tiles from target, consider it attackable
                try {
                    const startTile = gameApi.mapApi.getTile(playerData.startLocation.x, playerData.startLocation.y);
                    const targetTile = gameApi.mapApi.getTile(u.tile.rx, u.tile.ry);
                    if (!startTile || !targetTile) return false;

                    const path = gameApi.mapApi.findPath(
                        SpeedType.Track,
                        false,
                        { tile: startTile, onBridge: false },
                        { tile: targetTile, onBridge: false },
                    );
                    if (!path || path.length === 0) return false;
                    const endNode = path[0];
                    const distEnd = new Vector2(endNode.tile.rx, endNode.tile.ry).distanceTo(
                        new Vector2(u.tile.rx, u.tile.ry),
                    );
                    return distEnd <= 6;
                } catch (err) {
                    return false;
                }
            });

        if (coastThreats.length === 0) return;

        const destId = coastThreats[0];
        const destData = gameApi.getUnitData(destId);
        if (!destData) return;
        const pos = new Vector2(destData.tile.rx, destData.tile.ry);

        const mission = new AntiCoastShipMission("antiCoast_" + gameApi.getCurrentTick(), destId, pos, logger);
        missionController.addMission(mission);
    }

    onMissionFailed() {}
} 