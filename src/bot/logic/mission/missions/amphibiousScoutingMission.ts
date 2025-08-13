import { ActionsApi, GameApi, OrderType, PlayerData, Vector2, SpeedType, LandType } from "@chronodivide/game-api";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { MissionController } from "../missionController.js";
import { DebugLogger } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { PrioritisedScoutTarget } from "../../common/scout.js";
import { determineMapBounds, getDistanceBetweenTileAndPoint } from "../../map/map.js";

const AMPHIBIOUS_SCOUT_MOVE_COOLDOWN_TICKS = 30;
const MAX_ATTEMPTS_PER_TARGET = 5;
const MAX_TICKS_PER_TARGET = 600;
const POSITION_CHECK_INTERVAL = 60;
const STUCK_THRESHOLD = 2;

// Get all passable points on the map (including water and land)
function getAllAmphibiousPoints(gameApi: GameApi, sectorSize: number = 8): Vector2[] {
    const amphibiousPoints: Vector2[] = [];
    const mapBounds = determineMapBounds(gameApi.mapApi);
    
    for (let x = 0; x < mapBounds.width; x += sectorSize) {
        for (let y = 0; y < mapBounds.height; y += sectorSize) {
            if (x >= 0 && x < mapBounds.width && y >= 0 && y < mapBounds.height) {
                const tile = gameApi.mapApi.getTile(x, y);
                if (tile && gameApi.mapApi.isPassableTile(tile, SpeedType.Amphibious, false, false)) {
                    amphibiousPoints.push(new Vector2(x, y));
                }
            }
        }
    }

    if (amphibiousPoints.length === 0 && sectorSize > 2) {
        return getAllAmphibiousPoints(gameApi, Math.floor(sectorSize / 2));
    }

    return amphibiousPoints;
}

/**
 * Amphibious scouting mission, using amphibious units to scout the map
 */
export class AmphibiousScoutingMission extends Mission {
    private scoutTarget: Vector2 | null = null;
    private attemptsOnCurrentTarget: number = 0;
    private scoutTargetRefreshedAt: number = 0;
    private lastMoveCommandTick: number = 0;
    private scoutTargetIsPermanent: boolean = false;
    private hadUnit: boolean = false;
    private amphibiousPoints: Vector2[] | null = null;
    private visitedPoints: Set<string> = new Set();
    private lastPosition: Vector2 | null = null;
    private lastPositionCheckTick: number = 0;
    private scoutMinDistance?: number;

    constructor(
        uniqueName: string,
        private priority: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    private initializeAmphibiousPoints(gameApi: GameApi): void {
        if (this.amphibiousPoints === null) {
            this.amphibiousPoints = getAllAmphibiousPoints(gameApi);
            // Randomly shuffle the exploration points order
            for (let i = this.amphibiousPoints.length - 1; i > 0; i--) {
                const j = Math.floor(gameApi.generateRandomInt(0, i));
                [this.amphibiousPoints[i], this.amphibiousPoints[j]] = [this.amphibiousPoints[j], this.amphibiousPoints[i]];
            }
            this.logger(`Found ${this.amphibiousPoints.length} amphibious exploration points`);
        }
    }

    private isUnitStuck(currentPosition: Vector2): boolean {
        if (!this.lastPosition) return false;
        const dx = Math.abs(currentPosition.x - this.lastPosition.x);
        const dy = Math.abs(currentPosition.y - this.lastPosition.y);
        return dx <= STUCK_THRESHOLD && dy <= STUCK_THRESHOLD;
    }

    private getNextAmphibiousTarget(gameApi: GameApi, currentPosition: Vector2, playerData: PlayerData): Vector2 | null {
        this.initializeAmphibiousPoints(gameApi);
        if (!this.amphibiousPoints || this.amphibiousPoints.length === 0) return null;

        // Find the nearest unvisited point
        let bestPoint = null;
        let bestDistance = Infinity;

        for (const point of this.amphibiousPoints) {
            const pointKey = `${point.x},${point.y}`;
            if (this.visitedPoints.has(pointKey)) continue;

            const tile = gameApi.mapApi.getTile(point.x, point.y);
            if (!tile || gameApi.mapApi.isVisibleTile(tile, playerData.name)) {
                this.visitedPoints.add(pointKey);
                continue;
            }

            const distance = getDistanceBetweenTileAndPoint(tile, currentPosition);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestPoint = point;
            }
        }

        return bestPoint;
    }

    public _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const scoutNames = ["SAPC", "LCRF"]; // Amphibious units
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
                this.logger(`Unit stuck at ${currentPosition.x},${currentPosition.y}, looking for new target`);
                this.setScoutTarget(null, gameApi.getCurrentTick());
            }
            this.lastPosition = currentPosition;
            this.lastPositionCheckTick = gameApi.getCurrentTick();
        }

        if (this.scoutTarget) {
            this.hadUnit = true;

            if (!this.scoutTargetIsPermanent) {
                if (this.attemptsOnCurrentTarget > MAX_ATTEMPTS_PER_TARGET) {
                    this.logger(`Scout target ${this.scoutTarget.x},${this.scoutTarget.y} exceeded max attempts, switching to next target`);
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

            if (gameApi.getCurrentTick() > this.lastMoveCommandTick + AMPHIBIOUS_SCOUT_MOVE_COOLDOWN_TICKS) {
                this.lastMoveCommandTick = gameApi.getCurrentTick();
                scouts.forEach((unit) => {
                    if (this.scoutTarget) {
                        actionsApi.orderUnits([unit.id], OrderType.AttackMove, this.scoutTarget.x, this.scoutTarget.y);
                    }
                });

                // Check if unit is approaching target
                const distances = scouts.map((unit) => getDistanceBetweenTileAndPoint(unit.tile, this.scoutTarget!));
                const newMinDistance = Math.min(...distances);
                if (!this.scoutMinDistance || newMinDistance < this.scoutMinDistance) {
                    this.logger(`Unit approaching target point (${newMinDistance} < ${this.scoutMinDistance})`);
                    this.scoutTargetRefreshedAt = gameApi.getCurrentTick();
                    this.scoutMinDistance = newMinDistance;
                }
            }

            if (gameApi.mapApi.isVisibleTile(targetTile, playerData.name)) {
                const pointKey = `${this.scoutTarget.x},${this.scoutTarget.y}`;
                this.visitedPoints.add(pointKey);
                this.logger(`Target ${this.scoutTarget.x},${this.scoutTarget.y} scouted successfully, switching to next target`);
                this.setScoutTarget(null, gameApi.getCurrentTick());
            }
        } else {
            // Get new scout target
            const nextScoutTarget = matchAwareness.getScoutingManager().getNewScoutTarget();
            if (nextScoutTarget) {
                this.setScoutTarget(nextScoutTarget.asVector2(), gameApi.getCurrentTick());
                return noop();
            }

            // If no available scout targets, choose nearby amphibious points
            const nextAmphibiousTarget = this.getNextAmphibiousTarget(gameApi, currentPosition, playerData);
            if (nextAmphibiousTarget) {
                this.setScoutTarget(nextAmphibiousTarget, gameApi.getCurrentTick());
            } else {
                this.logger(`No reachable amphibious exploration points found, mission ended`);
                return disbandMission();
            }
        }
        return noop();
    }

    setScoutTarget(target: Vector2 | null, currentTick: number) {
        this.attemptsOnCurrentTarget = 0;
        this.scoutTargetRefreshedAt = currentTick;
        this.scoutTarget = target;
        this.scoutMinDistance = undefined;
        this.scoutTargetIsPermanent = false;
        this.lastPosition = null;
        this.lastPositionCheckTick = currentTick;
    }

    public getGlobalDebugText(): string | undefined {
        return "Amphibious scouting";
    }

    public getPriority() {
        return this.priority;
    }
}

export class AmphibiousScoutingMissionFactory implements MissionFactory {
    constructor(private lastScoutAt: number = -300) {}

    getName(): string {
        return "AmphibiousScoutingMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        if (gameApi.getCurrentTick() < this.lastScoutAt + 300) {
            return;
        }
        if (!matchAwareness.getScoutingManager().hasScoutTargets()) {
            return;
        }
        if (!missionController.addMission(new AmphibiousScoutingMission("amphibiousScout", 10, logger))) {
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
        if (gameApi.getCurrentTick() < this.lastScoutAt + 300) {
            return;
        }
        if (!matchAwareness.getScoutingManager().hasScoutTargets()) {
            return;
        }
        if (failedMission instanceof AmphibiousScoutingMission) {
            missionController.addMission(new AmphibiousScoutingMission("amphibiousScout", 10, logger));
            this.lastScoutAt = gameApi.getCurrentTick();
        }
    }
} 