import { ActionsApi, GameApi, OrderType, PlayerData, Vector2, SpeedType, LandType } from "@chronodivide/game-api";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { MissionController } from "../missionController.js";
import { DebugLogger } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { PrioritisedScoutTarget } from "../../common/scout.js";
import { determineMapBounds } from "../../map/map.js";
import { EventBus } from "../../common/eventBus.js";

const NAVAL_SCOUT_MOVE_COOLDOWN_TICKS = 30;
const MAX_ATTEMPTS_PER_TARGET = 5;
const MAX_TICKS_PER_TARGET = 600;
const POSITION_CHECK_INTERVAL = 60; // Interval for checking if unit has stopped moving
const STUCK_THRESHOLD = 2; // Threshold for determining stopped movement (2x2 area)

// Get all water points on the map
function getAllWaterPoints(gameApi: GameApi, sectorSize: number = 8): Vector2[] {
    const waterPoints: Vector2[] = [];
    const mapBounds = determineMapBounds(gameApi.mapApi);
    
    // Ensure not exceeding map boundaries
    for (let x = 0; x < mapBounds.width; x += sectorSize) {
        for (let y = 0; y < mapBounds.height; y += sectorSize) {
            // Check if current point is within map bounds
            if (x >= 0 && x < mapBounds.width && y >= 0 && y < mapBounds.height) {
                const tile = gameApi.mapApi.getTile(x, y);
                if (tile && tile.landType === LandType.Water) {
                    // Ensure this water point is passable
                    const path = gameApi.mapApi.findPath(
                        SpeedType.Float,
                        true,
                        { tile: tile, onBridge: false },
                        { tile: tile, onBridge: false }
                    );
                    if (path) {
                        waterPoints.push(new Vector2(x, y));
                    }
                }
            }
        }
    }

    if (waterPoints.length === 0) {
        // If no water points found, may need to use smaller sampling interval
        if (sectorSize > 2) {
            return getAllWaterPoints(gameApi, Math.floor(sectorSize / 2));
        }
    }

    return waterPoints;
}

// Get final reachable water position
function getFinalReachablePoint(gameApi: GameApi, startPoint: Vector2, targetPoint: Vector2): Vector2 | null {
    const startTile = gameApi.mapApi.getTile(startPoint.x, startPoint.y);
    const targetTile = gameApi.mapApi.getTile(targetPoint.x, targetPoint.y);
    
    if (!startTile || !targetTile) {
        return null;
    }

    const path = gameApi.mapApi.findPath(
        SpeedType.Float,
        true,
        { tile: startTile, onBridge: false },
        { tile: targetTile, onBridge: false }
    );

    if (!path || path.length === 0) {
        return null;
    }

    const lastNode = path[path.length - 1];
    return new Vector2(lastNode.tile.rx, lastNode.tile.ry);
}

/**
 * Naval scouting mission, using naval units for map reconnaissance
 */
export class NavalScoutingMission extends Mission {
    private scoutTarget: Vector2 | null = null;
    private attemptsOnCurrentTarget: number = 0;
    private scoutTargetRefreshedAt: number = 0;
    private lastMoveCommandTick: number = 0;
    private scoutTargetIsPermanent: boolean = false;
    private hadUnit: boolean = false;
    private waterPoints: Vector2[] | null = null;
    private visitedWaterPoints: Set<string> = new Set();
    private lastPosition: Vector2 | null = null;
    private lastPositionCheckTick: number = 0;

    constructor(
        uniqueName: string,
        private priority: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    private initializeWaterPoints(gameApi: GameApi): void {
        if (this.waterPoints === null) {
            this.waterPoints = getAllWaterPoints(gameApi);
            // Randomly shuffle water point order to make exploration more random
            // for (let i = this.waterPoints.length - 1; i > 0; i--) {
            //     const j = Math.floor(gameApi.generateRandom() * (i + 1));
            //     [this.waterPoints[i], this.waterPoints[j]] = [this.waterPoints[j], this.waterPoints[i]];
            // }
            this.logger(`Found ${this.waterPoints.length} water exploration points`);
        }
    }

    private getNextWaterTarget(gameApi: GameApi, currentPosition: Vector2, matchAwareness: MatchAwareness): Vector2 | null {
        this.initializeWaterPoints(gameApi);
        if (!this.waterPoints || this.waterPoints.length === 0) {
            return null;
        }

        // Search for nearest unvisited and unexplored water point from current position
        let nearestPoint = null;
        let minDistance = Number.MAX_VALUE;
        const sectorCache = matchAwareness.getSectorCache();

        // Update explored points set
        const exploredPoints = new Set<string>();
        this.waterPoints.forEach(point => {
            const sector = sectorCache.getSectorForWorldPosition(point.x, point.y);
            if (sector && sector.sectorVisibilityPct !== undefined && sector.sectorVisibilityPct > 0) {
                exploredPoints.add(`${point.x},${point.y}`);
            }
        });

        // If all points visited but there are still unexplored points, reset visit records
        if (this.visitedWaterPoints.size >= this.waterPoints.length) {
            this.visitedWaterPoints = exploredPoints;
        }

        for (let i = 0; i < this.waterPoints.length; i++) {
            const target = this.waterPoints[i];
            const pointKey = `${target.x},${target.y}`;
            
            // Skip already visited points
            if (this.visitedWaterPoints.has(pointKey)) {
                continue;
            }

            // Skip already explored points
            if (exploredPoints.has(pointKey)) {
                this.visitedWaterPoints.add(pointKey);
                continue;
            }

            const distance = currentPosition.distanceTo(target);
            if (distance < minDistance) {
                const finalPoint = getFinalReachablePoint(gameApi, currentPosition, target);
                if (finalPoint) {
                    nearestPoint = target;
                    minDistance = distance;
                }
            }
        }

        if (nearestPoint) {
            const pointKey = `${nearestPoint.x},${nearestPoint.y}`;
            this.visitedWaterPoints.add(pointKey);
            this.logger(`Selected new water exploration point ${nearestPoint.x},${nearestPoint.y}`);
        } else if (this.visitedWaterPoints.size < this.waterPoints.length) {
            this.logger("Re-explore undiscovered areas");
        }

        return nearestPoint;
    }

    private isUnitStuck(currentPosition: Vector2): boolean {
        if (!this.lastPosition) {
            return false;
        }
        const dx = Math.abs(currentPosition.x - this.lastPosition.x);
        const dy = Math.abs(currentPosition.y - this.lastPosition.y);
        return dx <= STUCK_THRESHOLD && dy <= STUCK_THRESHOLD;
    }

    public _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const scoutNames = ["DLPH", "DEST", "SUB", "HYD", "SQD"];
        const scouts = this.getUnitsOfTypes(gameApi, ...scoutNames);

        if ((matchAwareness.getSectorCache().getOverallVisibility() || 0) > 0.9) {
            return disbandMission();
        }

        if (scouts.length === 0) {
            if (this.scoutTarget && this.hadUnit) {
                this.attemptsOnCurrentTarget++;
                this.hadUnit = false;
            }
            return requestUnits(scoutNames, this.priority);
        }

        const currentScout = scouts[0];
        const currentPosition = new Vector2(currentScout.tile.rx, currentScout.tile.ry);

        // Check if unit has stopped moving
        if (gameApi.getCurrentTick() >= this.lastPositionCheckTick + POSITION_CHECK_INTERVAL) {
            if (this.lastPosition && this.isUnitStuck(currentPosition)) {
                this.logger(`Unit stopped moving at ${currentPosition.x},${currentPosition.y}, searching for new target`);
                this.setScoutTarget(null, gameApi.getCurrentTick());
            }
            this.lastPosition = currentPosition;
            this.lastPositionCheckTick = gameApi.getCurrentTick();
        }

        if (this.scoutTarget) {
            this.hadUnit = true;

            if (!this.scoutTargetIsPermanent) {
                if (this.attemptsOnCurrentTarget > MAX_ATTEMPTS_PER_TARGET) {
                    this.logger(`Scout target ${this.scoutTarget.x},${this.scoutTarget.y} attempted too many times, switching to next target`);
                    this.setScoutTarget(null, 0);
                    return noop();
                }
                if (gameApi.getCurrentTick() > this.scoutTargetRefreshedAt + MAX_TICKS_PER_TARGET) {
                    this.logger(`Scout target ${this.scoutTarget.x},${this.scoutTarget.y} taking too long, switching to next target`);
                    this.setScoutTarget(null, 0);
                    return noop();
                }
            }

            const targetTile = gameApi.mapApi.getTile(this.scoutTarget.x, this.scoutTarget.y);
            if (!targetTile) {
                throw new Error(`Target position ${this.scoutTarget.x},${this.scoutTarget.y} does not exist`);
            }

            if (gameApi.getCurrentTick() > this.lastMoveCommandTick + NAVAL_SCOUT_MOVE_COOLDOWN_TICKS) {
                this.lastMoveCommandTick = gameApi.getCurrentTick();
                scouts.forEach((unit) => {
                    if (this.scoutTarget) {
                        actionsApi.orderUnits([unit.id], OrderType.Move, this.scoutTarget.x, this.scoutTarget.y);
                    }
                });
            }

            if (gameApi.mapApi.isVisibleTile(targetTile, playerData.name)) {
                const pointKey = `${this.scoutTarget.x},${this.scoutTarget.y}`;
                this.visitedWaterPoints.add(pointKey);
                this.logger(`Target ${this.scoutTarget.x},${this.scoutTarget.y} scouted successfully, switching to next target`);
                this.setScoutTarget(null, gameApi.getCurrentTick());
            }
        } else {
            // Get new scout target
            const nextScoutTarget = matchAwareness.getScoutingManager().getNewScoutTarget();
            if (nextScoutTarget) {
                const targetPoint = nextScoutTarget.asVector2();
                if (targetPoint) {
                    // Directly get final reachable point
                    const finalPoint = getFinalReachablePoint(gameApi, currentPosition, targetPoint);
                    if (finalPoint) {
                        this.setScoutTarget(finalPoint, gameApi.getCurrentTick());
                        this.logger(`Heading to scout target ${finalPoint.x},${finalPoint.y}`);
                        return noop();
                    }
                }
            }

            // If no scout targets available, choose nearest water point
            const nextWaterTarget = this.getNextWaterTarget(gameApi, currentPosition, matchAwareness);
            if (nextWaterTarget) {
                this.setScoutTarget(nextWaterTarget, gameApi.getCurrentTick());
            } else {
                this.logger(`No reachable water exploration points found, mission ends`);
                return disbandMission();
            }
        }
        return noop();
    }

    setScoutTarget(target: Vector2 | null, currentTick: number) {
        this.attemptsOnCurrentTarget = 0;
        this.scoutTargetRefreshedAt = currentTick;
        this.scoutTarget = target;
        this.scoutTargetIsPermanent = false;
        // Reset position check
        this.lastPosition = null;
        this.lastPositionCheckTick = currentTick;
    }

    public getGlobalDebugText(): string | undefined {
        return "Naval scouting in progress";
    }

    public getPriority() {
        return this.priority;
    }
}

export class NavalScoutingMissionFactory implements MissionFactory {
    private navalMode: boolean = false;

    constructor(private lastScoutAt: number = -300, private eventBus?: EventBus) {
        if (this.eventBus) {
            this.eventBus.subscribe((ev) => {
                if (ev.type === "modeChanged") {
                    this.navalMode = ev.isNaval;
                }
            });
        }
    }

    getName(): string {
        return "NavalScoutingMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        // Only create naval scouting missions if in naval mode
        if (!this.navalMode) {
            return;
        }
        
        // Check every 300 ticks whether to create new naval scouting mission
        if (gameApi.getCurrentTick() < this.lastScoutAt + 300) {
            return;
        }
        if (!matchAwareness.getScoutingManager().hasScoutTargets()) {
            return;
        }
        if (!missionController.addMission(new NavalScoutingMission("navalScout", 10, logger))) {
            this.lastScoutAt = gameApi.getCurrentTick();
        }
    }

    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission<any>,
        failureReason: undefined,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        // Only recreate naval scouting missions if in naval mode
        if (!this.navalMode) {
            return;
        }
        
        if (gameApi.getCurrentTick() < this.lastScoutAt + 300) {
            return;
        }
        if (!matchAwareness.getScoutingManager().hasScoutTargets()) {
            return;
        }
        if (failedMission instanceof NavalScoutingMission) {
            missionController.addMission(new NavalScoutingMission("navalScout", 10, logger));
            this.lastScoutAt = gameApi.getCurrentTick();
        }
    }
} 