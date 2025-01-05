import { ActionsApi, GameApi, MovementZone, OrderType, PlayerData, StanceType, UnitData, Vector2 } from "@chronodivide/game-api";
import { ActionBatcher, BatchableAction } from "../../actionBatcher.js";
import { MatchAwareness } from "../../../awareness.js";
import { Mission, MissionAction, noop } from "../../mission.js";
import { DebugLogger, isOwnedByNeutral } from "../../../common/utils.js";
import { Squad } from "./squad.js";
import { getDistanceBetweenUnits } from "../../../map/map.js";
import { manageAttackMicro, manageMoveMicro } from "./common.js";

const TARGET_UPDATE_INTERVAL_TICKS = 15;
const GATHER_RATIO = 2;
const MIN_GATHER_RADIUS = 3;
const MAX_GATHER_RADIUS = 6;
const ATTACK_SCAN_AREA = 15;

enum SquadState {
    Gathering,
    Attacking,
}

export class NavalSquad implements Squad {
    private lastCommand: number = 0;
    private state: SquadState = SquadState.Gathering;
    private targetArea: Vector2 | undefined;
    private debugLastTarget: string = "";
    private lastOrderGiven: Record<number, BatchableAction> = {};

    constructor(targetArea?: Vector2) {
        this.targetArea = targetArea;
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
        if (
            mission.getUnitIds().length > 0 &&
            (!this.lastCommand || gameApi.getCurrentTick() > this.lastCommand + TARGET_UPDATE_INTERVAL_TICKS)
        ) {
            this.lastCommand = gameApi.getCurrentTick();
            const centerOfMass = mission.getCenterOfMass();
            const maxDistance = mission.getMaxDistanceToCenterOfMass();
            
            // 获取所有海军单位
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
                    units.forEach((unit) => {
                        this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, centerOfMass));
                    });
                } else {
                    logger(`NavalSquad ${mission.getUniqueName()} switching to attack mode (${maxDistance})`);
                    this.state = SquadState.Attacking;
                }
            } else {
                const targetPoint = this.targetArea || playerData.startLocation;
                const requiredGatherRadius = Math.sqrt(unitIds.length) * GATHER_RATIO + MAX_GATHER_RADIUS;
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

                // 获取射程最短的单位作为攻击领导者
                const getRangeForUnit = (unit: UnitData) =>
                    unit.primaryWeapon?.maxRange ?? unit.secondaryWeapon?.maxRange ?? 5;
                const attackLeader = units.reduce((a, b) => (getRangeForUnit(a) < getRangeForUnit(b) ? a : b));
                
                if (!attackLeader) {
                    return noop();
                }

                // 在攻击范围内寻找敌方单位
                const nearbyHostiles = matchAwareness
                    .getHostilesNearPoint(attackLeader.tile.rx, attackLeader.tile.ry, ATTACK_SCAN_AREA)
                    .map(({ unitId }) => gameApi.getUnitData(unitId))
                    .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

                // 对每个海军单位分配目标
                for (const unit of units) {
                    const bestTarget = nearbyHostiles.reduce((best, current) => {
                        const currentWeight = getNavalAttackWeight(unit, current);
                        const bestWeight = best ? getNavalAttackWeight(unit, best) : -1;
                        return currentWeight > bestWeight ? current : best;
                    }, null as UnitData | null);

                    if (bestTarget) {
                        this.submitActionIfNew(actionBatcher, manageAttackMicro(unit, bestTarget));
                        this.debugLastTarget = `Unit ${bestTarget.id}`;
                    } else {
                        this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, targetPoint));
                        this.debugLastTarget = `@${targetPoint.x},${targetPoint.y}`;
                    }
                }
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
}

// 计算海军单位攻击权重
function getNavalAttackWeight(attacker: UnitData, target: UnitData): number {
    const distance = getDistanceBetweenUnits(attacker, target);
    const maxRange = attacker.primaryWeapon?.maxRange ?? attacker.secondaryWeapon?.maxRange ?? 5;
    
    // 基础权重从1.0开始
    let weight = 1.0;

    // 如果目标是海军单位,增加权重
    if (target.rules.movementZone === MovementZone.Water) {
        weight *= 1.5;
    }

    // 如果目标是两栖单位,也增加权重
    if (target.rules.movementZone === MovementZone.AmphibiousDestroyer) {
        weight *= 1.3;
    }

    // 如果目标在射程内,增加权重
    if (distance <= maxRange) {
        weight *= 1.2;
    }

    // 如果目标血量较低,增加权重
    const healthPercentage = target.rules.strength > 0 ? target.rules.points / target.rules.strength : 1;
    weight *= (2 - healthPercentage);

    // 距离越近权重越高,但不要太激进
    weight *= (1 - distance / (maxRange * 2));

    return weight;
} 