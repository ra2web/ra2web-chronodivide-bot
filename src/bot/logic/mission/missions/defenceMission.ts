import { ActionsApi, GameApi, PlayerData, UnitData, Vector2 } from "@chronodivide/game-api";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import { Mission, MissionAction, grabCombatants, noop, releaseUnits, requestUnits } from "../mission.js";
import { MissionFactory } from "../missionFactories.js";
import { CombatSquad } from "./squads/combatSquad.js";
import { DebugLogger, isOwnedByNeutral } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { AttackMission } from "./attackMission.js";

export const MAX_PRIORITY = 100;
export const PRIORITY_INCREASE_PER_TICK_RATIO = 1.025;

/**
 * A mission that tries to defend a certain area.
 */
export class DefenceMission extends Mission<CombatSquad> {
    private squad: CombatSquad;

    constructor(
        uniqueName: string,
        private priority: number,
        rallyArea: Vector2,
        private defenceArea: Vector2,
        private radius: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        this.squad = new CombatSquad(rallyArea, defenceArea, radius);
    }

    _onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        // Dispatch missions.
        const foundTargets = matchAwareness
            .getHostilesNearPoint2d(this.defenceArea, this.radius)
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

        if (foundTargets.length === 0) {
            this.priority = 0;
            if (this.getUnitIds().length > 0) {
                this.logger(`(Defence Mission ${this.getUniqueName()}): No targets found, releasing units.`);
                return releaseUnits(this.getUnitIds());
            } else {
                return noop();
            }
        } else {
            const targetUnit = foundTargets[0];
            this.logger(
                `(Defence Mission ${this.getUniqueName()}): Focused on target ${targetUnit?.name} (${
                    foundTargets.length
                } found in area ${this.radius})`,
            );
            this.squad.setAttackArea(new Vector2(foundTargets[0].tile.rx, foundTargets[0].tile.ry));
            this.priority = MAX_PRIORITY; // Math.min(MAX_PRIORITY, this.priority * PRIORITY_INCREASE_PER_TICK_RATIO);
            return grabCombatants(playerData.startLocation, this.priority);
        }
        //return requestUnits(["E1", "E2", "FV", "HTK", "MTNK", "HTNK"], this.priority);
    }

    public getGlobalDebugText(): string | undefined {
        return this.squad.getGlobalDebugText() ?? "<none>";
    }

    public getPriority() {
        return this.priority;
    }
}

const DEFENCE_CHECK_TICKS = 30;

// Starting radius around the player's base to trigger defense.
const DEFENCE_STARTING_RADIUS = 10;
// Every game tick, we increase the defendable area by this amount.
const DEFENCE_RADIUS_INCREASE_PER_GAME_TICK = 0.001;

export class DefenceMissionFactory implements MissionFactory {
    private lastDefenceCheckAt = 0;

    constructor() {}

    getName(): string {
        return "DefenceMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        logger: DebugLogger,
    ): void {
        if (gameApi.getCurrentTick() < this.lastDefenceCheckAt + DEFENCE_CHECK_TICKS) {
            return;
        }
        this.lastDefenceCheckAt = gameApi.getCurrentTick();

        const defendableRadius =
            DEFENCE_STARTING_RADIUS + DEFENCE_RADIUS_INCREASE_PER_GAME_TICK * gameApi.getCurrentTick();
        const enemiesNearSpawn = matchAwareness
            .getHostilesNearPoint2d(playerData.startLocation, defendableRadius)
            .map((unit) => gameApi.getUnitData(unit.unitId))
            .filter((unit) => !isOwnedByNeutral(unit)) as UnitData[];

        if (enemiesNearSpawn.length > 0) {
            // Defence triggered: disband any non-locked (i.e. preparing) missions so their units can be reassigned to defence.
            missionController
                .getMissions()
                .filter((m) => m.isUnitsLocked() === false && !(m instanceof AttackMission && m.isNaval()))
                .forEach((m) => {
                    logger(`Disbanding preparing mission ${m.getUniqueName()} due to defence activation.`);
                    missionController.disbandMission(m.getUniqueName());
                });
            logger(
                `Starting defence mission, ${
                    enemiesNearSpawn.length
                } found in radius ${defendableRadius} (tick ${gameApi.getCurrentTick()})`,
            );
            missionController.addMission(
                new DefenceMission(
                    "globalDefence",
                    10,
                    matchAwareness.getMainRallyPoint(),
                    playerData.startLocation,
                    defendableRadius * 1.2,
                    logger,
                ),
            );
        }
    }

    onMissionFailed(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        failedMission: Mission<any>,
        failureReason: undefined,
        missionController: MissionController,
    ): void {}
}
