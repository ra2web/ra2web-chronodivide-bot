import { ActionsApi, GameApi, MovementZone, PlayerData, UnitData, Vector2, TerrainType, ObjectType } from "@chronodivide/game-api";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import { DebugLogger, isOwnedByNeutral } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { NavalSquad } from "./squads/navalSquad.js";
import { getAlliedNavalCompositions } from "../../composition/alliedNavalCompositions.js";
import { manageMoveMicro } from "./squads/common.js";

export enum NavalFailReason {
    NoTargets = 0,
    DefenceTooStrong = 1,
}

enum NavalMissionState {
    Preparing = 0,
    Attacking = 1,
    Retreating = 2,
}

const NAVAL_CHECK_INTERVAL_TICKS = 300;
const NAVAL_MISSION_INITIAL_PRIORITY = 50;
const NAVAL_ATTACK_RADIUS = 30;  // DEBUG: 增加攻击半径
const NAVAL_UNIT_REQUEST_PRIORITY = 60;
const GATHER_RADIUS = 10;  // 集结半径
const MAX_SCATTER_DISTANCE = 20;  // 最大分散距离
const FORCE_GATHER_THRESHOLD = 0.6;  // 当超过60%的单位分散时强制集结
const NAVAL_TARGET_PRIORITY = {
    NAVAL_YARD: 100,
    NAVAL_UNIT: 80,
    COASTAL_BUILDING: 60,
    COASTAL_UNIT: 40,
    INLAND_TARGET: 20
};
const ATTACK_SCAN_AREA = 40;  // DEBUG: 增加扫描范围
const NAVAL_UNIT_TYPES = ["DEST", "AEGIS", "DLPH", "CARRIER"];  // 所有海军单位类型
const FORCE_ATTACK_THRESHOLD = 0.5;  // DEBUG: 降低开始进攻的阈值
const MAX_GATHER_TIME = 900;  // 最大集结时间（ticks）
const SEARCH_EXPAND_INTERVAL = 300;  // 扩大搜索范围的间隔
const INITIAL_SEARCH_RADIUS = 40;  // DEBUG: 增加初始搜索半径
const MAX_SEARCH_RADIUS = 150;  // DEBUG: 增加最大搜索半径
const TARGET_UPDATE_INTERVAL = 60;  // DEBUG: 每60tick更新一次目标
const MAX_MISSION_DURATION = 1800;  // 任务最大持续时间（ticks）
const MAX_NO_PROGRESS_TIME = 600;  // 无进展最大时间（ticks）
const MIN_PROGRESS_DISTANCE = 10;  // 最小进展距离

/**
 * 海军任务 - 负责控制海军单位进行攻击和防御
 */
export class NavalMission extends Mission<NavalFailReason> {
    private squad: NavalSquad;
    private state: NavalMissionState = NavalMissionState.Preparing;
    private lastStateUpdateAt: number = 0;
    private lastLogTime: number = 0;
    private LOG_INTERVAL: number = 300;
    private gatherStartTime: number = 0;
    private currentSearchRadius: number = INITIAL_SEARCH_RADIUS;
    private lastSearchExpandTime: number = 0;
    private lastTargetUpdateTime: number = 0;
    private missionStartTime: number = 0;
    private lastProgressTime: number = 0;
    private lastPosition: Vector2 | null = null;

    constructor(
        uniqueName: string,
        private missionPriority: number,
        private rallyPoint: Vector2,
        private targetArea: Vector2,
        private attackRadius: number,
        private navalUnitTypes: string[],
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        this.squad = new NavalSquad(targetArea);
        this.gatherStartTime = Date.now();
        this.missionStartTime = Date.now();
    }

    public getState(): NavalMissionState {
        return this.state;
    }

    public getPriority(): number {
        return this.missionPriority;
    }

    public getGlobalDebugText(): string {
        return `${NavalMissionState[this.state]} - ${this.squad.getGlobalDebugText() ?? ""}`;
    }

    private clampToMapBoundaries(gameApi: GameApi, position: Vector2): Vector2 {
        const mapSize = gameApi.mapApi.getRealMapSize();
        const x = Math.max(2, Math.min(Math.round(position.x), mapSize.width - 3));
        const y = Math.max(2, Math.min(Math.round(position.y), mapSize.height - 3));
        return new Vector2(x, y);
    }

    private findNewTarget(
        gameApi: GameApi, 
        matchAwareness: MatchAwareness, 
        currentPosition: Vector2,
        playerData: PlayerData
    ): Vector2 | null {
        // 定期扩大搜索范围
        const currentTick = gameApi.getCurrentTick();
        if (currentTick - this.lastSearchExpandTime > SEARCH_EXPAND_INTERVAL) {
            this.currentSearchRadius = Math.min(this.currentSearchRadius + 20, MAX_SEARCH_RADIUS);
            this.lastSearchExpandTime = currentTick;
            console.log("[NavalMission] 扩大搜索范围到:", this.currentSearchRadius);
        }

        // 优先搜索敌方船厂
        const navalYards = gameApi
            .getVisibleUnits(playerData.name, "enemy")
            .map(unitId => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => 
                unit !== null && 
                unit !== undefined &&
                (unit.name === 'NAYARD' || unit.name === 'GAYARD')
            );

        if (navalYards.length > 0) {
            const target = navalYards[0];
            console.log("[NavalMission] 发现敌方船厂，设为攻击目标");
            return new Vector2(target.tile.rx, target.tile.ry);
        }

        // 搜索其他目标
        const targets = matchAwareness
            .getHostilesNearPoint2d(currentPosition, this.currentSearchRadius)
            .map(({ unitId }) => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => 
                unit !== null && 
                unit !== undefined &&
                !isOwnedByNeutral(unit) &&
                (unit.rules.movementZone === MovementZone.Water || 
                 unit.rules.type === ObjectType.Building)
            );

        if (targets.length > 0) {
            const target = targets[0];
            console.log("[NavalMission] 发现新目标:", target.name);
            return new Vector2(target.tile.rx, target.tile.ry);
        }

        // 如果找不到目标，直接前往敌方基地
        const enemyPlayers = gameApi.getPlayers().filter(p => !gameApi.areAlliedPlayers(playerData.name, p));
        if (enemyPlayers.length > 0) {
            const enemyPlayer = gameApi.getPlayerData(enemyPlayers[0]);
            console.log("[NavalMission] 无目标，前往敌方基地");
            return enemyPlayer.startLocation;
        }

        return null;
    }

    private checkMissionProgress(currentPosition: Vector2): boolean {
        if (!this.lastPosition) {
            this.lastPosition = currentPosition;
            return true;
        }

        const distance = Math.sqrt(
            Math.pow(currentPosition.x - this.lastPosition.x, 2) +
            Math.pow(currentPosition.y - this.lastPosition.y, 2)
        );

        if (distance >= MIN_PROGRESS_DISTANCE) {
            this.lastPosition = currentPosition;
            this.lastProgressTime = Date.now();
            return true;
        }

        return false;
    }

    private shouldCancelMission(currentTick: number): boolean {
        // 检查任务是否超时
        const missionDuration = currentTick - this.missionStartTime;
        if (missionDuration > MAX_MISSION_DURATION) {
            console.log("[NavalMission] 任务超时，取消任务");
            return true;
        }

        // 检查是否长时间没有进展
        const noProgressTime = Date.now() - this.lastProgressTime;
        if (noProgressTime > MAX_NO_PROGRESS_TIME) {
            console.log("[NavalMission] 长时间无进展，取消任务");
            return true;
        }

        return false;
    }

    _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const currentTick = gameApi.getCurrentTick();

        // 获取所有海军单位
        const navalUnits = this.getUnitsMatchingByRule(gameApi, (r) => 
            r.isSelectableCombatant && 
            (r.movementZone === MovementZone.Water || r.movementZone === MovementZone.AmphibiousDestroyer)
        ).map(unitId => gameApi.getUnitData(unitId)).filter((unit): unit is UnitData => !!unit);

        // 检查任务进展
        const centerOfMass = this.getCenterOfMass();
        if (centerOfMass) {
            this.checkMissionProgress(centerOfMass);
            
            // 检查是否应该取消任务
            if (this.shouldCancelMission(currentTick)) {
                return disbandMission();
            }
        }

        // 定期输出调试信息
        if (currentTick - this.lastLogTime > this.LOG_INTERVAL) {
            console.log("[NavalMission] 状态:", NavalMissionState[this.state]);
            console.log("[NavalMission] 当前单位数:", navalUnits.length);
            this.lastLogTime = currentTick;
        }

        // 获取当前需要的海军编队组成
        const targetComposition = getAlliedNavalCompositions(gameApi, playerData, matchAwareness);
        const currentComposition: { [unitType: string]: number } = {};
        
        // 统计当前单位数量
        navalUnits.forEach(unit => {
            const unitType = unit.rules.name;
            currentComposition[unitType] = (currentComposition[unitType] || 0) + 1;
        });

        switch (this.state) {
            case NavalMissionState.Preparing: {
                // 检查单位是否过于分散
                if (this.checkUnitScatter(navalUnits)) {
                    console.log("[NavalMission] 单位过于分散，强制集结");
                    this.squad.setTargetArea(this.rallyPoint);
                    return this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, this, matchAwareness, this.logger);
                }

                // 请求缺少的单位
                const missingUnits: string[] = [];
                Object.entries(targetComposition).forEach(([unitType, targetCount]) => {
                    const currentCount = currentComposition[unitType] || 0;
                    if (currentCount < targetCount) {
                        for (let i = 0; i < targetCount - currentCount; i++) {
                            missingUnits.push(unitType);
                        }
                    }
                });

                if (missingUnits.length > 0) {
                    return requestUnits(missingUnits, NAVAL_UNIT_REQUEST_PRIORITY);
                }

                // 检查是否有足够单位开始进攻
                const totalUnits = navalUnits.length;
                const targetTotal = Object.values(targetComposition).reduce((sum, count) => sum + count, 0);
                
                // DEBUG: 更快地进入攻击状态
                const gatherTime = currentTick - this.gatherStartTime;
                if (totalUnits >= targetTotal * FORCE_ATTACK_THRESHOLD || 
                    (gatherTime > MAX_GATHER_TIME && totalUnits >= 2) ||  // 至少有2艘船就可以行动
                    (totalUnits >= 2 && gatherTime > MAX_GATHER_TIME / 2)) {  // DEBUG: 如果有2艘船且集结超过一半时间，也开始行动
                    console.log("[NavalMission] 开始进攻，单位数:", totalUnits);
                    this.state = NavalMissionState.Attacking;
                }

                // 使用 squad 的移动逻辑
                this.squad.setTargetArea(this.rallyPoint);
                break;
            }

            case NavalMissionState.Attacking: {
                // 检查是否需要补充单位
                const missingUnits: string[] = [];
                Object.entries(targetComposition).forEach(([unitType, targetCount]) => {
                    const currentCount = currentComposition[unitType] || 0;
                    if (currentCount < targetCount * 0.5) {  // 如果某种单位数量低于目标的50%，请求补充
                        missingUnits.push(unitType);
                    }
                });

                if (missingUnits.length > 0) {
                    return requestUnits(missingUnits, NAVAL_UNIT_REQUEST_PRIORITY);
                }

                // 定期更新攻击目标
                if (currentTick - this.lastTargetUpdateTime > TARGET_UPDATE_INTERVAL) {
                    if (centerOfMass) {
                        const newTarget = this.findNewTarget(gameApi, matchAwareness, centerOfMass, playerData);
                        if (newTarget) {
                            // 如果找到新目标，重置进度计时器
                            this.targetArea = newTarget;
                            this.lastProgressTime = Date.now();
                            console.log("[NavalMission] 更新攻击目标:", newTarget);
                        } else {
                            // 如果找不到目标，考虑取消任务
                            const noProgressTime = Date.now() - this.lastProgressTime;
                            if (noProgressTime > MAX_NO_PROGRESS_TIME) {
                                console.log("[NavalMission] 找不到目标，取消任务");
                                return disbandMission();
                            }
                        }
                    }
                    this.lastTargetUpdateTime = currentTick;
                }

                // 使用 squad 的移动逻辑
                const safeTargetArea = this.clampToMapBoundaries(gameApi, this.targetArea);
                this.squad.setTargetArea(safeTargetArea);
                break;
            }

            case NavalMissionState.Retreating: {
                this.squad.setTargetArea(this.rallyPoint);
                break;
            }
        }

        // 更新分队
        return this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, this, matchAwareness, this.logger);
    }

    private checkUnitScatter(navalUnits: UnitData[]): boolean {
        if (navalUnits.length < 2) return false;

        const centerOfMass = this.getCenterOfMass();
        if (!centerOfMass) return false;

        let scatteredUnits = 0;
        for (const unit of navalUnits) {
            const distance = Math.sqrt(
                Math.pow(unit.tile.rx - centerOfMass.x, 2) + 
                Math.pow(unit.tile.ry - centerOfMass.y, 2)
            );
            if (distance > MAX_SCATTER_DISTANCE) {
                scatteredUnits++;
            }
        }

        return (scatteredUnits / navalUnits.length) > FORCE_GATHER_THRESHOLD;
    }
}

/**
 * 海军任务工厂 - 负责创建和管理海军任务
 */
export class NavalMissionFactory implements MissionFactory {
    private lastNavalCheckAt: number = 0;

    getName(): string {
        return "NavalMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        const currentTick = gameApi.getCurrentTick();
        if (currentTick < this.lastNavalCheckAt + NAVAL_CHECK_INTERVAL_TICKS) {
            return;
        }

        // 检查是否已有正在准备的海军任务
        const hasPreparingNavalMission = missionController
            .getMissions()
            .some((mission) => mission instanceof NavalMission && mission.getState() === NavalMissionState.Preparing);

        if (hasPreparingNavalMission) {
            return;
        }

        // 获取地图大小
        const mapSize = gameApi.mapApi.getRealMapSize();
        const searchRadius = Math.min(100, Math.min(mapSize.width, mapSize.height) / 2);

        // 寻找水域目标
        const waterTargets = matchAwareness
            .getHostilesNearPoint2d(playerData.startLocation, searchRadius)
            .map(({ unitId }) => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => {
                if (!unit || isOwnedByNeutral(unit)) return false;
                // 检查单位位置是否在地图边界内
                if (unit.tile.rx < 1 || unit.tile.rx >= mapSize.width - 1 ||
                    unit.tile.ry < 1 || unit.tile.ry >= mapSize.height - 1) {
                    return false;
                }
                // 扩大目标类型，包括船厂和水域单位
                return unit.rules.movementZone === MovementZone.Water || 
                       unit.name === 'NAYARD' ||
                       unit.name === 'GAYARD';
            });

        if (waterTargets.length > 0) {
            // 选择最近的水域目标作为攻击点
            const target = waterTargets[0];
            const targetPoint = new Vector2(
                Math.max(1, Math.min(target.tile.rx, mapSize.width - 2)),
                Math.max(1, Math.min(target.tile.ry, mapSize.height - 2))
            );

            const squadName = "naval_" + currentTick;

            // 创建一个新的海军任务
            const tryNaval = missionController.addMission(
                new NavalMission(
                    squadName,
                    NAVAL_MISSION_INITIAL_PRIORITY,
                    matchAwareness.getMainRallyPoint(),
                    targetPoint,
                    NAVAL_ATTACK_RADIUS,
                    NAVAL_UNIT_TYPES,  // 使用所有海军单位类型
                    logger,
                )
            );

            if (tryNaval) {
                this.lastNavalCheckAt = currentTick;
            }
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