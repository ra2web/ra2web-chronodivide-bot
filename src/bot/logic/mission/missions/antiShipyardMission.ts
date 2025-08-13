import {
    ActionsApi,
    OrderType,
    GameApi,
    PlayerData,
    ProductionApi,
    Vector2,
    SideType,
    SpeedType,
    LandType,
    GameMath,
} from "@chronodivide/game-api";
import { MatchAwareness } from "../../awareness.js";
import {
    Mission,
    MissionAction,
    requestUnits,
    noop,
} from "../mission.js";
import { ActionBatcher, BatchableAction } from "../actionBatcher.js";
import { DebugLogger, countBy } from "../../common/utils.js";
import { MissionFactory } from "../missionFactories.js";
import { MissionController } from "../missionController.js";

/**
 * A simple 'anti-shipyard' mission:
 *  - After discovering enemy shipyard, quickly build 3 submarines or 5 dolphins
 *  - Once units are assembled, directly Attack-Move to enemy shipyard position
 */
export class AntiShipyardMission extends Mission<null> {
    private readonly targetPos: Vector2;
    private readonly requiredUnits: Record<string, number>;
    private shipyardId: number | null;
    private stage: "gather" | "approach" | "patrol" | "destroy" = "gather";
    private rallyPoint: Vector2;
    private patrolPoints: Vector2[] = [];
    private currentPatrolIdx = 0;
    private lastHostileTick = 0;
    private initialized = false;
    // cooldown control for reposition logic
    private lastRepositionTick = 0;

    /**
     * Determine if there's a '≥2 tiles wide' passable water corridor along the from → to ray.
     * corridorHalfWidth = 1 means checking 1 tile on each side of the center line (3×3 check area total), satisfying the '2 tiles width' requirement.
     */
    private hasClearWaterLoS(
        gameApi: GameApi,
        from: Vector2,
        to: Vector2,
        corridorHalfWidth: number = 1,
    ): boolean {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        if (steps === 0) return true;

        for (let i = 0; i <= steps; i++) {
            const cx = Math.round(from.x + (dx * i) / steps);
            const cy = Math.round(from.y + (dy * i) / steps);

            // Scan all tiles within corridorHalfWidth range around center tile, ensuring no obstruction
            for (let ox = -corridorHalfWidth; ox <= corridorHalfWidth; ox++) {
                for (let oy = -corridorHalfWidth; oy <= corridorHalfWidth; oy++) {
                    const tx = cx + ox;
                    const ty = cy + oy;
                    const tile = gameApi.mapApi.getTile(tx, ty);
                    if (!tile) return false; // Out of bounds means blocked

                    // If not Clear/Water or covered by bridge, consider it blocked
                    if ((tile.landType !== LandType.Clear && tile.landType !== LandType.Water) || tile.onBridgeLandType !== undefined) {
                        return false;
                    }
                }
            }
        }
        return true;
    }

    /** Randomly find a water position around shipyard with unobstructed line of sight */
    private findWaterFiringPoint(
        gameApi: GameApi,
        radiusMin: number,
        radiusMax: number,
        attempts: number = 10,
    ): Vector2 | null {
        for (let attempt = 0; attempt < attempts; attempt++) {
            const ang = gameApi.generateRandom() * Math.PI * 2;
            const radius = radiusMin + gameApi.generateRandom() * (radiusMax - radiusMin);
            const dest = this.targetPos.add(
                new Vector2(Math.round(GameMath.cos(ang) * radius), Math.round(GameMath.sin(ang) * radius)),
            );
            const tile = gameApi.mapApi.getTile(dest.x, dest.y);
            if (!tile) continue;
            if (tile.landType !== LandType.Water || tile.onBridgeLandType !== undefined) continue;
            // Must have unobstructed line of sight to shipyard
            if (!this.hasClearWaterLoS(gameApi, dest, this.targetPos)) continue;
            return dest;
        }
        return null;
    }

    /** Safe wrapper for toPoint: ignore command if destination tile is invalid */
    private pushToPointSafe(
        gameApi: GameApi,
        actionBatcher: ActionBatcher,
        unitId: number,
        orderType: OrderType,
        point: Vector2,
    ) {
        if (gameApi.mapApi.getTile(point.x, point.y)) {
            actionBatcher.push(BatchableAction.toPoint(unitId, orderType, point));
        }
    }

    constructor(
        uniqueName: string,
        targetPos: Vector2,
        wantSubs: boolean,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        this.targetPos = targetPos;
        this.shipyardId = null;

        this.rallyPoint = targetPos; // temporary, will be set in _onAiUpdate
        this.requiredUnits = wantSubs ? { SUB: 3 } : { DLPH: 5 };
    }

    /** High priority, ensures ability to acquire submarines/dolphins */
    getPriority(): number {
        return 80;
    }

    /** Allow other missions to steal units back from this mission */
    isUnitsLocked(): boolean {
        return false;
    }

    getGlobalDebugText(): string | undefined {
        return `AntiShipyard → (${this.targetPos.x},${this.targetPos.y})`;
    }

    _onAiUpdate(
        gameApi: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        // Initialize rally point on first call
        if (!this.initialized) {
            // Use position of any unit in current squad as starting point
            const squadUnits = this.getUnits(gameApi);
            // fallback: use our shipyard position
            let startPos = this.targetPos; // worst case fallback
            const ourShipyards = gameApi.getVisibleUnits(playerData.name, "self", r => r.name === "GAYARD" || r.name === "NAYARD");
            if (ourShipyards.length > 0) {
                const ourYard = gameApi.getUnitData(ourShipyards[0]);
                if (ourYard) {
                    startPos = new Vector2(ourYard.tile.rx, ourYard.tile.ry);
                }
            }
            if (squadUnits.length > 0) {
                const firstUnit = squadUnits[0];
                startPos = new Vector2(firstUnit.tile.rx, firstUnit.tile.ry);
            }
            
            const startTile = gameApi.mapApi.getTile(startPos.x, startPos.y);
            const endTile = gameApi.mapApi.getTile(this.targetPos.x, this.targetPos.y);
            let mid = startPos;
            if (startTile && endTile) {
                const path = gameApi.mapApi.findPath(
                    SpeedType.Float,
                    false,
                    { tile: startTile, onBridge: false },
                    { tile: endTile, onBridge: false },
                );
                if (path && path.length > 2) {
                    const midNode = path[Math.floor(path.length / 5 * 4)];
                    mid = new Vector2(midNode.tile.rx, midNode.tile.ry);
                }
            }
            this.rallyPoint = mid;
            this.initialized = true;
        }

        // 1. Count currently owned target units
        const currentComp = countBy(this.getUnitsGameObjectData(gameApi), (u) => u.name);
        const missing = Object.entries(this.requiredUnits).filter(
            ([unitName, want]) => (currentComp[unitName] || 0) < want,
        );

        if (missing.length > 0) {
            // Request missing units
            return requestUnits(
                missing.map(([name]) => name),
                /* priority */ this.getPriority(),
            );
        }

        // ----------------- Stage logic -----------------
        const SIGHT_RADIUS = 12;
        const squadUnits = this.getUnits(gameApi);

        // --- GATHER ---
        if (this.stage === "gather") {
            const allClose = squadUnits.every((u) =>
                new Vector2(u.tile.rx, u.tile.ry).distanceTo(this.rallyPoint) <= 4,
            );

            if (!allClose) {
                squadUnits.forEach((u) => {
                    this.pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.Move, this.rallyPoint);
                });
                return noop();
            }

            // Generate patrol points after assembly
            if (this.patrolPoints.length === 0) {
                for (let i = 0; i < 3; i++) {
                    const ang = (Math.PI * 2 * i) / 3;
                    const pt = this.targetPos.add(
                        new Vector2(Math.round(GameMath.cos(ang) * 6), Math.round(GameMath.sin(ang) * 6)),
                    );
                    this.patrolPoints.push(pt);
                }
            }
            this.stage = "approach";
            this.lastHostileTick = gameApi.getCurrentTick();
        }

        // --- APPROACH ---
        if (this.stage === "approach") {
            const nearShipyard = squadUnits.every((u) =>
                new Vector2(u.tile.rx, u.tile.ry).distanceTo(this.targetPos) <= SIGHT_RADIUS,
            );

            if (nearShipyard) {
                this.stage = "patrol";
            } else {
                // Move from rally point to shipyard, use AttackMove to clear enemies along the way
                squadUnits.forEach((u) => {
                    this.pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.AttackMove, this.targetPos);
                });
                return noop();
            }
        }

        // hostiles near shipyard
        const hostiles = matchAwareness.getHostilesNearPoint2d(this.targetPos, SIGHT_RADIUS);
        if (hostiles.length > 0) {
            this.lastHostileTick = gameApi.getCurrentTick();
        }

        // --- PATROL ---
        if (this.stage === "patrol") {
            // Search for enemy naval units near shipyard (speedtype = float)
            const nearbyEnemyNaval = gameApi
                .getVisibleUnits(playerData.name, "enemy")
                .map(id => gameApi.getUnitData(id))
                .filter((unit): unit is NonNullable<typeof unit> => {
                    if (!unit) return false;
                    const distance = new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(this.targetPos);
                    return distance <= SIGHT_RADIUS && unit.rules.speedType === SpeedType.Float;
                });

            if (nearbyEnemyNaval.length > 0) {
                this.lastHostileTick = gameApi.getCurrentTick();
                // Attack nearest enemy naval unit
                squadUnits.forEach((u) => {
                    let closestEnemy = nearbyEnemyNaval[0];
                    let minDistance = new Vector2(u.tile.rx, u.tile.ry).distanceTo(new Vector2(closestEnemy.tile.rx, closestEnemy.tile.ry));
                    
                    for (const enemy of nearbyEnemyNaval) {
                        const distance = new Vector2(u.tile.rx, u.tile.ry).distanceTo(new Vector2(enemy.tile.rx, enemy.tile.ry));
                        if (distance < minDistance) {
                            closestEnemy = enemy;
                            minDistance = distance;
                        }
                    }
                     
                     if (closestEnemy) {
                         actionBatcher.push(BatchableAction.toTargetId(u.id, OrderType.Attack, closestEnemy.id));
                     }
                });
                return noop();
            }

            // If no naval enemies for 45 ticks (~3 seconds), switch to destroy
            if (gameApi.getCurrentTick() - this.lastHostileTick > 45) {
                this.stage = "destroy";
            } else {
                // Continue patrolling, use normal Move to avoid crowding
                squadUnits.forEach((u) => {
                    // Assign slightly different patrol positions to each unit
                    const jitter = new Vector2(
                        gameApi.generateRandomInt(-2, 2),
                        gameApi.generateRandomInt(-2, 2)
                    );
                    const dest = this.targetPos.add(jitter);
                    this.pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.Move, dest);
                });
                return noop();
            }
        }

        // --- DESTROY ---
        const visibleShipyards = gameApi
            .getVisibleUnits(playerData.name, "enemy", (r) => r.name === "GAYARD" || r.name === "NAYARD")
            .map((id) => gameApi.getUnitData(id))
            .filter((u): u is NonNullable<typeof u> => !!u);

        // If new enemy naval units appear, prioritize killing them
        const enemyNavalDestroy = gameApi
            .getVisibleUnits(playerData.name, "enemy")
            .map((id) => gameApi.getUnitData(id))
            .filter((unit): unit is NonNullable<typeof unit> => {
                if (!unit) return false;
                const distance = new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(this.targetPos);
                return distance <= SIGHT_RADIUS && unit.rules.speedType === SpeedType.Float;
            });

        if (enemyNavalDestroy.length > 0) {
            squadUnits.forEach((u) => {
                // Find nearest enemy
                let closest = enemyNavalDestroy[0];
                let minDist = new Vector2(u.tile.rx, u.tile.ry).distanceTo(new Vector2(closest.tile.rx, closest.tile.ry));
                for (const e of enemyNavalDestroy) {
                    const d = new Vector2(u.tile.rx, u.tile.ry).distanceTo(new Vector2(e.tile.rx, e.tile.ry));
                    if (d < minDist) {
                        closest = e;
                        minDist = d;
                    }
                }
                actionBatcher.push(BatchableAction.toTargetId(u.id, OrderType.Attack, closest.id));
            });
            return noop();
        }

        // Primary target: shipyard
        if (visibleShipyards.length > 0) {
            const target = visibleShipyards[0]!;

            // Check firing path for each unit, adjust position if necessary
            squadUnits.forEach((u) => {
                const unitPos = new Vector2(u.tile.rx, u.tile.ry);
                const clearLoS = this.hasClearWaterLoS(gameApi, unitPos, this.targetPos);
                if (clearLoS) {
                    actionBatcher.push(BatchableAction.toTargetId(u.id, OrderType.Attack, target.id));
                } else {
                    // Avoid too frequent repositioning
                    if (gameApi.getCurrentTick() - this.lastRepositionTick < 30) {
                        return;
                    }
                    const newPos = this.findWaterFiringPoint(gameApi, 5, 8);
                    if (newPos) {
                        this.pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.AttackMove, newPos);
                        this.lastRepositionTick = gameApi.getCurrentTick();
                    } else {
                        // Can't find suitable position, maintain AttackMove to shipyard
                        this.pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.AttackMove, this.targetPos);
                    }
                }
            });
        } else {
            squadUnits.forEach((u) => {
                this.pushToPointSafe(gameApi, actionBatcher, u.id, OrderType.AttackMove, this.targetPos);
            });
        }

        return noop();
    }
}

export class AntiShipyardMissionFactory implements MissionFactory {
    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        // Skip if already exists
        if (missionController.getMissions().some((m) => m instanceof AntiShipyardMission)) {
            return;
        }

        const enemyShipyards = gameApi.getVisibleUnits(playerData.name, "enemy", (r) =>
            r.name === "GAYARD" || r.name === "NAYARD",
        );
        if (enemyShipyards.length === 0) return;

        const shipyardData = gameApi.getUnitData(enemyShipyards[0]);
        if (!shipyardData) return;
        const targetPos = new Vector2(shipyardData.tile.rx, shipyardData.tile.ry);

        const wantSubs = playerData.country?.side === SideType.Nod; // nod = soviet -> sub

        const mission = new AntiShipyardMission(
            "antiShipyard_" + gameApi.getCurrentTick(),
            targetPos,
            wantSubs,
            logger,
        );
        missionController.addMission(mission);
    }

    getName(): string {
        return "AntiShipyardMissionFactory";
    }

    onMissionFailed(
        _gameApi: GameApi,
        _playerData: PlayerData,
        _matchAwareness: MatchAwareness,
        _failedMission: Mission<any>,
        _failureReason: any,
        _missionController: MissionController,
        _logger: DebugLogger,
    ): void {
        // no-op
    }
}
