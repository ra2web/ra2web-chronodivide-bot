import { ActionsApi, GameApi, ObjectType, PlayerData, SideType, UnitData, Vector2, SpeedType, LandType } from "@chronodivide/game-api";
import { CombatSquad } from "./squads/combatSquad.js";
import { Mission, MissionAction, disbandMission, noop, requestUnits } from "../mission.js";
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
import { isPointReachable } from "../../map/pathfinding.js";
import { getNavalCompositions as getSovietNavalCompositions } from "../../composition/sovietNavalCompositions.js";
import { getNavalCompositions as getAlliedNavalCompositions } from "../../composition/alliedNavalCompositions.js";
import { getEscortComposition as getAlliedEscortComposition } from "../../composition/alliedEscortCompositions.js";
import { getEscortComposition as getSovietEscortComposition } from "../../composition/sovietEscortCompositions.js";
import { EventBus } from "../../common/eventBus.js";

export enum AttackFailReason {
    NoTargets = 0,
    DefenceTooStrong = 1,
}

enum AttackMissionState {
    Preparing = 0,
    Attacking = 1,
    Retreating = 2,
}

const NO_TARGET_RETARGET_TICKS = 450;
const NO_TARGET_IDLE_TIMEOUT_TICKS = 900;

function calculateTargetComposition(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    useNaval: boolean = false,
): UnitComposition {
    if (!playerData.country) {
        throw new Error(`player ${playerData.name} has no country`);
    }

    // If specified to use naval formation
    if (useNaval) {
        return playerData.country.side === SideType.Nod
            ? getSovietNavalCompositions(gameApi, playerData, matchAwareness)  // Soviet Navy
            : getAlliedNavalCompositions(gameApi, playerData, matchAwareness);  // Allied Navy
    }

    // Use land formation by default
    return playerData.country.side === SideType.Nod
        ? getSovietComposition(gameApi, playerData, matchAwareness)
        : getAlliedCompositions(gameApi, playerData, matchAwareness);
}

function calculateEscortComposition(
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
): UnitComposition {
    if (!playerData.country) {
        throw new Error(`player ${playerData.name} has no country`);
    }
    return playerData.country.side === SideType.Nod
        ? getSovietEscortComposition(gameApi, playerData, matchAwareness)
        : getAlliedEscortComposition(gameApi, playerData, matchAwareness);
}

const ATTACK_MISSION_PRIORITY_RAMP = 1.01;
const ATTACK_MISSION_MAX_PRIORITY = 50;

/**
 * A mission that tries to attack a certain area.
 */
export class AttackMission extends Mission<AttackFailReason> {
    private squad: CombatSquad;
    private hasTriedLandAttack: boolean = false;
    private landAttackFailCount: number = 0;
    private readonly MAX_LAND_ATTACK_ATTEMPTS = 2;  // Maximum land attack attempts
    private isNavalMission: boolean = false;
    // --- Naval yard management ---
    private navalModeStartTick: number = 0;
    private navalYardRequestAttempts: number = 0;
    private unsubscribeFromEvents: (() => void) | null = null;
    private readonly MAX_NAVAL_YARD_ATTEMPTS = 2;
    private readonly NAVAL_YARD_WAIT_TICKS = 4500;

    private lastTargetSeenAt = 0;
    private hasPickedNewTarget: boolean = false;

    private state: AttackMissionState = AttackMissionState.Preparing;

    constructor(
        uniqueName: string,
        private priority: number,
        private rallyArea: Vector2,
        private attackArea: Vector2,
        private radius: number,
        private composition: UnitComposition,
        logger: DebugLogger,
        private eventBus: EventBus,
    ) {
        super(uniqueName, logger);
        this.squad = new CombatSquad(rallyArea, attackArea, radius);
    }

    private shouldSwitchToNaval(gameApi: GameApi, playerData: PlayerData): boolean {
        // Debug information for naval switch decision
        this.logger(
            `shouldSwitchToNaval? tick=${gameApi.getCurrentTick()} | isNavalMission=${this.isNavalMission} | landFails=${this.landAttackFailCount}/${this.MAX_LAND_ATTACK_ATTEMPTS}`,
        );
        this.logger(
            `    rallyArea=(${this.rallyArea.x},${this.rallyArea.y}) attackArea=(${this.attackArea.x},${this.attackArea.y})`,
        );

        // If already naval mission, no need to switch
        if (this.isNavalMission) {
            this.logger("    Already naval mission, skip switch check.");
            return false;
        }

        const reachable = isPointReachable(gameApi, this.rallyArea, this.attackArea, SpeedType.Track, 6);
        this.logger(`    pathReachable=${reachable}`);

        // If target point is unreachable for land units
        if (!reachable) {
            const rallyTile = gameApi.mapApi.getTile(this.rallyArea.x, this.rallyArea.y);
            const attackTile = gameApi.mapApi.getTile(this.attackArea.x, this.attackArea.y);
            const reachable = isPointReachable(gameApi, this.rallyArea, this.attackArea, SpeedType.Track, 6);
            // Get all visible enemy units
            const allEnemyUnits = gameApi
                .getVisibleUnits(playerData.name, "enemy")
                .map((unitId) => gameApi.getUnitData(unitId))
                .filter((unit) => unit !== undefined) as UnitData[];

            // Filter units within attack area
            const unitsInAttackArea = allEnemyUnits.filter((unit) => {
                const distance = new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(this.attackArea);
                return distance <= 3;
            });

            // Print detailed information
            this.logger(`Attack Area (${this.attackArea.x},${this.attackArea.y}) radius ${this.radius} found ${unitsInAttackArea.length} enemy units:`);
            unitsInAttackArea.forEach((unit, index) => {
                const distance = new Vector2(unit.tile.rx, unit.tile.ry).distanceTo(this.attackArea);
                this.logger(`  ${index + 1}. ${unit.name}(id:${unit.id}) distance:${distance.toFixed(1)} type:${unit.type} health:${unit.hitPoints}/${unit.maxHitPoints}`);
            });
            this.logger(`Target point unreachable for land units, switching to naval formation | rallyTile type: ${rallyTile?.landType ?? 'unknown'} | attackTile type: ${attackTile?.landType ?? 'unknown'}`);
            return true;
        }

        // If land attacks failed multiple times
        if (this.landAttackFailCount >= this.MAX_LAND_ATTACK_ATTEMPTS) {
            this.logger("Too many land attack failures, switching to naval formation");
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
        switch (this.state) {
            case AttackMissionState.Preparing:
                return this.handlePreparingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
            case AttackMissionState.Attacking:
                return this.handleAttackingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
            case AttackMissionState.Retreating:
                return this.handleRetreatingState(gameApi, actionsApi, playerData, matchAwareness, actionBatcher);
        }
    }

    private handlePreparingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        // Check if need to switch to naval formation
        if (!this.isNavalMission && this.shouldSwitchToNaval(gameApi, playerData)) {
            // First switch to naval, start listening for shipyard failure events
            this.isNavalMission = true;
            this.eventBus.publish({ type: "modeChanged", player: playerData.name, isNaval: true });
            if (!this.unsubscribeFromEvents) {
                this.unsubscribeFromEvents = this.eventBus.subscribe((ev) => {
                    if (ev.type === "yardFailed" && ev.player === playerData.name) {
                        this.navalYardRequestAttempts++;
                    }
                });
            }
            this.navalModeStartTick = gameApi.getCurrentTick();
            this.navalYardRequestAttempts = 0;
            this.composition = calculateTargetComposition(gameApi, playerData, matchAwareness, true);
            this.logger("Switched to naval formation");
            this.logger(`[NAVAL_DEBUG] Naval formation composition: ${JSON.stringify(this.composition)}`);
            return noop();
        }

        const currentComposition: UnitComposition = countBy(this.getUnitsGameObjectData(gameApi), (unit) => unit.name);
        const escortCompositionTarget: UnitComposition = calculateEscortComposition(gameApi, playerData, matchAwareness);
        const currentEscortCounts: UnitComposition = Object.fromEntries(
            Object.keys(escortCompositionTarget).map((unitType) => [unitType, currentComposition[unitType] || 0]),
        );

        // -------- Check if land path is now reachable --------
        if (this.isNavalMission) {
            const reachableNow = isPointReachable(gameApi, this.rallyArea, this.attackArea, SpeedType.Track, 6);
            if (reachableNow) {
                this.logger("[NAVAL_DEBUG] Land path is now clear, switching back to land mode");
                if (this.unsubscribeFromEvents) { this.unsubscribeFromEvents(); this.unsubscribeFromEvents = null; }
                this.isNavalMission = false;
                this.eventBus.publish({ type: "modeChanged", player: playerData.name, isNaval: false });
                this.priority = ATTACK_MISSION_INITIAL_PRIORITY;
                this.composition = calculateTargetComposition(gameApi, playerData, matchAwareness, false);
                return noop();
            }
        }

        // -------- Naval yard build management --------
        const hasNavalYard = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.name === "GAYARD" || r.name === "NAYARD").length > 0;
        if (this.isNavalMission && !hasNavalYard) {
            // If waited too long or too many attempts, fall back to land mode
            if (
                gameApi.getCurrentTick() - this.navalModeStartTick > this.NAVAL_YARD_WAIT_TICKS ||
                this.navalYardRequestAttempts >= this.MAX_NAVAL_YARD_ATTEMPTS
            ) {
                this.logger(`[NAVAL_DEBUG] Naval yard unable to build for long time, falling back to land mode, attempts: ${this.navalYardRequestAttempts}, wait time: ${gameApi.getCurrentTick() - this.navalModeStartTick}`);
                if (this.unsubscribeFromEvents) { this.unsubscribeFromEvents(); this.unsubscribeFromEvents = null; }
                this.isNavalMission = false;
                this.eventBus.publish({ type: "modeChanged", player: playerData.name, isNaval: false });
                this.composition = calculateTargetComposition(gameApi, playerData, matchAwareness, false);
                return noop();
            }
            if (this.navalYardRequestAttempts < this.MAX_NAVAL_YARD_ATTEMPTS) {
                const yardName = playerData.country?.side === SideType.Nod ? "NAYARD" : "GAYARD";
                return requestUnits([yardName], this.priority * 100);
            }
        }

        // Debug current unit composition
        if (this.isNavalMission) {
            this.logger(`[NAVAL_DEBUG] Current naval unit composition: ${JSON.stringify(currentComposition)}`);
            this.logger(`[NAVAL_DEBUG] Target naval formation composition: ${JSON.stringify(this.composition)}`);
        }

        const missingUnits = Object.entries(this.composition).filter(([unitType, targetAmount]) => {
            return !currentComposition[unitType] || currentComposition[unitType] < targetAmount;
        });

        // Request main force first (blocking)
        if (missingUnits.length > 0) {
            if (this.isNavalMission) {
                this.logger(`[NAVAL_DEBUG] Missing naval units: ${JSON.stringify(missingUnits)}`);
            }
            this.priority = Math.min(this.priority * ATTACK_MISSION_PRIORITY_RAMP, ATTACK_MISSION_MAX_PRIORITY);
            const unitsToRequest = missingUnits.map(([unitName]) => unitName);
            this.logger(`Requesting units: ${JSON.stringify(unitsToRequest)}`);
            if (unitsToRequest.includes("HTK")) {
                this.logger(`[DEBUG] Requesting HTK`);
            }
            return requestUnits(
                unitsToRequest,
                this.priority,
            );
        } else {
            if (this.isNavalMission) {
                this.logger(`[NAVAL_DEBUG] Naval formation ready, starting attack phase`);
                this.priority = ATTACK_MISSION_INITIAL_PRIORITY; // reset own priority for future ramps
                this.state = AttackMissionState.Attacking;
            } else {
                // Before switching, request escort at the same priority as current main force priority
                const missingEscortUnits = Object.entries(escortCompositionTarget).filter(([unitType, targetAmount]) => {
                    return (currentEscortCounts[unitType] || 0) < targetAmount;
                });
                const mainPriorityForEscort = this.priority; // use same priority as main
                this.priority = ATTACK_MISSION_INITIAL_PRIORITY; // reset own priority for future ramps
                this.state = AttackMissionState.Attacking;
                if (missingEscortUnits.length > 0) {
                    return requestUnits(missingEscortUnits.map(([unitName]) => unitName), mainPriorityForEscort);
                }
                // If no escort missing, continue
            }

        }
        return noop();
    }

    private handleAttackingState(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ) {
        if (this.getUnitIds().length === 0) {
            if (!this.isNavalMission) {
                this.landAttackFailCount++;
                if (this.shouldSwitchToNaval(gameApi, playerData)) {
                    this.state = AttackMissionState.Preparing;
                    return noop();
                }
            }
            this.state = AttackMissionState.Retreating;
            return noop();
        }

        const foundTargets = matchAwareness
            .getHostilesNearPoint2d(this.attackArea, this.radius)
            .map((unit) => gameApi.getUnitData(unit.unitId))
            .filter((unit) => !isOwnedByNeutral(unit)) as UnitData[];

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

        if (foundTargets.length > 0) {
            this.lastTargetSeenAt = gameApi.getCurrentTick();
            this.hasPickedNewTarget = false;
        } else if (gameApi.getCurrentTick() > this.lastTargetSeenAt + NO_TARGET_IDLE_TIMEOUT_TICKS) {
            return disbandMission(AttackFailReason.NoTargets);
        } else if (
            !this.hasPickedNewTarget &&
            gameApi.getCurrentTick() > this.lastTargetSeenAt + NO_TARGET_RETARGET_TICKS
        ) {
            const newTarget = generateTarget(gameApi, playerData, matchAwareness, false, this.logger);
            if (newTarget) {
                this.squad.setAttackArea(newTarget);
                this.hasPickedNewTarget = true;
            }
        }

        if (!this.isNavalMission) {
            // While attacking, keep requesting missing escort at the same priority as main force (ensures production)
            const escortCompositionTarget: UnitComposition = calculateEscortComposition(gameApi, playerData, matchAwareness);
            if (Object.keys(escortCompositionTarget).length > 0) {
                const currentComposition: UnitComposition = countBy(this.getUnitsGameObjectData(gameApi), (unit) => unit.name);
                const currentEscortCounts: UnitComposition = Object.fromEntries(
                    Object.keys(escortCompositionTarget).map((unitType) => [unitType, currentComposition[unitType] || 0]),
                );
                const missingEscortUnits = Object.entries(escortCompositionTarget).filter(([unitType, targetAmount]) => {
                    return (currentEscortCounts[unitType] || 0) < targetAmount;
                });
                if (missingEscortUnits.length > 0) {
                    // Ramp priority for escorts if missing, similar to main force
                    this.priority = Math.min(this.priority * ATTACK_MISSION_PRIORITY_RAMP, ATTACK_MISSION_MAX_PRIORITY);
                    return requestUnits(missingEscortUnits.map(([unitName]) => unitName), this.priority);
                }
            }
        }
        return noop();
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

    public isNaval(): boolean {
        return this.isNavalMission;
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
    logger?: DebugLogger,
): Vector2 | null {
    const rallyPoint = matchAwareness.getMainRallyPoint();
    // Randomly decide between harvester and base.
    try {
        const tryFocusHarvester = gameApi.generateRandomInt(0, 1) === 0;
        const enemyUnits = gameApi
            .getVisibleUnits(playerData.name, "enemy")
            .map((unitId) => gameApi.getUnitData(unitId))
            .filter((u) => !!u && gameApi.getPlayerData(u.owner).isCombatant) as UnitData[];

        // Adjusted weight: penalise targets that ground units cannot reach (e.g. water targets).
        const computeWeight = (u: UnitData) => {
            let weight = getTargetWeight(u, tryFocusHarvester);
            try {
                // If rallyPoint -> target unreachable by Track, down-weight.
                if (!isPointReachable(gameApi, rallyPoint, new Vector2(u.tile.rx, u.tile.ry), SpeedType.Track, 6)) {
                    weight *= 0.3; // 70% penalty
                }
            } catch (err) {
                // Pathfinding error; treat as unreachable but avoid spamming logs.
                weight *= 0.3;
            }
            return weight;
        };

        const maxUnit = maxBy(enemyUnits, computeWeight);
        if (maxUnit) {
            logger?.(
                `generateTarget: picked visible enemy unit ${maxUnit.name} (id=${maxUnit.id}) at (${maxUnit.tile.rx},${maxUnit.tile.ry})`,
            );
            return new Vector2(maxUnit.tile.rx, maxUnit.tile.ry);
        }
        if (includeBaseLocations) {
            const mapApi = gameApi.mapApi;
            const enemyPlayers = gameApi
                .getPlayers()
                .map(playerName => gameApi.getPlayerData(playerName))
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
                const targetLoc = unexploredEnemyLocations[idx].startLocation;
                logger?.(`generateTarget: picked unexplored enemy base at (${targetLoc.x},${targetLoc.y})`);
                return targetLoc;
            }
        }
    } catch (err) {
        logger?.(`generateTarget: ERROR while selecting target: ${err}`);
        // error; fallthrough to other logic
    }

    // Fallback 1: target visible enemy MCV (undeployed construction vehicle)
    try {
        const baseUnitNames: string[] = gameApi.getGeneralRules().baseUnit ?? [];
        const enemyMcvs = gameApi
            .getVisibleUnits(playerData.name, "enemy", (r) => !!r.deploysInto && baseUnitNames.includes(r.name));
        if (enemyMcvs.length > 0) {
            const mcvId = enemyMcvs[0];
            const mcvData = gameApi.getUnitData(mcvId);
            if (mcvData) {
                logger?.(
                    `generateTarget: fallback to enemy MCV ${mcvData.name} (id=${mcvData.id}) at (${mcvData.tile.rx},${mcvData.tile.ry})`,
                );
                return new Vector2(mcvData.tile.rx, mcvData.tile.ry);
            }
        }
    } catch (_) {
        // ignore
    }

    // No suitable target
    return null;
}

// Number of ticks between attacking visible targets.
const VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS = 120;

// Number of ticks between attacking "bases" (enemy starting locations).
const BASE_ATTACK_COOLDOWN_TICKS = 1800;

const ATTACK_MISSION_INITIAL_PRIORITY = 1;

export class AttackMissionFactory implements MissionFactory {
    private lastAttackAt = -VISIBLE_TARGET_ATTACK_COOLDOWN_TICKS;

    constructor(private eventBus: EventBus) { }

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

        const attackArea = generateTarget(gameApi, playerData, matchAwareness, includeEnemyBases, logger);

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
                this.eventBus,
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
    ): void { }
}
