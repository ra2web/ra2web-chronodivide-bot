import {
    ActionsApi,
    GameApi,
    PlayerData,
    ProductionApi,
    UnitData,
    Vector2,
} from "@chronodivide/game-api";
import { MatchAwareness } from "../../awareness.js";
import { MissionController } from "../missionController.js";
import {
    Mission,
    MissionAction,
    grabCombatants,
    noop,
    releaseUnits,
    disbandMission,
} from "../mission.js";
import { CombatSquad } from "./squads/combatSquad.js";
import { DebugLogger, isOwnedByNeutral } from "../../common/utils.js";
import { ActionBatcher } from "../actionBatcher.js";
import { MissionFactory } from "../missionFactories.js";

// ---------------------------------------------------------------------------
// Mission: Defend an individual Harvester
// ---------------------------------------------------------------------------

const HARVESTER_DEFENCE_RADIUS = 10;
const HARVESTER_DEFENCE_CHECK_TICKS = 600;
const MAX_PRIORITY = 100;

export class HarvesterDefenceMission extends Mission<null> {
    private squad: CombatSquad;
    private priority: number = 10;

    constructor(
        uniqueName: string,
        private readonly harvesterId: number,
        rallyArea: Vector2,
        private readonly radius: number,
        logger: DebugLogger,
    ) {
        super(uniqueName, logger);
        // targetArea is temporary – will be updated each tick to harvester position
        this.squad = new CombatSquad(rallyArea, rallyArea, radius);
    }

    _onAiUpdate(
        gameApi: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        actionBatcher: ActionBatcher,
    ): MissionAction {
        const harvester = gameApi.getUnitData(this.harvesterId);

        // Harvester destroyed or no longer ours → disband mission
        if (!harvester || harvester.owner !== playerData.name || !(harvester.rules as any)?.harvester) {
            this.logger(`Harvester ${this.harvesterId} lost – disbanding defence mission`);
            return disbandMission();
        }

        // Update defence/attack position to current harvester tile (harvesters are mobile)
        const defencePoint = new Vector2(harvester.tile.rx, harvester.tile.ry);
        this.squad.setAttackArea(defencePoint);

        // Let the squad manage micro first
        const updateFromSquad = this.squad.onAiUpdate(
            gameApi,
            actionsApi,
            actionBatcher,
            playerData,
            this,
            matchAwareness,
            this.logger,
        );
        if (updateFromSquad.type !== "noop") {
            return updateFromSquad;
        }

        // Detect hostiles near the harvester
        const foundTargets = matchAwareness
            .getHostilesNearPoint2d(defencePoint, this.radius)
            .map(({ unitId }) => gameApi.getUnitData(unitId))
            .filter((unit): unit is UnitData => !!unit)
            .filter((unit) => !isOwnedByNeutral(unit));

        if (foundTargets.length === 0) {
            // Area is clear – drop priority and, if we have units, release them
            this.priority = 0;
            if (this.getUnitIds().length > 0) {
                return releaseUnits(this.getUnitIds());
            }
            return noop();
        } else {
            // Under threat – bump priority and grab nearby combatants
            this.priority = MAX_PRIORITY;
            return grabCombatants(defencePoint, this.radius * 2);
        }
    }

    getGlobalDebugText(): string | undefined {
        return this.squad.getGlobalDebugText();
    }

    getPriority(): number {
        return this.priority;
    }
}

// ---------------------------------------------------------------------------
// Factory: Spawns HarvesterDefenceMission when needed
// ---------------------------------------------------------------------------

export class HarvesterDefenceMissionFactory implements MissionFactory {
    private lastCheckAt = 0;

    getName(): string {
        return "HarvesterDefenceMissionFactory";
    }

    maybeCreateMissions(
        gameApi: GameApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
        missionController: MissionController,
        productionApi: ProductionApi,
        logger: DebugLogger,
    ): void {
        if (gameApi.getCurrentTick() < this.lastCheckAt + HARVESTER_DEFENCE_CHECK_TICKS) {
            return;
        }
        this.lastCheckAt = gameApi.getCurrentTick();

        // Iterate over all visible harvesters we own
        const harvesterIds = gameApi.getVisibleUnits(playerData.name, "self", (r) => r.harvester);

        harvesterIds.forEach((harvId) => {
            const harvData = gameApi.getUnitData(harvId);
            if (!harvData) return;

            // Check if there are hostiles near this harvester
            const hostiles = matchAwareness.getHostilesNearPoint2d(
                new Vector2(harvData.tile.rx, harvData.tile.ry),
                HARVESTER_DEFENCE_RADIUS,
            );
            if (hostiles.length === 0) return;

            const missionName = `harvesterDefence_${harvId}`;
            // Prevent duplicate missions
            if (missionController.getMissions().some((m) => m.getUniqueName() === missionName)) {
                return;
            }

            const mission = new HarvesterDefenceMission(
                missionName,
                harvId,
                playerData.startLocation,
                HARVESTER_DEFENCE_RADIUS,
                logger,
            );
            missionController.addMission(mission);
        });
    }

    onMissionFailed(
        _gameApi: GameApi,
        _playerData: PlayerData,
        _matchAwareness: MatchAwareness,
        _failedMission: Mission<any>,
        _failureReason: any,
        _missionController: MissionController,
        _logger: DebugLogger,
    ): void {
        // No special handling
    }
}
