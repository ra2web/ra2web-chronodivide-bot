import { ActionsApi, GameApi, ObjectType, PlayerData, SideType, UnitData, Vector2, TerrainType } from "@chronodivide/game-api";
import { CombatSquad } from "./squads/combatSquad.js";
import { Mission, MissionAction, disbandMission, noop, requestUnits, searchBuildings, requestNavalMission } from "../mission.js";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import { RetreatMission } from "./retreatMission.js";
import { DebugLogger, countBy, isOwnedByNeutral, maxBy } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { getSovietComposition } from "../../composition/sovietCompositions.js";
import { getAlliedCompositions } from "../../composition/alliedCompositions.js";
import { UnitComposition } from "../../composition/common.js";
import { manageMoveMicro } from "./squads/common.js";

export enum AttackFailReason {
    NoTargets = 0,
    DefenceTooStrong = 1,
}

enum AttackMissionState {
    Preparing = 0,
    Attacking = 1,
    Retreating = 2,
}

const NO_TARGET_RETARGET_TICKS = 150;
const NO_TARGET_IDLE_TIMEOUT_TICKS = 450;
const VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS = 60;
const BASE_ATTACK_COOLDOWN_TICKS = 900;
const ATTACK_MISSION_INITIAL_PRIORITY = 50;
const ATTACK_MISSION_PRIORITY_RAMP = 1.2;
const ATTACK_MISSION_MAX_PRIORITY = 100;
const MIN_ATTACK_SQUAD_SIZE = 3;
const FORCE_ATTACK_THRESHOLD = 0.8;
const BUILDING_DEFENSE_RADIUS = 30;  // 检测建筑物周围敌人的范围
const BUILDING_SUPPORT_RADIUS = 40;  // 检测可以支援建筑物的友军范围
const MAX_SEARCH_RADIUS = 100;  // 最大搜索半径
const SEARCH_RADIUS_INCREMENT = 10;  // 每次增加的搜索半径
const SEARCH_EXPAND_INTERVAL = 60;  // 扩大搜索范围的间隔时间
const TARGET_UPDATE_COOLDOWN = 60;  // 更新目标的最小间隔时间（ticks）
const EMERGENCY_TARGET_UPDATE_COOLDOWN = 30;  // 紧急情况下更新目标的最小间隔时间（ticks）
const NAVAL_YARD_ATTACK_RANGE = 5;  // 减小攻击船厂时的有效范围，确保单位能接近到足够近的距离
const NAVAL_YARD_SCORE_MULTIPLIER = 3.0;  // 提高船厂的目标优先级
const NAVAL_TARGET_SEARCH_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];  // 搜索可能的攻击角度
const MAX_IDLE_TIME = 300;  // 部队最大空闲时间（ticks）
const MAX_GATHER_TIME = 450;  // 部队最大集结时间（ticks）
const FORCE_ATTACK_DISTANCE = 40;  // 当部队距离目标这么近时强制发起进攻
const TARGET_LOCK_DURATION = 150;  // 目标锁定持续时间（ticks）
const TARGET_SWITCH_MIN_IMPROVEMENT = 0.3;  // 切换目标所需的最小改善比例
const TARGET_MEMORY_SIZE = 3;  // 记住最近几个目标，避免来回切换
const BUILDING_SEARCH_COOLDOWN = 30;

function calculateTargetComposition(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition {
    if (!playerData.country) {
        throw new Error(`player ${playerData.name} has no country`);
    } else if (playerData.country.side === SideType.Nod) {
        return getSovietComposition(gameApi, playerData, matchAwareness);
    } else {
        return getAlliedCompositions(gameApi, playerData, matchAwareness);
    }
}

/**
 * 检查友方建筑是否受到攻击，如果是则返回攻击者的位置
 */
function checkFriendlyBuildingsUnderAttack(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness
): Vector2 | null {
    // 获取所有友方建筑
    const friendlyBuildings = gameApi
        .getVisibleUnits(playerData.name, "allied")
        .map((unitId) => gameApi.getUnitData(unitId))
        .filter((unit): unit is UnitData => 
            !!unit && 
            unit.rules.type === ObjectType.Building &&
            gameApi.areAlliedPlayers(playerData.name, unit.owner)
        );

    for (const building of friendlyBuildings) {
        // 检查建筑物周围是否有敌人
        const nearbyHostiles = matchAwareness
            .getHostilesNearPoint2d(new Vector2(building.tile.rx, building.tile.ry), BUILDING_DEFENSE_RADIUS)
            .map(({ unitId }) => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

        if (nearbyHostiles.length > 0) {
            // 返回最近的敌人位置
            const nearestHostile = nearbyHostiles[0];
            return new Vector2(nearestHostile.tile.rx, nearestHostile.tile.ry);
        }
    }

    return null;
}

/**
 * 判断单位是否可以攻击目标
 */
function canUnitAttackTarget(unit: UnitData, target: UnitData): boolean {
    // 检查单位是否是海军单位
    const isNavalUnit = unit.rules.naval || unit.name === 'DEST';
    // 检查目标是否是船厂
    const isNavalYard = target.rules.type === ObjectType.Building && target.name === 'NAYARD';
    
    // 如果目标是船厂，只有海军单位可以攻击
    if (isNavalYard) {
        return isNavalUnit;
    }
    
    // 如果目标在水中，只有海军单位可以攻击
    if (target.rules.naval) {
        return isNavalUnit;
    }
    
    // 其他情况，陆地单位可以攻击陆地目标
    return !target.rules.naval;
}

/**
 * 在地图上搜索敌方建筑
 */
function searchEnemyBuildings(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    searchRadius: number,
    position: Vector2,
    unitData: UnitData | null = null  // 添加发起搜索的单位信息
): Vector2 | null {
    // 获取视野内的所有敌方单位
    const enemyUnits = gameApi
        .getVisibleUnits(playerData.name, "enemy")
        .map((unitId) => gameApi.getUnitData(unitId))
        .filter((unit): unit is UnitData => 
            !!unit && 
            !isOwnedByNeutral(unit) &&
            unit.rules.type === ObjectType.Building &&
            (!unitData || canUnitAttackTarget(unitData, unit))  // 检查是否可以攻击该目标
        );

    // 如果找到敌方建筑，返回最近的一个
    if (enemyUnits.length > 0) {
        // 计算每个建筑到当前位置的距离
        const buildingsWithDistance = enemyUnits.map(unit => ({
            unit,
            distance: Math.sqrt(
                Math.pow(unit.tile.rx - position.x, 2) + 
                Math.pow(unit.tile.ry - position.y, 2)
            )
        }));

        // 按距离排序
        buildingsWithDistance.sort((a, b) => a.distance - b.distance);
        const nearestBuilding = buildingsWithDistance[0].unit;
        
        // 如果是船厂，返回一个可以攻击的位置
        if (nearestBuilding.name === 'NAYARD') {
            // 计算从目标位置向外延伸的攻击位置
            const dx = position.x - nearestBuilding.tile.rx;
            const dy = position.y - nearestBuilding.tile.ry;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > 0) {
                const scale = NAVAL_YARD_ATTACK_RANGE / distance;
                return new Vector2(
                    nearestBuilding.tile.rx + dx * scale,
                    nearestBuilding.tile.ry + dy * scale
                );
            }
        }
        
        return new Vector2(nearestBuilding.tile.rx, nearestBuilding.tile.ry);
    }

    // 如果没有找到建筑，尝试搜索地图上未探索的区域
    const mapSize = gameApi.mapApi.getRealMapSize();
    const mapWidth = mapSize.width - 1;  // 减1以确保在有效范围内
    const mapHeight = mapSize.height - 1;  // 减1以确保在有效范围内
    
    // 计算安全的搜索区域（避免边界）
    const safeMargin = 5;  // 与地图边界保持一定距离
    const safeX = Math.min(mapWidth - safeMargin, Math.max(safeMargin, Math.floor(position.x)));
    const safeY = Math.min(mapHeight - safeMargin, Math.max(safeMargin, Math.floor(position.y)));
    
    // 定义搜索点，确保都在地图范围内
    const unexploredAreas = [
        new Vector2(safeMargin, safeMargin),  // 左上
        new Vector2(mapWidth - safeMargin, safeMargin),  // 右上
        new Vector2(safeMargin, mapHeight - safeMargin),  // 左下
        new Vector2(mapWidth - safeMargin, mapHeight - safeMargin),  // 右下
        new Vector2(Math.floor(mapWidth / 2), Math.floor(mapHeight / 2))  // 中心
    ];

    // 选择离当前位置最近的未探索区域
    const areasWithDistance = unexploredAreas.map(area => ({
        area,
        distance: Math.sqrt(
            Math.pow(area.x - safeX, 2) + 
            Math.pow(area.y - safeY, 2)
        )
    }));

    // 按距离排序
    areasWithDistance.sort((a, b) => a.distance - b.distance);
    
    // 返回最近的未探索区域
    return areasWithDistance[0].area;
}

/**
 * 计算攻击船厂的最佳位置
 */
function calculateNavalYardAttackPosition(
    gameApi: GameApi,
    target: UnitData,
    attackerPosition: Vector2,
    range: number
): Vector2 | null {
    const mapSize = gameApi.mapApi.getRealMapSize();
    
    const dx = attackerPosition.x - target.tile.rx;
    const dy = attackerPosition.y - target.tile.ry;
    const baseAngle = Math.atan2(dy, dx) * 180 / Math.PI;
    
    for (const angleOffset of NAVAL_TARGET_SEARCH_ANGLES) {
        const angle = (baseAngle + angleOffset) * Math.PI / 180;
        const testRange = range;
        
        const candidateX = target.tile.rx + Math.cos(angle) * testRange;
        const candidateY = target.tile.ry + Math.sin(angle) * testRange;
        
        if (candidateX < 1 || candidateX >= mapSize.width - 1 || 
            candidateY < 1 || candidateY >= mapSize.height - 1) {
            continue;
        }
        
        const tile = gameApi.mapApi.getTile(Math.floor(candidateX), Math.floor(candidateY));
        // 检查位置是否在水域
        if (tile && tile.terrainType === TerrainType.Water) {
            return new Vector2(candidateX, candidateY);
        }
    }
    
    return null;
}

/**
 * A mission that tries to attack a certain area.
 */
export class AttackMission extends Mission<AttackFailReason> {
    private squad: CombatSquad;

    private lastTargetSeenAt = 0;
    private hasPickedNewTarget: boolean = false;

    private state: AttackMissionState = AttackMissionState.Preparing;
    private lastSearchTime: number = 0;
    private searchRadius: number = 20;
    private currentGameApi: GameApi | null = null;
    private lastTargetUpdateTime: number = 0;  // 上次更新目标的时间
    private missionStartTime: number = 0;  // 任务开始时间
    private gatherStartTime: number = 0;   // 集结开始时间
    private currentTargetLockTime: number = 0;  // 当前目标的锁定时间
    private recentTargets: Vector2[] = [];  // 最近的目标列表
    private currentTargetScore: number = 0;  // 当前目标的评分
    private lastBuildingSearchTime = 0;
    private currentSearchRadius = 20;
    
    constructor(
        uniqueName: string,
        private priority: number,
        rallyArea: Vector2,
        private attackArea: Vector2,
        private radius: number,
        private composition: UnitComposition,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        this.squad = new CombatSquad(rallyArea, attackArea, radius);
        this.missionStartTime = Date.now();
        this.gatherStartTime = Date.now();
    }

    public getCenterOfMass(): Vector2 | null {
        if (!this.currentGameApi) {
            return null;
        }

        const units = this.getUnitsGameObjectData(this.currentGameApi);
        if (units.length === 0) {
            return null;
        }

        let sumX = 0;
        let sumY = 0;
        for (const unit of units) {
            sumX += unit.tile.rx;
            sumY += unit.tile.ry;
        }

        return new Vector2(
            sumX / units.length,
            sumY / units.length
        );
    }

    public _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        this.currentGameApi = gameApi;

        switch (this.state) {
            case AttackMissionState.Preparing:
                return this.handlePreparingState(
                    gameApi,
                    actionsApi,
                    playerData,
                    matchAwareness,
                    actionBatcher,
                );
            case AttackMissionState.Attacking:
                return this.handleAttackingState(
                    gameApi,
                    actionsApi,
                    playerData,
                    matchAwareness,
                    actionBatcher,
                );
            default:
                return noop();
        }
    }

    /**
     * 主动搜索敌方目标
     */
    private findNearbyTarget(gameApi: GameApi, matchAwareness: MatchAwareness, position: Vector2): Vector2 | null {
        const currentTick = gameApi.getCurrentTick();
        
        if (currentTick - this.lastSearchTime > SEARCH_EXPAND_INTERVAL) {
            this.searchRadius = Math.min(this.searchRadius + SEARCH_RADIUS_INCREMENT, MAX_SEARCH_RADIUS);
            this.lastSearchTime = currentTick;
        }

        const units = this.getUnitsGameObjectData(gameApi)
            .map(obj => gameApi.getUnitData(obj.id))
            .filter((unit): unit is UnitData => unit !== null && unit !== undefined);
            
        if (units.length === 0 || !units[0].owner) {
            return null;
        }

        // 优先搜索船厂
        const navalYards = gameApi
            .getVisibleUnits(gameApi.getPlayerData(units[0].owner).name, "enemy")
            .map(unitId => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => unit !== null && unit !== undefined && unit.name === 'NAYARD');

        if (navalYards.length > 0) {
            for (const navalYard of navalYards) {
                // 检查是否有海军单位可以攻击这个船厂
                const hasNavalAttacker = units.some(unit => 
                    (unit.rules.naval || unit.name === 'DEST') && 
                    canUnitAttackTarget(unit, navalYard)
                );

                if (hasNavalAttacker) {
                    const attackPos = calculateNavalYardAttackPosition(
                        gameApi,
                        navalYard,
                        position,
                        NAVAL_YARD_ATTACK_RANGE
                    );
                    
                    if (attackPos) {
                        console.log("[AttackMission] 发现船厂，计算攻击位置");
                        return attackPos;
                    }
                }
            }
        }

        // 继续搜索其他目标...
        const hostiles = matchAwareness
            .getHostilesNearPoint2d(position, this.searchRadius)
            .map(({ unitId }) => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

        if (hostiles.length > 0) {
            const validTargets = hostiles.filter(target => 
                units.some(unit => canUnitAttackTarget(unit, target))
            );

            if (validTargets.length > 0) {
                const buildings = validTargets.filter(unit => unit.rules.type === ObjectType.Building);
                if (buildings.length > 0) {
                    const target = buildings[0];
                    return new Vector2(target.tile.rx, target.tile.ry);
                }

                const combatUnits = validTargets.filter(unit => unit.rules.isSelectableCombatant);
                if (combatUnits.length > 0) {
                    const target = combatUnits[0];
                    return new Vector2(target.tile.rx, target.tile.ry);
                }

                const target = validTargets[0];
                return new Vector2(target.tile.rx, target.tile.ry);
            }
        }

        return searchEnemyBuildings(
            gameApi, 
            gameApi.getPlayerData(units[0].owner), 
            matchAwareness, 
            this.searchRadius, 
            position,
            units[0]
        );
    }

    private handlePreparingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        const currentComposition: UnitComposition = countBy(this.getUnitsGameObjectData(gameApi), (unit) => unit.name);
        const totalUnits = Object.values(currentComposition).reduce((sum, count) => sum + count, 0);
        const targetTotal = Object.values(this.composition).reduce((sum, count) => sum + count, 0);
        const currentTick = gameApi.getCurrentTick();

        // 检查是否有友方建筑受到攻击
        const buildingAttacker = checkFriendlyBuildingsUnderAttack(gameApi, playerData, matchAwareness);
        if (buildingAttacker && totalUnits >= MIN_ATTACK_SQUAD_SIZE) {
            console.log("[AttackMission] 友方建筑受到攻击，立即支援");
            this.squad.setAttackArea(buildingAttacker);
            this.state = AttackMissionState.Attacking;
            return noop();
        }

        // 检查是否有附近的敌人
        if (totalUnits >= MIN_ATTACK_SQUAD_SIZE) {
            const centerOfMass = this.getCenterOfMass();
            if (centerOfMass) {
                // 检查是否接近目标
                const distanceToTarget = Math.sqrt(
                    Math.pow(centerOfMass.x - this.attackArea.x, 2) + 
                    Math.pow(centerOfMass.y - this.attackArea.y, 2)
                );

                // 如果部队已经很接近目标，直接进入攻击状态
                if (distanceToTarget <= FORCE_ATTACK_DISTANCE) {
                    console.log("[AttackMission] 部队已接近目标，开始进攻");
                    this.state = AttackMissionState.Attacking;
                    return noop();
                }

                const nearbyTarget = this.findNearbyTarget(gameApi, matchAwareness, centerOfMass);
                if (nearbyTarget) {
                    // 检查目标是否是船厂或水上单位
                    const targetUnits = matchAwareness
                        .getHostilesNearPoint2d(nearbyTarget, 5)
                        .map(({ unitId }) => gameApi.getUnitData(unitId))
                        .filter((unit): unit is UnitData => unit !== null && unit !== undefined);

                    const requiresNavalForce = targetUnits.some(unit => 
                        unit.name === 'NAYARD' || unit.rules.naval
                    );

                    // 检查当前部队中是否有海军单位
                    const hasNavalUnits = this.getUnitsGameObjectData(gameApi)
                        .map(obj => gameApi.getUnitData(obj.id))
                        .filter((unit): unit is UnitData => unit !== null && unit !== undefined)
                        .some(unit => unit.rules.naval || unit.name === 'DEST');

                    if (requiresNavalForce && !hasNavalUnits) {
                        console.log("[AttackMission] 发现需要海军单位攻击的目标，请求创建海军任务");
                        // 返回一个特殊的动作，通知任务控制器创建海军任务
                        return {
                            type: "request_naval_mission",
                            target: nearbyTarget
                        } as MissionAction;
                    }

                    console.log("[AttackMission] 发现附近敌人，立即开始进攻");
                    this.squad.setAttackArea(nearbyTarget);
                    this.state = AttackMissionState.Attacking;
                    return noop();
                }
            }
        }

        // 检查集结时间是否过长
        const gatherTime = currentTick - this.gatherStartTime;
        if (gatherTime > MAX_GATHER_TIME && totalUnits >= MIN_ATTACK_SQUAD_SIZE) {
            console.log("[AttackMission] 集结时间过长，强制开始进攻");
            this.state = AttackMissionState.Attacking;
            return noop();
        }

        // 如果达到阈值就开始进攻
        if (totalUnits >= targetTotal * FORCE_ATTACK_THRESHOLD) {
            console.log("[AttackMission] 部队数量达到阈值，开始进攻");
            this.state = AttackMissionState.Attacking;
            return noop();
        }

        // 继续请求缺少的单位
        const missingUnits = Object.entries(this.composition).filter(([unitType, targetAmount]) => {
            return !currentComposition[unitType] || currentComposition[unitType] < targetAmount;
        });

        if (missingUnits.length > 0) {
            this.priority = Math.min(this.priority * ATTACK_MISSION_PRIORITY_RAMP, ATTACK_MISSION_MAX_PRIORITY);
            return requestUnits(
                missingUnits.map(([unitName]) => unitName),
                this.priority,
            );
        }

        return noop();
    }

    /**
     * 评估目标的价值
     */
    private evaluateTarget(target: Vector2, gameApi: GameApi, matchAwareness: MatchAwareness): number {
        const hostiles = matchAwareness
            .getHostilesNearPoint2d(target, this.radius)
            .map((unit) => gameApi.getUnitData(unit.unitId))
            .filter((unit) => !isOwnedByNeutral(unit)) as UnitData[];

        let score = 0;
        let hasNavalYard = false;

        for (const hostile of hostiles) {
            if (hostile.rules.type === ObjectType.Building) {
                if (hostile.name === 'NAYARD') {
                    score += 15 * NAVAL_YARD_SCORE_MULTIPLIER;  // 大幅提高船厂权重
                    hasNavalYard = true;
                } else {
                    score += 10;
                }
            } else if (hostile.rules.isSelectableCombatant) {
                score += 5;
            } else {
                score += 1;
            }
        }

        // 如果目标区域有船厂，降低距离惩罚
        const centerOfMass = this.getCenterOfMass();
        if (centerOfMass) {
            const distance = Math.sqrt(
                Math.pow(centerOfMass.x - target.x, 2) + 
                Math.pow(centerOfMass.y - target.y, 2)
            );
            if (hasNavalYard) {
                score = score / (1 + distance * 0.005);  // 降低距离惩罚
            } else {
                score = score / (1 + distance * 0.01);
            }
        }

        return score;
    }

    /**
     * 检查是否应该切换到新目标
     */
    private shouldSwitchTarget(
        newTarget: Vector2,
        gameApi: GameApi,
        matchAwareness: MatchAwareness,
        currentTick: number
    ): boolean {
        // 如果当前目标锁定时间未到，且不是紧急情况，则不切换
        if (currentTick - this.currentTargetLockTime < TARGET_LOCK_DURATION) {
            // 检查当前目标是否还有效
            const currentTargetStillValid = matchAwareness
                .getHostilesNearPoint2d(this.squad.getAttackArea(), this.radius)
                .length > 0;
            
            if (currentTargetStillValid) {
                return false;
            }
        }

        // 评估新目标
        const newScore = this.evaluateTarget(newTarget, gameApi, matchAwareness);
        
        // 如果新目标最近被访问过，降低其分数
        if (this.recentTargets.some(target => 
            Math.abs(target.x - newTarget.x) < 5 && 
            Math.abs(target.y - newTarget.y) < 5
        )) {
            return false;
        }

        // 只有当新目标比当前目标好很多时才切换
        return newScore > this.currentTargetScore * (1 + TARGET_SWITCH_MIN_IMPROVEMENT);
    }

    private handleAttackingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const currentTick = gameApi.getCurrentTick();
        const update = this.squad.onAiUpdate(
            gameApi,
            actionsApi,
            actionBatcher,
            playerData,
            this,
            matchAwareness,
            this.logger,
        );

        if (update.type !== "noop") {
            return update;
        }

        // 检查当前目标是否还有效
        const currentTargetStillValid = matchAwareness
            .getHostilesNearPoint2d(this.squad.getAttackArea(), this.radius)
            .length > 0;

        // 如果没有找到目标，尝试搜索敌方建筑
        if (!currentTargetStillValid) {
            if (currentTick - this.lastBuildingSearchTime >= BUILDING_SEARCH_COOLDOWN) {
                return this.searchEnemyBuildings(gameApi, playerData, matchAwareness);
            }
        }

        return noop();
    }

    /**
     * 更新攻击目标
     */
    private updateTarget(
        newTarget: Vector2,
        gameApi: GameApi,
        matchAwareness: MatchAwareness,
        currentTick: number
    ) {
        console.log("[AttackMission] 更新攻击目标");
        this.squad.setAttackArea(newTarget);
        this.lastTargetSeenAt = currentTick;
        this.lastTargetUpdateTime = currentTick;
        this.currentTargetLockTime = currentTick;
        this.currentTargetScore = this.evaluateTarget(newTarget, gameApi, matchAwareness);
        
        // 更新最近目标列表
        this.recentTargets.push(newTarget);
        if (this.recentTargets.length > TARGET_MEMORY_SIZE) {
            this.recentTargets.shift();
        }
    }

    private handleRetreatingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        this.getUnits(gameApi).forEach((unitId) => {
            actionBatcher.push(manageMoveMicro(unitId, matchAwareness.getMainRallyPoint()));
        });
        return disbandMission();
    }

    public getGlobalDebugText(): string | undefined {
        return this.squad.getGlobalDebugText() ?? "<none>";
    }

    public getState() {
        return this.state;
    }

    // This mission can give up its units while preparing.
    public isUnitsLocked(): boolean {
        return this.state !== AttackMissionState.Preparing;
    }

    public getPriority() {
        return this.priority;
    }

    private searchEnemyBuildings(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
    ): MissionAction {
        const currentTick = gameApi.getCurrentTick();
        
        // 检查是否需要扩大搜索范围
        if (currentTick - this.lastBuildingSearchTime >= SEARCH_EXPAND_INTERVAL) {
            this.currentSearchRadius = Math.min(this.currentSearchRadius + SEARCH_RADIUS_INCREMENT, MAX_SEARCH_RADIUS);
            this.lastBuildingSearchTime = currentTick;
        }

        // 从当前位置开始搜索
        const centerOfMass = this.getCenterOfMass();
        if (!centerOfMass) {
            return noop();
        }

        return searchBuildings(centerOfMass, this.currentSearchRadius);
    }

    private requestNavalSupport(target: Vector2): MissionAction {
        return requestNavalMission(target, this.radius);
    }
}

// Calculates the weight for initiating an attack on the position of a unit or building.
// This is separate from unit micro; the squad will be ordered to attack in the vicinity of the point.
const getTargetWeight: (unitData: UnitData, tryFocusHarvester: boolean) => number = (unitData, tryFocusHarvester) => {
    if (tryFocusHarvester && unitData.rules.harvester) {
        return 100000;
    } else if (unitData.type === ObjectType.Building) {
        return unitData.maxHitPoints * 10;
    } else {
        return unitData.maxHitPoints;
    }
};

function generateTarget(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    includeBaseLocations: boolean = false,
): Vector2 | null {
    // Randomly decide between harvester and base.
    try {
        const tryFocusHarvester = gameApi.generateRandomInt(0, 1) === 0;
        const enemyUnits = gameApi
            .getVisibleUnits(playerData.name, "enemy")
            .map((unitId) => gameApi.getUnitData(unitId))
            .filter((u) => !!u && gameApi.getPlayerData(u.owner).isCombatant) as UnitData[];

        const maxUnit = maxBy(enemyUnits, (u) => getTargetWeight(u, tryFocusHarvester));
        if (maxUnit) {
            return new Vector2(maxUnit.tile.rx, maxUnit.tile.ry);
        }
        if (includeBaseLocations) {
            const mapApi = gameApi.mapApi;
            const enemyPlayers = gameApi
                .getPlayers()
                .map(gameApi.getPlayerData)
                .filter((otherPlayer) => !gameApi.areAlliedPlayers(playerData.name, otherPlayer.name));

            const unexploredEnemyLocations = enemyPlayers.filter((otherPlayer) => {
                const tile = mapApi.getTile(otherPlayer.startLocation.x, otherPlayer.startLocation.y);
                if (!tile) {
                    return false;
                }
                return !mapApi.isVisibleTile(tile, playerData.name);
            });
            if (unexploredEnemyLocations.length > 0) {
                const idx = gameApi.generateRandomInt(0, unexploredEnemyLocations.length - 1);
                return unexploredEnemyLocations[idx].startLocation;
            }
        }
    } catch (err) {
        // There's a crash here when accessing a building that got destroyed. Will catch and ignore or now.
        return null;
    }
    return null;
}

export class AttackMissionFactory implements MissionFactory {
    constructor(private lastAttackAt: number = -VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS) {}

    getName(): string {
        return "AttackMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        if (gameApi.getCurrentTick() < this.lastAttackAt + VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS) {
            return;
        }

        // can only have one attack 'preparing' at once.
        if (
            missionController
                .getMissions()
                .some(
                    (mission): mission is AttackMission =>
                        mission instanceof AttackMission && mission.getState() === AttackMissionState.Preparing,
                )
        ) {
            return;
        }

        const attackRadius = 10;

        const includeEnemyBases = gameApi.getCurrentTick() > this.lastAttackAt + BASE_ATTACK_COOLDOWN_TICKS;

        const attackArea = generateTarget(gameApi, playerData, matchAwareness, includeEnemyBases);

        if (!attackArea) {
            return;
        }

        const squadName = "attack_" + gameApi.getCurrentTick();

        const composition: UnitComposition = calculateTargetComposition(gameApi, playerData, matchAwareness);

        const tryAttack = missionController.addMission(
            new AttackMission(
                squadName,
                ATTACK_MISSION_INITIAL_PRIORITY,
                matchAwareness.getMainRallyPoint(),
                attackArea,
                attackRadius,
                composition,
                logger,
            ).then((unitIds, reason) => {
                missionController.addMission(
                    new RetreatMission(
                        "retreat-from-" + squadName + gameApi.getCurrentTick(),
                        matchAwareness.getMainRallyPoint(),
                        unitIds,
                        logger,
                    ),
                );
            }),
        );
        if (tryAttack) {
            this.lastAttackAt = gameApi.getCurrentTick();
        }
    }

    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission<any>,
        failureReason: any,
        missionController: MissionController,
    ): void {}
}
