import {
    ActionsApi,
    AttackState,
    GameApi,
    GameMath,
    MovementZone,
    PlayerData,
    UnitData,
    Vector2,
    ZoneType,
} from "@chronodivide/game-api";
import { MatchAwareness } from "../../../awareness.js";
import { getAttackWeight, manageAttackMicro, manageMoveMicro } from "./common.js";
import { DebugLogger, isOwnedByNeutral, maxBy, minBy } from "../../../common/utils.js";
import { ActionBatcher, BatchableAction } from "../../actionBatcher.js";
import { Squad } from "./squad.js";
import { Mission, MissionAction, grabCombatants, noop } from "../../mission.js";

const TARGET_UPDATE_INTERVAL_TICKS = 10;

// Units must be in a certain radius of the center of mass before attacking.
// This scales for number of units in the squad though.
const MIN_GATHER_RADIUS = 5;

// If the radius expands beyond this amount then we should switch back to gathering mode.
const MAX_GATHER_RADIUS = 15;

const GATHER_RATIO = 10;

const ATTACK_SCAN_AREA = 15;

enum SquadState {
    Gathering,
    Attacking,
}

export class CombatSquad implements Squad {
    private lastCommand: number | null = null;
    private state = SquadState.Gathering;

    private debugLastTarget: string | undefined;

    private lastOrderGiven: { [unitId: number]: BatchableAction } = {};

    /**
     *
     * @param rallyArea the initial location to grab combatants
     * @param targetArea
     * @param radius
     */
    constructor(
        private rallyArea: Vector2,
        private targetArea: Vector2,
        private radius: number,
    ) {}

    public getGlobalDebugText(): string | undefined {
        return this.debugLastTarget ?? "<none>";
    }

    public setAttackArea(targetArea: Vector2) {
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
            const unitIds = mission.getUnitsMatchingByRule(gameApi, (r) => r.isSelectableCombatant);
            const units = unitIds
                .map((unitId) => gameApi.getUnitData(unitId))
                .filter((unit): unit is UnitData => !!unit);

            // Only use ground units for center of mass.
            const groundUnitIds = mission.getUnitsMatchingByRule(
                gameApi,
                (r) =>
                    r.isSelectableCombatant &&
                    (r.movementZone === MovementZone.Infantry ||
                        r.movementZone === MovementZone.Normal ||
                        r.movementZone === MovementZone.InfantryDestroyer),
            );

            if (this.state === SquadState.Gathering) {
                const requiredGatherRadius = GameMath.sqrt(groundUnitIds.length) * GATHER_RATIO + MIN_GATHER_RADIUS;
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
                    logger(`CombatSquad ${mission.getUniqueName()} switching back to attack mode (${maxDistance})`);
                    this.state = SquadState.Attacking;
                }
            } else {
                const targetPoint = this.targetArea || playerData.startLocation;
                const requiredGatherRadius = GameMath.sqrt(groundUnitIds.length) * GATHER_RATIO + MAX_GATHER_RADIUS;
                if (
                    centerOfMass &&
                    maxDistance &&
                    gameApi.mapApi.getTile(centerOfMass.x, centerOfMass.y) !== undefined &&
                    maxDistance > requiredGatherRadius
                ) {
                    // Switch back to gather mode
                    logger(`CombatSquad ${mission.getUniqueName()} switching back to gather (${maxDistance})`);
                    this.state = SquadState.Gathering;
                    return noop();
                }
                // Calculate each unit's range (primary weapon, or secondary weapon, or 5)
                const getRangeForUnit = (unit: UnitData) =>
                    unit.primaryWeapon?.maxRange ?? unit.secondaryWeapon?.maxRange ?? 5;
                const attackLeader = minBy(units, getRangeForUnit);

                // Dynamic scan radius: at least ATTACK_SCAN_AREA, if there are longer range units in the squad, use the maximum range
                const maxRangeUnit = maxBy(units, getRangeForUnit);
                const dynamicScanRadius = Math.max(
                    ATTACK_SCAN_AREA,
                    maxRangeUnit ? getRangeForUnit(maxRangeUnit) : ATTACK_SCAN_AREA,
                );
                if (!attackLeader) {
                    return noop();
                }

                // Pre-cache global hostile list (speed optimization)
                const globalHostilesRaw = matchAwareness
                    .getHostilesNearPoint2d(this.targetArea, dynamicScanRadius * 2)
                    .map(({ unitId }) => gameApi.getUnitData(unitId))
                    .filter((unit): unit is UnitData => !!unit && !isOwnedByNeutral(unit));

                for (const unit of units) {
                    const isEscortAA = ["FV", "HTK"].includes(unit.name);
                    const isUnderWaterUnit = ["SUB", "DLPH", "SQD"].includes(unit.name);
                    // Use each unit's own range as scan radius, ensuring long-range units (carriers, etc.) can find targets
                    const unitRange = getRangeForUnit(unit);
                    const unitScanRadius = Math.max(ATTACK_SCAN_AREA, unitRange);

                    const nearbyHostiles = globalHostilesRaw.filter((hostile) => {
                        const dist = GameMath.sqrt(
                            GameMath.pow(hostile.tile.rx - unit.tile.rx, 2) +
                                GameMath.pow(hostile.tile.ry - unit.tile.ry, 2),
                        );
                        return dist <= unitScanRadius;
                    });

                    // Escort AA behavior: only engage air targets, otherwise follow ground center of mass
                    if (isEscortAA) {
                        const airHostiles = nearbyHostiles.filter((h) => h.zone === ZoneType.Air);
                        const bestAir = maxBy(airHostiles, (target) => getAttackWeight(unit, target));
                        if (bestAir) {
                            this.submitActionIfNew(actionBatcher, manageAttackMicro(unit, bestAir));
                            this.debugLastTarget = `AA ${bestAir.id.toString()}`;
                        } else if (centerOfMass) {
                            // Tight follow to ground center of mass, do not spearhead forward
                            this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, centerOfMass));
                            this.debugLastTarget = `escort@${centerOfMass.x},${centerOfMass.y}`;
                        } else {
                            this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, targetPoint));
                            this.debugLastTarget = `escort->@${targetPoint.x},${targetPoint.y}`;
                        }
                        continue;
                    }
                    
                    if (isUnderWaterUnit) {
                        logger(`[NAVAL_DEBUG] Underwater unit ${unit.name}(id:${unit.id}) starting to find attack target (scan=${unitScanRadius})`);
                        logger(`[NAVAL_DEBUG]   Found ${nearbyHostiles.length} hostile targets within scan range`);
                        
                        nearbyHostiles.forEach((hostile, index) => {
                            const weight = getAttackWeight(unit, hostile);
                            const isNavalTarget = ["DEST", "AEGIS", "CARRIER", "SUB", "HYD", "DRED", "DLPH", "SQD"].includes(hostile.name);
                            logger(`[NAVAL_DEBUG]     Target ${index + 1}: ${hostile.name}(id:${hostile.id}) weight=${weight} is naval=${isNavalTarget}`);
                        });
                    }
                    
                    const bestUnit = maxBy(nearbyHostiles, (target) => getAttackWeight(unit, target));
                    if (bestUnit) {
                        if (isUnderWaterUnit) {
                            logger(`[NAVAL_DEBUG]   Choosing attack target: ${bestUnit.name}(id:${bestUnit.id})`);
                        }
                        this.submitActionIfNew(actionBatcher, manageAttackMicro(unit, bestUnit));
                        this.debugLastTarget = `Unit ${bestUnit.id.toString()}`;
                    } else {
                        if (isUnderWaterUnit) {
                            logger(`[NAVAL_DEBUG]   No suitable attack target found, moving to target point`);
                        }
                        this.submitActionIfNew(actionBatcher, manageMoveMicro(unit, targetPoint));
                        this.debugLastTarget = `@${targetPoint.x},${targetPoint.y}`;
                    }
                }
            }
        }
        return noop();
    }

    /**
     * Sends an action to the acitonBatcher if and only if the action is different from the last action we submitted to it.
     * Prevents spamming redundant orders, which affects performance and can also ccause the unit to sit around doing nothing.
     */
    private submitActionIfNew(actionBatcher: ActionBatcher, action: BatchableAction) {
        const lastAction = this.lastOrderGiven[action.unitId];
        if (!lastAction || !lastAction.isSameAs(action)) {
            actionBatcher.push(action);
            this.lastOrderGiven[action.unitId] = action;
        }
    }
}
