import { ActionsApi, GameApi, OrderType, PlayerData, ProductionApi, Vector2, SpeedType } from "@chronodivide/game-api";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { AttackMission } from "./attackMission.js";
import { MissionController } from "../missionController.js";
import { DebugLogger } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { getDistanceBetweenTileAndPoint } from "../../map/map.js";
import { PrioritisedScoutTarget } from "../../common/scout.js";
import { isPointReachable } from "../../map/pathfinding.js";

const SCOUT_MOVE_COOLDOWN_TICKS = 30;

// Max units to spend on a particular scout target.
const MAX_ATTEMPTS_PER_TARGET = 3;

// Maximum ticks to spend trying to scout a target *without making progress towards it*.
// Every time a unit gets closer to the target, the timer refreshes.
const MAX_TICKS_PER_TARGET = 600;

/**
 * A mission that tries to scout around the map with a cheap, fast unit (usually attack dogs)
 */
export class ScoutingMission extends Mission {
    private scoutTarget: Vector2 | null = null;
    private attemptsOnCurrentTarget: number = 0;
    private scoutTargetRefreshedAt: number = 0;
    private lastMoveCommandTick: number = 0;
    private scoutTargetIsPermanent: boolean = false;

    // Minimum distance from a scout to the target.
    private scoutMinDistance?: number;

    private hadUnit: boolean = false;

    constructor(
        uniqueName: string,
        private priority: number,
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
        const scoutNames = ["ADOG", "DOG", "E1", "E2"];
        const scouts = this.getUnitsOfTypes(gameApi, ...scoutNames);

        if ((matchAwareness.getSectorCache().getOverallVisibility() || 0) > 0.9) {
            return disbandMission();
        }

        if (scouts.length === 0) {
            // Count the number of times the scout dies trying to uncover the current scoutTarget.
            if (this.scoutTarget && this.hadUnit) {
                this.attemptsOnCurrentTarget++;
                this.hadUnit = false;
            }
            return requestUnits(scoutNames, this.priority);
        } else if (this.scoutTarget) {
            this.hadUnit = true;
            if (!this.scoutTargetIsPermanent) {
                if (this.attemptsOnCurrentTarget > MAX_ATTEMPTS_PER_TARGET) {
                    this.logger(
                        `Scout target ${this.scoutTarget.x},${this.scoutTarget.y} took too many attempts, moving to next`,
                    );
                    this.setScoutTarget(null, 0);
                    return noop();
                }
                
                // Check if target is reachable before applying time limit
                let shouldApplyTimeLimit = true;
                if (scouts.length > 0) {
                    // Use the first scout's position to check reachability
                    const scoutPosition = new Vector2(scouts[0].tile.rx, scouts[0].tile.ry);
                    const targetReachable = isPointReachable(
                        gameApi,
                        scoutPosition,
                        this.scoutTarget,
                        SpeedType.Track,
                        5, // maxAllowedError = 5 as requested
                        false
                    );
                    
                    if (targetReachable) {
                        shouldApplyTimeLimit = false;
                        this.logger(
                            `Scout target ${this.scoutTarget.x},${this.scoutTarget.y} is reachable, skipping time limit`
                        );
                    }
                }
                
                if (shouldApplyTimeLimit && gameApi.getCurrentTick() > this.scoutTargetRefreshedAt + MAX_TICKS_PER_TARGET) {
                    this.logger(
                        `Scout target ${this.scoutTarget.x},${this.scoutTarget.y} took too long, moving to next`,
                    );
                    this.setScoutTarget(null, 0);
                    return noop();
                }
            }
            const targetTile = gameApi.mapApi.getTile(this.scoutTarget.x, this.scoutTarget.y);
            if (!targetTile) {
                throw new Error(`target tile ${this.scoutTarget.x},${this.scoutTarget.y} does not exist`);
            }
            if (gameApi.getCurrentTick() > this.lastMoveCommandTick + SCOUT_MOVE_COOLDOWN_TICKS) {
                this.lastMoveCommandTick = gameApi.getCurrentTick();
                scouts.forEach((unit) => {
                    if (this.scoutTarget) {
                        actionsApi.orderUnits([unit.id], OrderType.AttackMove, this.scoutTarget.x, this.scoutTarget.y);
                    }
                });
                // Check that a scout is actually moving closer to the target.
                const distances = scouts.map((unit) => getDistanceBetweenTileAndPoint(unit.tile, this.scoutTarget!));
                const newMinDistance = Math.min(...distances);
                if (!this.scoutMinDistance || newMinDistance < this.scoutMinDistance) {
                    this.logger(
                        `Scout timeout refreshed because unit moved closer to point (${newMinDistance} < ${this.scoutMinDistance})`,
                    );
                    this.scoutTargetRefreshedAt = gameApi.getCurrentTick();
                    this.scoutMinDistance = newMinDistance;
                }
            }
            if (gameApi.mapApi.isVisibleTile(targetTile, playerData.name)) {
                this.logger(
                    `Scout target ${this.scoutTarget.x},${this.scoutTarget.y} successfully scouted, moving to next`,
                );
                this.setScoutTarget(null, gameApi.getCurrentTick());
            }
        } else {
            const nextScoutTarget = matchAwareness.getScoutingManager().getNewScoutTarget();
            if (!nextScoutTarget) {
                this.logger(`No more scouting targets available, disbanding.`);
                return disbandMission();
            }
            this.setScoutTarget(nextScoutTarget, gameApi.getCurrentTick());
        }
        return noop();
    }

    setScoutTarget(target: PrioritisedScoutTarget | null, currentTick: number) {
        this.attemptsOnCurrentTarget = 0;
        this.scoutTargetRefreshedAt = currentTick;
        this.scoutTarget = target?.asVector2() ?? null;
        this.scoutMinDistance = undefined;
        this.scoutTargetIsPermanent = target?.isPermanent ?? false;
    }

    public getGlobalDebugText(): string | undefined {
        return "scouting";
    }

    public getPriority() {
        return this.priority;
    }
}

const SCOUT_COOLDOWN_TICKS = 300;

export class ScoutingMissionFactory implements MissionFactory {
    constructor(private lastScoutAt: number = -SCOUT_COOLDOWN_TICKS) {}

    getName(): string {
        return "ScoutingMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        if (gameApi.getCurrentTick() < this.lastScoutAt + SCOUT_COOLDOWN_TICKS) {
            return;
        }
        if (!matchAwareness.getScoutingManager().hasScoutTargets()) {
            return;
        }
        if (!missionController.addMission(new ScoutingMission("globalScout", 10, logger))) {
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
        if (gameApi.getCurrentTick() < this.lastScoutAt + SCOUT_COOLDOWN_TICKS) {
            return;
        }
        if (!matchAwareness.getScoutingManager().hasScoutTargets()) {
            return;
        }
        if (failedMission instanceof AttackMission) {
            missionController.addMission(new ScoutingMission("globalScout", 10, logger));
            this.lastScoutAt = gameApi.getCurrentTick();
        }
    }
}
