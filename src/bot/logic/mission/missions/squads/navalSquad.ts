import { ActionsApi, GameApi, MovementZone, OrderType, PlayerData, StanceType, UnitData, Vector2, TerrainType } from "@chronodivide/game-api";
import { ActionBatcher, BatchableAction } from "../../actionBatcher.js";
import { MatchAwareness } from "../../../awareness.js";
import { Mission, MissionAction, noop } from "../../mission.js";
import { DebugLogger, isOwnedByNeutral } from "../../../common/utils.js";
import { Squad } from "./squad.js";
import { getDistanceBetweenUnits, getDistanceBetweenPoints } from "../../../map/map.js";
import { manageAttackMicro, manageMoveMicro } from "./common.js";

const TARGET_UPDATE_INTERVAL_TICKS = 15;
const GATHER_RATIO = 2;
const MIN_GATHER_RADIUS = 3;
const MAX_GATHER_RADIUS = 6;
const ATTACK_SCAN_AREA = 25;
const COMBAT_SUPPORT_RANGE = 20;
const STUCK_CHECK_INTERVAL = 60;
const STUCK_THRESHOLD = 3;
const STUCK_DISTANCE_THRESHOLD = 0.5;
const RETREAT_DISTANCE = 8;
const EXPLORATION_RANGE = 30;
const EXPLORATION_ANGLE_CHANGE = 45;
const EXPLORATION_INTERVAL_TICKS = 150;
const MAX_IDLE_COMBAT_TICKS = 150;
const PATHFINDING_WAIT_TICKS = 45;
const MAX_STUCK_ATTEMPTS = 3;
const WATER_SEARCH_RADIUS = 15;
const MIN_WATER_OPENNESS = 5;
const PREFER_OPEN_WATER_WEIGHT = 2.0;
const MAJOR_BATTLE_SUPPORT_RANGE = 40;
const MIN_UNITS_FOR_MAJOR_BATTLE = 3;
const BUILDING_ATTACK_PRIORITY = 0.8;
const SUPPORT_ATTACK_RANGE = 25;
const COMBAT_UNIT_PRIORITY = 2.0;
const LOW_HEALTH_PRIORITY = 1.5;
const NAVAL_UNIT_PRIORITY = 1.8;
const NEARBY_TARGET_BONUS = 1.3;
const NAVAL_YARD_PRIORITY = 2.0;
const NAVAL_YARD_SCAN_RANGE = 40;

enum SquadState {
    Gathering,
    Attacking,
    Retreating,
    Exploring,
}

interface UnitPosition {
    x: number;
    y: number;
    timestamp: number;
}

interface CombatState {
    lastEngageTime: number;
    lastTargetId?: number;
    lastPosition?: Vector2;
}

interface StuckState {
    attempts: number;
    lastAttemptTime: number;
    lastPosition: Vector2;
}

interface WaterAreaScore {
    position: Vector2;
    openness: number;
    distanceScore: number;
    totalScore: number;
}

interface BattleInfo {
    position: Vector2;
    unitCount: number;
    hasBuildings: boolean;
    targets: UnitData[];
}

export class NavalSquad implements Squad {
    private lastCommand: number = 0;
    private state: SquadState = SquadState.Gathering;
    private targetArea: Vector2 | undefined;
    private debugLastTarget: string = "";
    private lastOrderGiven: Record<number, BatchableAction> = {};
    private unitPositionHistory: Map<number, UnitPosition[]> = new Map();
    private lastStuckCheck: number = 0;
    private retreatStartTime: Map<number, number> = new Map();
    private lastExplorationChange: number = 0;
    private currentExplorationAngle: number = 0;
    private unitCombatStates: Map<number, CombatState> = new Map();
    private stuckStates: Map<number, StuckState> = new Map();
    private lastPathfindingTime: Map<number, number> = new Map();

    constructor(targetArea?: Vector2) {
        this.targetArea = targetArea;
    }

    private isUnitStuck(unit: UnitData, currentTick: number): boolean {
        const history = this.unitPositionHistory.get(unit.id);
        if (!history || history.length < STUCK_THRESHOLD) {
            return false;
        }

        const recentPositions = history.slice(-STUCK_THRESHOLD);
        for (let i = 1; i < recentPositions.length; i++) {
            const pos1 = new Vector2(recentPositions[i].x, recentPositions[i].y);
            const pos2 = new Vector2(recentPositions[i - 1].x, recentPositions[i - 1].y);
            const distance = getDistanceBetweenPoints(pos1, pos2);
            if (distance > STUCK_DISTANCE_THRESHOLD) {
                return false;
            }
        }

        return true;
    }

    private updateUnitPosition(unit: UnitData, currentTick: number) {
        if (!this.unitPositionHistory.has(unit.id)) {
            this.unitPositionHistory.set(unit.id, []);
        }
        const history = this.unitPositionHistory.get(unit.id)!;
        history.push({
            x: unit.tile.rx,
            y: unit.tile.ry,
            timestamp: currentTick
        });

        while (history.length > STUCK_THRESHOLD) {
            history.shift();
        }
    }

    private handleStuckUnit(unit: UnitData, currentTick: number, actionBatcher: ActionBatcher, logger: DebugLogger, gameApi: GameApi) {
        let stuckState = this.stuckStates.get(unit.id);
        if (!stuckState) {
            stuckState = {
                attempts: 0,
                lastAttemptTime: currentTick,
                lastPosition: new Vector2(unit.tile.rx, unit.tile.ry)
            };
            this.stuckStates.set(unit.id, stuckState);
        }

        if (currentTick - stuckState.lastAttemptTime > STUCK_CHECK_INTERVAL * 2) {
            const currentPos = new Vector2(unit.tile.rx, unit.tile.ry);
            if (getDistanceBetweenPoints(currentPos, stuckState.lastPosition) < STUCK_DISTANCE_THRESHOLD) {
                stuckState.attempts++;
                logger(`海军单位 ${unit.id} 第 ${stuckState.attempts} 次尝试脱困`);
            }
            stuckState.lastAttemptTime = currentTick;
            stuckState.lastPosition = currentPos;
        }

        const shouldFindOpenWater = stuckState.attempts >= MAX_STUCK_ATTEMPTS;
        let retreatTarget = this.findValidWaterPosition(
            gameApi,
            new Vector2(unit.tile.rx, unit.tile.ry),
            new Vector2(unit.tile.rx, unit.tile.ry),
            shouldFindOpenWater
        );

        const direction = new Vector2(
            retreatTarget.x - unit.tile.rx,
            retreatTarget.y - unit.tile.ry
        );
        const length = Math.sqrt(direction.x * direction.x + direction.y * direction.y);
        if (length > 0) {
            const normalizedDir = new Vector2(
                direction.x / length,
                direction.y / length
            );
            retreatTarget = new Vector2(
                retreatTarget.x + normalizedDir.x * RETREAT_DISTANCE * (stuckState.attempts + 1),
                retreatTarget.y + normalizedDir.y * RETREAT_DISTANCE * (stuckState.attempts + 1)
            );
            retreatTarget = this.clampToMapBoundaries(gameApi, retreatTarget);
        }

        if (!this.isValidMapPosition(gameApi, retreatTarget)) {
            retreatTarget = this.findValidWaterPosition(gameApi, retreatTarget, new Vector2(unit.tile.rx, unit.tile.ry), true);
        }

        this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, retreatTarget));
        this.startPathfinding(unit, currentTick);
    }

    private isValidMapPosition(gameApi: GameApi, position: Vector2): boolean {
        const tile = gameApi.mapApi.getTile(Math.round(position.x), Math.round(position.y));
        return !!tile && tile.terrainType === TerrainType.Water;
    }

    private clampToMapBoundaries(gameApi: GameApi, position: Vector2): Vector2 {
        const mapSize = gameApi.mapApi.getRealMapSize();
        
        const x = Math.max(1, Math.min(Math.round(position.x), mapSize.width - 2));
        const y = Math.max(1, Math.min(Math.round(position.y), mapSize.height - 2));
        
        return new Vector2(x, y);
    }

    private evaluateWaterArea(gameApi: GameApi, position: Vector2): number {
        let openness = 0;
        const checkRadius = 3;

        for (let dx = -checkRadius; dx <= checkRadius; dx++) {
            for (let dy = -checkRadius; dy <= checkRadius; dy++) {
                if (dx === 0 && dy === 0) continue;
                
                const checkPos = this.clampToMapBoundaries(gameApi, 
                    new Vector2(position.x + dx, position.y + dy));
                const tile = gameApi.mapApi.getTile(checkPos.x, checkPos.y);
                
                if (tile && tile.terrainType === TerrainType.Water) {
                    const distance = Math.sqrt(dx * dx + dy * dy);
                    openness += 1 / (distance + 0.5);
                }
            }
        }

        return openness;
    }

    private findBestWaterPosition(gameApi: GameApi, currentPos: Vector2, targetPos: Vector2, preferOpenWater: boolean = true): Vector2 {
        const searchRadius = WATER_SEARCH_RADIUS;
        const waterPositions: WaterAreaScore[] = [];

        for (let r = 1; r <= searchRadius; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    const checkPos = this.clampToMapBoundaries(gameApi, 
                        new Vector2(currentPos.x + dx, currentPos.y + dy));
                    
                    if (!this.isValidMapPosition(gameApi, checkPos)) {
                        continue;
                    }

                    const openness = this.evaluateWaterArea(gameApi, checkPos);
                    if (openness < MIN_WATER_OPENNESS && preferOpenWater) {
                        continue;
                    }

                    const distanceToTarget = getDistanceBetweenPoints(checkPos, targetPos);
                    const distanceScore = 1 - (distanceToTarget / (searchRadius * 2));
                    
                    const totalScore = preferOpenWater ? 
                        (openness * PREFER_OPEN_WATER_WEIGHT + distanceScore) :
                        (openness + distanceScore * 2);

                    waterPositions.push({
                        position: checkPos,
                        openness,
                        distanceScore,
                        totalScore
                    });
                }
            }
        }

        if (waterPositions.length === 0 && preferOpenWater) {
            return this.findBestWaterPosition(gameApi, currentPos, targetPos, false);
        }

        waterPositions.sort((a, b) => b.totalScore - a.totalScore);
        return waterPositions[0]?.position || currentPos;
    }

    private findValidWaterPosition(gameApi: GameApi, target: Vector2, currentPos: Vector2, avoidDeadEnds: boolean = false): Vector2 {
        target = this.clampToMapBoundaries(gameApi, target);
        currentPos = this.clampToMapBoundaries(gameApi, currentPos);

        return this.findBestWaterPosition(gameApi, currentPos, target, avoidDeadEnds);
    }

    private updateExplorationTarget(gameApi: GameApi, unit: UnitData): Vector2 {
        const currentTick = gameApi.getCurrentTick();
        
        if (currentTick > this.lastExplorationChange + EXPLORATION_INTERVAL_TICKS) {
            this.currentExplorationAngle += EXPLORATION_ANGLE_CHANGE * (1 + Math.random());
            if (this.currentExplorationAngle >= 360) {
                this.currentExplorationAngle = 0;
            }
            this.lastExplorationChange = currentTick;
        }

        const angleInRadians = this.currentExplorationAngle * Math.PI / 180;
        const explorationDistance = EXPLORATION_RANGE * (0.8 + Math.random() * 0.4);
        const rawTarget = new Vector2(
            unit.tile.rx + Math.cos(angleInRadians) * explorationDistance,
            unit.tile.ry + Math.sin(angleInRadians) * explorationDistance
        );

        return this.findValidWaterPosition(gameApi, rawTarget, new Vector2(unit.tile.rx, unit.tile.ry), true);
    }

    private getFormationOffset(index: number, totalUnits: number): Vector2 {
        const radius = Math.min(3, Math.max(1, totalUnits / 3));
        const angle = (index * 2 * Math.PI) / totalUnits;
        return new Vector2(
            Math.cos(angle) * radius,
            Math.sin(angle) * radius
        );
    }

    private moveUnitsInFormation(units: UnitData[], targetPoint: Vector2, actionBatcher: ActionBatcher, currentTick: number, gameApi: GameApi) {
        const targetOpenness = this.evaluateWaterArea(gameApi, targetPoint);
        if (targetOpenness < MIN_WATER_OPENNESS) {
            targetPoint = this.findBestWaterPosition(gameApi, targetPoint, targetPoint, true);
        }

        targetPoint = this.clampToMapBoundaries(gameApi, targetPoint);
        
        units.forEach((unit, index) => {
            if (this.isPathfindingInProgress(unit, currentTick)) {
                return;
            }

            const offset = this.getFormationOffset(index, units.length);
            let unitTarget = new Vector2(
                targetPoint.x + offset.x,
                targetPoint.y + offset.y
            );
            
            unitTarget = this.clampToMapBoundaries(gameApi, unitTarget);
            if (!this.isValidMapPosition(gameApi, unitTarget)) {
                unitTarget = this.findBestWaterPosition(gameApi, unitTarget, targetPoint, true);
            }

            this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, unitTarget));
            this.startPathfinding(unit, currentTick);
        });
    }

    private updateCombatState(unit: UnitData, currentTick: number, hasTarget: boolean) {
        let state = this.unitCombatStates.get(unit.id);
        if (!state) {
            state = { lastEngageTime: currentTick };
            this.unitCombatStates.set(unit.id, state);
        }
        
        if (hasTarget) {
            state.lastEngageTime = currentTick;
        }
        
        state.lastPosition = new Vector2(unit.tile.rx, unit.tile.ry);
    }

    private findNearestEngagedAlly(unit: UnitData, units: UnitData[], currentTick: number): UnitData | null {
        let nearestAlly: UnitData | null = null;
        let minDistance = Number.MAX_VALUE;

        for (const ally of units) {
            if (ally.id === unit.id) continue;

            const allyState = this.unitCombatStates.get(ally.id);
            if (!allyState) continue;

            const isActivelyEngaged = currentTick - allyState.lastEngageTime < MAX_IDLE_COMBAT_TICKS;
            if (!isActivelyEngaged) continue;

            const distance = getDistanceBetweenUnits(unit, ally);
            if (distance < minDistance) {
                minDistance = distance;
                nearestAlly = ally;
            }
        }

        return nearestAlly;
    }

    private findMajorBattles(
        gameApi: GameApi,
        matchAwareness: MatchAwareness,
        units: UnitData[],
        currentTick: number
    ): BattleInfo[] {
        const battles: Map<string, BattleInfo> = new Map();

        for (const unit of units) {
            const nearbyHostiles = matchAwareness
                .getHostilesNearPoint(unit.tile.rx, unit.tile.ry, ATTACK_SCAN_AREA)
                .map(({ unitId }) => gameApi.getUnitData(unitId))
                .filter((target): target is UnitData => 
                    !!target && 
                    !isOwnedByNeutral(target)
                );

            if (nearbyHostiles.length > 0) {
                const centerX = nearbyHostiles.reduce((sum, target) => sum + target.tile.rx, 0) / nearbyHostiles.length;
                const centerY = nearbyHostiles.reduce((sum, target) => sum + target.tile.ry, 0) / nearbyHostiles.length;
                const battleKey = `${Math.round(centerX)},${Math.round(centerY)}`;

                const hasBuildings = nearbyHostiles.some(target => !target.rules.isSelectableCombatant);
                
                if (!battles.has(battleKey)) {
                    battles.set(battleKey, {
                        position: new Vector2(centerX, centerY),
                        unitCount: 1,
                        hasBuildings,
                        targets: nearbyHostiles
                    });
                } else {
                    const battle = battles.get(battleKey)!;
                    battle.unitCount++;
                    battle.hasBuildings = battle.hasBuildings || hasBuildings;
                    const existingIds = new Set(battle.targets.map(t => t.id));
                    for (const target of nearbyHostiles) {
                        if (!existingIds.has(target.id)) {
                            battle.targets.push(target);
                        }
                    }
                }
            }
        }

        return Array.from(battles.values())
            .filter(battle => battle.unitCount >= MIN_UNITS_FOR_MAJOR_BATTLE || battle.hasBuildings);
    }

    private calculateTargetWeight(attacker: UnitData, target: UnitData, inMajorBattle: boolean): number {
        const distance = getDistanceBetweenUnits(attacker, target);
        const maxRange = attacker.primaryWeapon?.maxRange ?? attacker.secondaryWeapon?.maxRange ?? 5;
        
        let weight = 1.0;

        if (target.rules.isSelectableCombatant) {
            weight *= COMBAT_UNIT_PRIORITY;
            
            if (target.rules.movementZone === MovementZone.Water) {
                weight *= NAVAL_UNIT_PRIORITY;
            }
            if (target.rules.movementZone === MovementZone.AmphibiousDestroyer) {
                weight *= NAVAL_UNIT_PRIORITY * 0.8;
            }

            const healthPercentage = target.rules.strength > 0 ? target.rules.points / target.rules.strength : 1;
            weight *= (1 + (1 - healthPercentage) * LOW_HEALTH_PRIORITY);
        } else {
            weight *= BUILDING_ATTACK_PRIORITY;
            
            if (target.rules.name === "NAYARD") {
                weight *= NAVAL_YARD_PRIORITY;
            }
        }

        if (distance <= maxRange) {
            weight *= NEARBY_TARGET_BONUS;
        }

        weight *= (1 - distance / (maxRange * 2.5));

        return weight;
    }

    private findBestTarget(unit: UnitData, targets: UnitData[], inMajorBattle: boolean): UnitData | null {
        const combatTargets = targets.filter(t => t.rules.isSelectableCombatant);
        const buildingTargets = targets.filter(t => !t.rules.isSelectableCombatant);

        const allTargetsWithWeights = [...combatTargets, ...buildingTargets].map(target => ({
            target,
            weight: this.calculateTargetWeight(unit, target, inMajorBattle)
        }));

        if (combatTargets.length > 0) {
            const bestCombatTarget = combatTargets.reduce((best, current) => {
                const currentWeight = this.calculateTargetWeight(unit, current, inMajorBattle);
                const bestWeight = best ? this.calculateTargetWeight(unit, best, inMajorBattle) : -1;
                return currentWeight > bestWeight ? current : best;
            }, null as UnitData | null);

            const nearbyBuilding = buildingTargets.find(building => {
                const distance = getDistanceBetweenUnits(unit, building);
                const maxRange = unit.primaryWeapon?.maxRange ?? unit.secondaryWeapon?.maxRange ?? 5;
                return distance <= maxRange && building.rules.name === "NAYARD";
            });

            if (nearbyBuilding && bestCombatTarget) {
                const combatDistance = getDistanceBetweenUnits(unit, bestCombatTarget);
                const buildingDistance = getDistanceBetweenUnits(unit, nearbyBuilding);
                const maxRange = unit.primaryWeapon?.maxRange ?? unit.secondaryWeapon?.maxRange ?? 5;
                
                if (buildingDistance <= maxRange && combatDistance > maxRange * 1.5) {
                    return nearbyBuilding;
                }
            }

            return bestCombatTarget;
        }

        return buildingTargets.reduce((best, current) => {
            const currentWeight = this.calculateTargetWeight(unit, current, inMajorBattle);
            const bestWeight = best ? this.calculateTargetWeight(unit, best, inMajorBattle) : -1;
            return currentWeight > bestWeight ? current : best;
        }, null as UnitData | null);
    }

    private findNearbyNavalYard(gameApi: GameApi, matchAwareness: MatchAwareness, position: Vector2): UnitData | null {
        const nearbyBuildings = matchAwareness
            .getHostilesNearPoint(position.x, position.y, NAVAL_YARD_SCAN_RANGE)
            .map(({ unitId }) => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => 
                !!unit && 
                !isOwnedByNeutral(unit) && 
                unit.rules.name === "NAYARD"
            );

        if (nearbyBuildings.length === 0) {
            return null;
        }

        return nearbyBuildings.reduce((nearest, current) => {
            const currentDistance = getDistanceBetweenPoints(
                position,
                new Vector2(current.tile.rx, current.tile.ry)
            );
            const nearestDistance = nearest ? getDistanceBetweenPoints(
                position,
                new Vector2(nearest.tile.rx, nearest.tile.ry)
            ) : Infinity;

            return currentDistance < nearestDistance ? current : nearest;
        });
    }

    private handleCombat(
        unit: UnitData,
        nearbyHostiles: UnitData[],
        units: UnitData[],
        currentTick: number,
        targetPoint: Vector2,
        actionBatcher: ActionBatcher,
        logger: DebugLogger,
        gameApi: GameApi,
        matchAwareness: MatchAwareness
    ) {
        const nearbyNavalYard = this.findNearbyNavalYard(gameApi, matchAwareness, new Vector2(unit.tile.rx, unit.tile.ry));
        
        if (nearbyNavalYard && nearbyHostiles.filter(h => h.rules.isSelectableCombatant).length === 0) {
            this.submitActionIfNew(actionBatcher, manageAttackMicro(unit, nearbyNavalYard));
            this.updateCombatState(unit, currentTick, true);
            logger(`Unit ${unit.id} 攻击敌方船厂`);
            return;
        }

        const majorBattles = this.findMajorBattles(gameApi, matchAwareness, units, currentTick);
        
        if (majorBattles.length > 0 && nearbyHostiles.length === 0) {
            const nearestBattle = majorBattles.reduce((nearest, battle) => {
                const distance = getDistanceBetweenPoints(
                    new Vector2(unit.tile.rx, unit.tile.ry),
                    battle.position
                );
                if (!nearest || distance < nearest.distance) {
                    return { battle, distance };
                }
                return nearest;
            }, null as { battle: BattleInfo; distance: number } | null);

            if (nearestBattle && nearestBattle.distance <= MAJOR_BATTLE_SUPPORT_RANGE) {
                const battle = nearestBattle.battle;
                logger(`Unit ${unit.id} 加入大规模战斗，距离: ${nearestBattle.distance.toFixed(1)}`);
                
                const bestTarget = this.findBestTarget(unit, battle.targets, true);
                if (bestTarget) {
                    this.submitActionIfNew(actionBatcher, manageAttackMicro(unit, bestTarget));
                    this.updateCombatState(unit, currentTick, true);
                    return;
                }
            }
        }

        const bestTarget = this.findBestTarget(unit, nearbyHostiles, false);
        if (bestTarget) {
            this.submitActionIfNew(actionBatcher, manageAttackMicro(unit, bestTarget));
            this.updateCombatState(unit, currentTick, true);
            this.debugLastTarget = `Unit ${bestTarget.id}`;
        } else {
            const nearestEngagedAlly = this.findNearestEngagedAlly(unit, units, currentTick);
            
            if (nearestEngagedAlly) {
                const supportPos = new Vector2(
                    nearestEngagedAlly.tile.rx,
                    nearestEngagedAlly.tile.ry
                );
                this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, supportPos));
                logger(`Unit ${unit.id} 支援移动到战友 ${nearestEngagedAlly.id} 位置`);
            } else {
                const state = this.unitCombatStates.get(unit.id);
                if (state && currentTick - state.lastEngageTime > MAX_IDLE_COMBAT_TICKS) {
                    const searchAngle = (unit.id % 360) * (Math.PI / 180);
                    const searchTarget = new Vector2(
                        unit.tile.rx + Math.cos(searchAngle) * SUPPORT_ATTACK_RANGE,
                        unit.tile.ry + Math.sin(searchAngle) * SUPPORT_ATTACK_RANGE
                    );
                    this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, searchTarget));
                    logger(`Unit ${unit.id} 主动搜索敌人`);
                } else {
                    const offset = this.getFormationOffset(units.indexOf(unit), units.length);
                    const unitTarget = new Vector2(
                        targetPoint.x + offset.x,
                        targetPoint.y + offset.y
                    );
                    this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, unitTarget));
                }
            }
            this.updateCombatState(unit, currentTick, false);
        }
    }

    public onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        actionBatcher: ActionBatcher,
        playerData: PlayerData,
        mission: Mission<any>,
        matchAwareness: MatchAwareness,
        logger: DebugLogger,
    ): MissionAction {
        const currentTick = gameApi.getCurrentTick();

        if (currentTick > this.lastStuckCheck + STUCK_CHECK_INTERVAL) {
            this.lastStuckCheck = currentTick;
            const units = mission.getUnitsMatchingByRule(gameApi, (r) => 
                r.isSelectableCombatant && 
                (r.movementZone === MovementZone.Water || r.movementZone === MovementZone.AmphibiousDestroyer)
            ).map(unitId => gameApi.getUnitData(unitId))
             .filter((unit): unit is UnitData => !!unit);

            for (const unit of units) {
                this.updateUnitPosition(unit, currentTick);
                if (this.isUnitStuck(unit, currentTick)) {
                    this.handleStuckUnit(unit, currentTick, actionBatcher, logger, gameApi);
                }
            }
        }

        if (
            mission.getUnitIds().length > 0 &&
            (!this.lastCommand || gameApi.getCurrentTick() > this.lastCommand + TARGET_UPDATE_INTERVAL_TICKS)
        ) {
            this.lastCommand = gameApi.getCurrentTick();
            const centerOfMass = mission.getCenterOfMass();
            const maxDistance = mission.getMaxDistanceToCenterOfMass();
            
            const unitIds = mission.getUnitsMatchingByRule(gameApi, (r) => 
                r.isSelectableCombatant && 
                (r.movementZone === MovementZone.Water || r.movementZone === MovementZone.AmphibiousDestroyer)
            );
            const units = unitIds
                .map((unitId) => gameApi.getUnitData(unitId))
                .filter((unit): unit is UnitData => !!unit);

            if (this.state === SquadState.Gathering) {
                const requiredGatherRadius = Math.sqrt(unitIds.length) * GATHER_RATIO + MIN_GATHER_RADIUS;
                if (
                    centerOfMass &&
                    maxDistance &&
                    gameApi.mapApi.getTile(centerOfMass.x, centerOfMass.y) !== undefined &&
                    maxDistance > requiredGatherRadius
                ) {
                    this.moveUnitsInFormation(units, centerOfMass, actionBatcher, currentTick, gameApi);
                } else {
                    logger(`NavalSquad ${mission.getUniqueName()} switching to attack mode (${maxDistance})`);
                    this.state = SquadState.Attacking;
                }
            } else if (this.state === SquadState.Attacking) {
                const targetPoint = this.targetArea || playerData.startLocation;
                const requiredGatherRadius = Math.sqrt(units.length) * GATHER_RATIO + MAX_GATHER_RADIUS;

                if (
                    centerOfMass &&
                    maxDistance &&
                    gameApi.mapApi.getTile(centerOfMass.x, centerOfMass.y) !== undefined &&
                    maxDistance > requiredGatherRadius
                ) {
                    logger(`NavalSquad ${mission.getUniqueName()} switching back to gather (${maxDistance})`);
                    this.state = SquadState.Gathering;
                    return noop();
                }

                const attackLeader = units.reduce((a, b) => 
                    (a.primaryWeapon?.maxRange ?? 5) < (b.primaryWeapon?.maxRange ?? 5) ? a : b
                );

                const nearbyHostiles = matchAwareness
                    .getHostilesNearPoint(attackLeader.tile.rx, attackLeader.tile.ry, ATTACK_SCAN_AREA)
                    .map(({ unitId }) => gameApi.getUnitData(unitId))
                    .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

                const onlyBuildingsLeft = nearbyHostiles.length > 0 && 
                    nearbyHostiles.every(unit => !unit.rules.isSelectableCombatant);

                if (nearbyHostiles.length === 0) {
                    const nearbyNavalYard = this.findNearbyNavalYard(
                        gameApi, 
                        matchAwareness, 
                        new Vector2(attackLeader.tile.rx, attackLeader.tile.ry)
                    );

                    if (nearbyNavalYard) {
                        const navalYardPos = new Vector2(nearbyNavalYard.tile.rx, nearbyNavalYard.tile.ry);
                        this.moveUnitsInFormation(units, navalYardPos, actionBatcher, currentTick, gameApi);
                        logger(`发现敌方船厂，全队前往攻击`);
                    } else {
                        this.moveUnitsInFormation(units, targetPoint, actionBatcher, currentTick, gameApi);
                    }
                } else if (onlyBuildingsLeft) {
                    const buildingTarget = nearbyHostiles[0];
                    const buildingPos = new Vector2(buildingTarget.tile.rx, buildingTarget.tile.ry);
                    this.moveUnitsInFormation(units, buildingPos, actionBatcher, currentTick, gameApi);
                    logger(`只剩建筑物，全队集中攻击`);
                } else {
                    for (const unit of units) {
                        this.handleCombat(
                            unit,
                            nearbyHostiles,
                            units,
                            currentTick,
                            targetPoint,
                            actionBatcher,
                            logger,
                            gameApi,
                            matchAwareness
                        );
                    }
                }
            } else if (this.state === SquadState.Exploring) {
                units.forEach((unit, index) => {
                    this.currentExplorationAngle = (360 / units.length) * index;
                    const baseTarget = this.updateExplorationTarget(gameApi, unit);
                    const offset = this.getFormationOffset(index, units.length);
                    const explorationTarget = new Vector2(
                        baseTarget.x + offset.x,
                        baseTarget.y + offset.y
                    );
                    
                    const targetTile = gameApi.mapApi.getTile(explorationTarget.x, explorationTarget.y);
                    if (targetTile) {
                        this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, explorationTarget));
                        this.debugLastTarget = `Exploring @${Math.round(explorationTarget.x)},${Math.round(explorationTarget.y)}`;
                    }

                    const nearbyHostiles = matchAwareness
                        .getHostilesNearPoint(unit.tile.rx, unit.tile.ry, ATTACK_SCAN_AREA)
                        .filter(hostile => !isOwnedByNeutral(gameApi.getUnitData(hostile.unitId)));

                    if (nearbyHostiles.length > 0) {
                        logger(`NavalSquad ${mission.getUniqueName()} found enemies while exploring, switching to attack mode`);
                        this.state = SquadState.Attacking;
                    }
                });
            }
        }

        return noop();
    }

    private submitActionIfNew(actionBatcher: ActionBatcher, action: BatchableAction) {
        const lastAction = this.lastOrderGiven[action.unitId];
        if (!lastAction || !lastAction.isSameAs(action)) {
            actionBatcher.push(action);
            this.lastOrderGiven[action.unitId] = action;
        }
    }

    public getDebugText(): string {
        return `${this.state}, target: ${this.debugLastTarget}`;
    }

    public getGlobalDebugText(): string | undefined {
        return this.debugLastTarget;
    }

    public setTargetArea(target: Vector2) {
        this.targetArea = target;
    }

    private isPathfindingInProgress(unit: UnitData, currentTick: number): boolean {
        const lastPathfindingTime = this.lastPathfindingTime.get(unit.id);
        if (!lastPathfindingTime) return false;
        return currentTick - lastPathfindingTime < PATHFINDING_WAIT_TICKS;
    }

    private startPathfinding(unit: UnitData, currentTick: number) {
        this.lastPathfindingTime.set(unit.id, currentTick);
    }
} 