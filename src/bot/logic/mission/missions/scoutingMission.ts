import { ActionsApi, GameApi, OrderType, PlayerData, Vector2, TerrainType } from "@chronodivide/game-api";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { AttackMission } from "./attackMission.js";
import { MissionController } from "../missionController.js";
import { DebugLogger } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { getDistanceBetweenTileAndPoint } from "../../map/map.js";
import { PrioritisedScoutTarget } from "../../common/scout.js";

const SCOUT_MOVE_COOLDOWN_TICKS = 30;

// Max units to spend on a particular scout target.
const MAX_ATTEMPTS_PER_TARGET = 5;

// Maximum ticks to spend trying to scout a target *without making progress towards it*.
// Every time a unit gets closer to the target, the timer refreshes.
const MAX_TICKS_PER_TARGET = 600;

// 陆地单位在同一位置停留多久后考虑切换到水域单位
const STUCK_THRESHOLD_TICKS = 150;

// 判定单位被卡住的最小移动距离
const MIN_MOVEMENT_THRESHOLD = 2;

// 水域探索的搜索范围（从当前位置开始的搜索半径）
const WATER_SEARCH_RADIUS = 20;

/**
 * A mission that tries to scout around the map with a cheap, fast unit (usually attack dogs)
 */
export class ScoutingMission extends Mission {
    private scoutTarget: Vector2 | null = null;
    private attemptsOnCurrentTarget: number = 0;
    private scoutTargetRefreshedAt: number = 0;
    private lastMoveCommandTick: number = 0;
    private scoutTargetIsPermanent: boolean = false;
    private isWaterTarget: boolean = false;

    // Minimum distance from a scout to the target.
    private scoutMinDistance?: number;
    
    // 用于检测单位是否被卡住
    private lastScoutPositions: Map<number, Vector2> = new Map();
    private stuckStartTime: Map<number, number> = new Map();

    // 记录已探索的水域点
    private exploredWaterTiles: Set<string> = new Set();
    // 记录已探索的陆地点
    private exploredLandTiles: Set<string> = new Set();

    private hadUnit: boolean = false;

    constructor(
        uniqueName: string,
        private priority: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
    }

    /**
     * 在当前位置周围寻找未探索的目标（水域或陆地）
     */
    private findNextTarget(gameApi: GameApi, currentPosition: Vector2, isWater: boolean, playerData: PlayerData): Vector2 | null {
        const mapSize = gameApi.mapApi.getRealMapSize();
        const visited = new Set<string>();
        const queue: Vector2[] = [currentPosition];
        const candidateTiles: Vector2[] = [];

        // 广度优先搜索寻找连通的区域
        while (queue.length > 0) {
            const pos = queue.shift()!;
            const key = `${pos.x},${pos.y}`;
            
            if (visited.has(key)) continue;
            visited.add(key);

            const tile = gameApi.mapApi.getTile(pos.x, pos.y);
            if (!tile) continue;

            const isTargetTerrain = isWater ? 
                tile.terrainType === TerrainType.Water :
                tile.terrainType !== TerrainType.Water;

            if (!isTargetTerrain) continue;

            // 如果这个点未被探索过，加入候选列表
            const exploredSet = isWater ? this.exploredWaterTiles : this.exploredLandTiles;
            if (!exploredSet.has(key) && !gameApi.mapApi.isVisibleTile(tile, playerData.name)) {
                candidateTiles.push(pos);
            }

            // 检查八个方向
            const directions = [
                new Vector2(pos.x + 1, pos.y),
                new Vector2(pos.x - 1, pos.y),
                new Vector2(pos.x, pos.y + 1),
                new Vector2(pos.x, pos.y - 1),
                new Vector2(pos.x + 1, pos.y + 1),
                new Vector2(pos.x - 1, pos.y - 1),
                new Vector2(pos.x + 1, pos.y - 1),
                new Vector2(pos.x - 1, pos.y + 1),
            ];

            for (const next of directions) {
                if (next.x < 0 || next.y < 0 || next.x >= mapSize.width || next.y >= mapSize.height) continue;
                
                // 限制搜索范围
                if (Math.abs(next.x - currentPosition.x) > WATER_SEARCH_RADIUS || 
                    Math.abs(next.y - currentPosition.y) > WATER_SEARCH_RADIUS) continue;

                const nextKey = `${next.x},${next.y}`;
                if (!visited.has(nextKey)) {
                    queue.push(next);
                }
            }
        }

        // 如果找到未探索的点，选择最近的一个
        if (candidateTiles.length > 0) {
            candidateTiles.sort((a, b) => {
                const distA = Math.pow(a.x - currentPosition.x, 2) + Math.pow(a.y - currentPosition.y, 2);
                const distB = Math.pow(b.x - currentPosition.x, 2) + Math.pow(b.y - currentPosition.y, 2);
                return distA - distB;
            });
            return candidateTiles[0];
        }

        return null;
    }

    /**
     * 标记点为已探索
     */
    private markTileExplored(position: Vector2, isWater: boolean) {
        const key = `${position.x},${position.y}`;
        if (isWater) {
            this.exploredWaterTiles.add(key);
        } else {
            this.exploredLandTiles.add(key);
        }
    }

    private checkUnitsStuck(gameApi: GameApi, scouts: any[]): boolean {
        const currentTick = gameApi.getCurrentTick();
        let allUnitsStuck = scouts.length > 0;

        scouts.forEach(unit => {
            const lastPosition = this.lastScoutPositions.get(unit.id);
            if (lastPosition) {
                const distance = Math.sqrt(
                    Math.pow(unit.tile.x - lastPosition.x, 2) + 
                    Math.pow(unit.tile.y - lastPosition.y, 2)
                );

                if (distance < MIN_MOVEMENT_THRESHOLD) {
                    // 单位没有显著移动
                    if (!this.stuckStartTime.has(unit.id)) {
                        this.stuckStartTime.set(unit.id, currentTick);
                        this.logger(`单位${unit.type}(${unit.id})可能被卡住了，开始计时`);
                    }
                } else {
                    // 单位有显著移动，重置卡住计时
                    if (this.stuckStartTime.has(unit.id)) {
                        this.logger(`单位${unit.type}(${unit.id})恢复移动`);
                        this.stuckStartTime.delete(unit.id);
                    }
                    allUnitsStuck = false;
                }
            }
            // 更新单位最后位置
            this.lastScoutPositions.set(unit.id, unit.tile);
        });

        // 检查是否所有单位都被卡住超过阈值时间
        if (allUnitsStuck) {
            const stuckTime = Math.min(...Array.from(this.stuckStartTime.values()));
            const timeStuck = currentTick - stuckTime;
            if (timeStuck >= STUCK_THRESHOLD_TICKS) {
                this.logger(`所有侦察单位被卡住${timeStuck}ticks，可能需要切换单位类型`);
                return true;
            }
        }

        return false;
    }

    private clearStuckTracking() {
        this.lastScoutPositions.clear();
        this.stuckStartTime.clear();
    }

    public _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const landScoutNames = ["ADOG", "DOG", "E1", "E2", "FV", "HTK"];
        const waterScoutNames = ["DEST"];
        
        const scoutNames = this.isWaterTarget ? waterScoutNames : landScoutNames;
        const scouts = this.getUnitsOfTypes(gameApi, ...scoutNames);

        this.logger(`当前侦察状态: ${this.isWaterTarget ? '水域' : '陆地'}侦察, 单位数量: ${scouts.length}`);
        if (scouts.length > 0) {
            const unitTypes = scouts.map(u => u.type).join(', ');
            this.logger(`可用侦察单位: ${unitTypes}`);
        }

        if ((matchAwareness.getSectorCache().getOverallVisibility() || 0) > 0.9) {
            this.logger(`地图可见度已达到90%以上，任务解散`);
            return disbandMission();
        }

        if (scouts.length === 0) {
            // Count the number of times the scout dies trying to uncover the current scoutTarget.
            if (this.scoutTarget && this.hadUnit) {
                this.attemptsOnCurrentTarget++;
                this.hadUnit = false;
                this.logger(`侦察单位损失，当前目标尝试次数: ${this.attemptsOnCurrentTarget}/${MAX_ATTEMPTS_PER_TARGET}`);
            }
            this.logger(`请求新的${this.isWaterTarget ? '水域' : '陆地'}侦察单位，优先级: ${this.priority}`);
            return requestUnits(scoutNames, this.priority);
        } else if (this.scoutTarget) {
            this.hadUnit = true;
            if (!this.scoutTargetIsPermanent) {
                const currentTick = gameApi.getCurrentTick();
                const timeSpent = currentTick - this.scoutTargetRefreshedAt;
                this.logger(`当前目标已花费时间: ${timeSpent}/${MAX_TICKS_PER_TARGET} ticks`);

                // 检查单位是否被卡住
                if (!this.isWaterTarget && this.checkUnitsStuck(gameApi, scouts)) {
                    this.logger(`陆地单位无法到达目标，尝试切换为水域侦察`);
                    this.isWaterTarget = true;
                    this.clearStuckTracking();
                    return requestUnits(waterScoutNames, this.priority);
                }
                
                if (this.attemptsOnCurrentTarget > MAX_ATTEMPTS_PER_TARGET) {
                    this.logger(
                        `目标(${this.scoutTarget.x},${this.scoutTarget.y})尝试次数过多: ${this.attemptsOnCurrentTarget}/${MAX_ATTEMPTS_PER_TARGET}，切换目标`,
                    );
                    this.setScoutTarget(null, 0, gameApi);
                    return noop();
                }
                if (currentTick > this.scoutTargetRefreshedAt + MAX_TICKS_PER_TARGET) {
                    this.logger(
                        `目标(${this.scoutTarget.x},${this.scoutTarget.y})超时: ${timeSpent}/${MAX_TICKS_PER_TARGET} ticks，切换目标`,
                    );
                    this.setScoutTarget(null, 0, gameApi);
                    return noop();
                }
            }
            const targetTile = gameApi.mapApi.getTile(this.scoutTarget.x, this.scoutTarget.y);
            if (!targetTile) {
                throw new Error(`目标地块(${this.scoutTarget.x},${this.scoutTarget.y})不存在`);
            }

            const isWaterTile = targetTile.terrainType === TerrainType.Water;
            if (isWaterTile !== this.isWaterTarget) {
                this.logger(`目标地形不匹配: 期望${this.isWaterTarget ? '水域' : '陆地'}，实际${isWaterTile ? '水域' : '陆地'}，切换目标`);
                this.setScoutTarget(null, 0, gameApi);
                return noop();
            }

            if (gameApi.getCurrentTick() > this.lastMoveCommandTick + SCOUT_MOVE_COOLDOWN_TICKS) {
                this.lastMoveCommandTick = gameApi.getCurrentTick();
                scouts.forEach((unit) => {
                    if (this.scoutTarget) {
                        this.logger(`命令单位${unit.type}(${unit.id})移动到目标(${this.scoutTarget.x},${this.scoutTarget.y})`);
                        actionsApi.orderUnits([unit.id], OrderType.AttackMove, this.scoutTarget.x, this.scoutTarget.y);
                    }
                });
                // Check that a scout is actually moving closer to the target.
                const distances = scouts.map((unit) => getDistanceBetweenTileAndPoint(unit.tile, this.scoutTarget!));
                const newMinDistance = Math.min(...distances);
                if (!this.scoutMinDistance || newMinDistance < this.scoutMinDistance) {
                    const improvement = this.scoutMinDistance ? (this.scoutMinDistance - newMinDistance).toFixed(2) : "N/A";
                    this.logger(
                        `单位接近目标，距离改善: ${improvement}（${newMinDistance.toFixed(2)} < ${this.scoutMinDistance?.toFixed(2) ?? "N/A"}），重置超时计时器`,
                    );
                    this.scoutTargetRefreshedAt = gameApi.getCurrentTick();
                    this.scoutMinDistance = newMinDistance;
                } else {
                    this.logger(`单位未接近目标，当前最小距离: ${newMinDistance.toFixed(2)}`);
                }
            }
            if (gameApi.mapApi.isVisibleTile(targetTile, playerData.name)) {
                this.logger(
                    `目标(${this.scoutTarget.x},${this.scoutTarget.y})侦察完成，切换到下一个目标`,
                );
                
                // 标记当前点为已探索，并尝试找下一个目标
                if (scouts.length > 0) {
                    this.markTileExplored(this.scoutTarget, this.isWaterTarget);
                    const nextTarget = this.findNextTarget(gameApi, this.scoutTarget, this.isWaterTarget, playerData);
                    if (nextTarget) {
                        this.logger(`找到新的${this.isWaterTarget ? '水域' : '陆地'}目标(${nextTarget.x},${nextTarget.y})`);
                        this.scoutTarget = nextTarget;
                        this.scoutTargetRefreshedAt = gameApi.getCurrentTick();
                        this.scoutMinDistance = undefined;
                        return noop();
                    } else {
                        this.logger(`当前${this.isWaterTarget ? '水域' : '陆地'}区域探索完毕，寻找新目标`);
                    }
                }
                
                this.setScoutTarget(null, gameApi.getCurrentTick(), gameApi);
            }
        } else {
            const nextScoutTarget = matchAwareness.getScoutingManager().getNewScoutTarget();
            if (!nextScoutTarget) {
                this.logger(`没有更多侦察目标，任务解散`);
                return disbandMission();
            }
            this.logger(`获取到新的侦察目标`);
            this.setScoutTarget(nextScoutTarget, gameApi.getCurrentTick(), gameApi);
        }
        return noop();
    }

    setScoutTarget(target: PrioritisedScoutTarget | null, currentTick: number, gameApi?: GameApi) {
        this.attemptsOnCurrentTarget = 0;
        this.scoutTargetRefreshedAt = currentTick;
        this.scoutTarget = target?.asVector2() ?? null;
        this.scoutMinDistance = undefined;
        this.scoutTargetIsPermanent = target?.isPermanent ?? false;
        
        // 如果有目标，检查目标类型
        if (this.scoutTarget && gameApi) {
            const targetTile = gameApi.mapApi.getTile(this.scoutTarget.x, this.scoutTarget.y);
            this.isWaterTarget = targetTile?.terrainType === TerrainType.Water ?? false;
            this.logger(`设置新的${this.isWaterTarget ? '水域' : '陆地'}侦察目标: ${this.scoutTarget.x},${this.scoutTarget.y}`);
        } else {
            this.isWaterTarget = false;
        }
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
