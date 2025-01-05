import { ActionsApi, GameApi, MovementZone, PlayerData, UnitData, Vector2 } from "@chronodivide/game-api";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
import { MissionFactory } from "../missionFactories.js";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import { DebugLogger, isOwnedByNeutral } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { NavalSquad } from "./squads/navalSquad.js";

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
const NAVAL_ATTACK_RADIUS = 15;
const NAVAL_UNIT_REQUEST_PRIORITY = 60;

/**
 * 海军任务 - 负责控制海军单位进行攻击和防御
 */
export class NavalMission extends Mission<NavalFailReason> {
    private squad: NavalSquad;
    private state: NavalMissionState = NavalMissionState.Preparing;
    private lastStateUpdateAt: number = 0;
    private lastLogTime: number = 0;
    private LOG_INTERVAL: number = 300;
    private hasRequestedInitialDest: boolean = false;  // 添加标记，记录是否已请求初始DEST

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
    }

    public getState() {
        return this.state;
    }

    public getPriority(): number {
        return this.missionPriority;
    }

    public getGlobalDebugText(): string {
        return `${NavalMissionState[this.state]} - ${this.squad.getGlobalDebugText()}`;
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
        );

        // 获取当前的DEST数量
        const destUnits = this.getUnitsMatchingByRule(gameApi, (r) => 
            r.name === "DEST"
        );

        // 定期输出调试信息
        if (currentTick - this.lastLogTime > this.LOG_INTERVAL) {
            console.log("[NavalMission] 状态:", NavalMissionState[this.state]);
            console.log("[NavalMission] 当前单位数:", navalUnits.length);
            console.log("[NavalMission] 当前DEST数:", destUnits.length);
            console.log("[NavalMission] 请求单位类型:", this.navalUnitTypes);
            this.lastLogTime = currentTick;
        }

        // 如果还没有请求过初始DEST，立即请求一艘
        if (!this.hasRequestedInitialDest) {
            console.log("[NavalMission] 请求初始探路DEST");
            this.hasRequestedInitialDest = true;
            return requestUnits(["DEST"], NAVAL_UNIT_REQUEST_PRIORITY + 10);  // 给予更高优先级
        }

        switch (this.state) {
            case NavalMissionState.Preparing: {
                // 如果没有单位,请求生产
                if (navalUnits.length === 0) {
                    return requestUnits(this.navalUnitTypes, NAVAL_UNIT_REQUEST_PRIORITY);
                }

                // 确保至少有一艘DEST
                if (destUnits.length === 0) {
                    console.log("[NavalMission] 补充DEST");
                    return requestUnits(["DEST"], NAVAL_UNIT_REQUEST_PRIORITY);
                }

                // 如果单位数量不足，继续请求
                if (navalUnits.length < 3) {  // 至少需要3艘船
                    return requestUnits(this.navalUnitTypes, NAVAL_UNIT_REQUEST_PRIORITY);
                }

                // 集结完成后开始进攻
                const centerOfMass = this.getCenterOfMass();
                if (centerOfMass && this.getMaxDistanceToCenterOfMass() && this.getMaxDistanceToCenterOfMass()! < NAVAL_ATTACK_RADIUS) {
                    this.logger(`NavalMission ${this.getUniqueName()} switching to attack mode`);
                    this.state = NavalMissionState.Attacking;
                }

                // 更新分队目标点
                this.squad.setTargetArea(this.rallyPoint);
                break;
            }

            case NavalMissionState.Attacking: {
                // 确保至少有一艘DEST
                if (destUnits.length === 0) {
                    console.log("[NavalMission] 补充DEST");
                    return requestUnits(["DEST"], NAVAL_UNIT_REQUEST_PRIORITY);
                }

                // 检查是否需要撤退
                const nearbyHostiles = matchAwareness
                    .getHostilesNearPoint2d(this.targetArea, this.attackRadius)
                    .map(({ unitId }) => gameApi.getUnitData(unitId))
                    .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

                // 如果敌人太多或者我方单位太少,撤退
                if (nearbyHostiles.length > navalUnits.length * 2) {
                    this.logger(`NavalMission ${this.getUniqueName()} retreating - enemy too strong`);
                    this.state = NavalMissionState.Retreating;
                    return disbandMission(NavalFailReason.DefenceTooStrong);
                }

                // 如果没有敌人,考虑解散任务
                if (nearbyHostiles.length === 0 && currentTick > this.lastStateUpdateAt + NAVAL_CHECK_INTERVAL_TICKS) {
                    this.logger(`NavalMission ${this.getUniqueName()} disbanding - no targets`);
                    return disbandMission(NavalFailReason.NoTargets);
                }

                // 如果单位数量不足，继续请求
                if (navalUnits.length < 3) {
                    return requestUnits(this.navalUnitTypes, NAVAL_UNIT_REQUEST_PRIORITY);
                }

                // 更新分队目标点
                this.squad.setTargetArea(this.targetArea);
                break;
            }

            case NavalMissionState.Retreating: {
                // 更新分队目标点为集结点
                this.squad.setTargetArea(this.rallyPoint);
                break;
            }
        }

        // 更新分队
        return this.squad.onAiUpdate(gameApi, actionsApi, actionBatcher, playerData, this, matchAwareness, this.logger);
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

        // 寻找水域目标
        const waterTargets = matchAwareness
            .getHostilesNearPoint2d(playerData.startLocation, 100)
            .map(({ unitId }) => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit))
            .filter((unit) => unit.rules.movementZone === MovementZone.Water);

        if (waterTargets.length > 0) {
            // 选择最近的水域目标作为攻击点
            const target = waterTargets[0];
            const targetPoint = new Vector2(target.tile.rx, target.tile.ry);

            const squadName = "naval_" + currentTick;

            // 创建一个新的海军任务
            const tryNaval = missionController.addMission(
                new NavalMission(
                    squadName,
                    NAVAL_MISSION_INITIAL_PRIORITY,
                    matchAwareness.getMainRallyPoint(),
                    targetPoint,
                    NAVAL_ATTACK_RADIUS,
                    ["DEST"],  // 驱逐舰、潜艇、航母、巡逻艇
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