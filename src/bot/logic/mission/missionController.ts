// Meta-controller for forming and controlling missions.
// Missions are groups of zero or more units that aim to accomplish a particular goal.

import { ActionsApi, GameApi, GameObjectData, ObjectType, PlayerData, UnitData, Vector2 } from "@chronodivide/game-api";
import {
    Mission,
    MissionAction,
    MissionActionDisband,
    MissionActionGrabFreeCombatants,
    MissionActionReleaseUnits,
    MissionActionRequestSpecificUnits,
    MissionActionRequestUnits,
    MissionWithAction,
    isDisbandMission,
    isGrabCombatants,
    isReleaseUnits,
    isRequestSpecificUnits,
    isRequestUnits,
} from "./mission.js";
import { MatchAwareness } from "../awareness.js";
import { MissionFactory, createMissionFactories } from "./missionFactories.js";
import { ActionBatcher } from "./actionBatcher.js";
import { countBy, isSelectableCombatant } from "../common/utils.js";
import { Squad } from "./missions/squads/squad.js";
import { EventBus } from "../common/eventBus.js";

// `missingUnitTypes` priority decays by this much every update loop.
const MISSING_UNIT_TYPE_REQUEST_DECAY_MULT_RATE = 0.75;
const MISSING_UNIT_TYPE_REQUEST_DECAY_FLAT_RATE = 1;

export class MissionController {
    private missionFactories: MissionFactory[];
    private missions: Mission<any>[] = [];

    // A mapping of unit IDs to the missions they are assigned to. This may contain units that are dead, but
    // is periodically cleaned in the update loop.
    private unitIdToMission: Map<number, Mission<any>> = new Map();

    // A mapping of unit types to the highest priority requested for a mission.
    // This decays over time if requests are not 'refreshed' by mission.
    private requestedUnitTypes: Map<string, number> = new Map();

    // Tracks missions to be externally disbanded the next time the mission update loop occurs.
    private forceDisbandedMissions: string[] = [];

    constructor(private eventBus: EventBus, private logger: (message: string, sayInGame?: boolean) => void) {
        this.missionFactories = createMissionFactories(this.eventBus);
    }

    private updateUnitIds(gameApi: GameApi) {
        // Check for units in multiple missions, this shouldn't happen.
        this.unitIdToMission = new Map();
        this.missions.forEach((mission) => {
            const toRemove: number[] = [];
            mission.getUnitIds().forEach((unitId) => {
                if (this.unitIdToMission.has(unitId)) {
                    this.logger(`WARNING: unit ${unitId} is in multiple missions, please debug.`);
                } else if (!gameApi.getGameObjectData(unitId)) {
                    // say, if a unit was killed
                    toRemove.push(unitId);
                } else {
                    this.unitIdToMission.set(unitId, mission);
                }
            });
            toRemove.forEach((unitId) => mission.removeUnit(unitId));
        });
    }

    public onAiUpdate(
        gameApi: GameApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        matchAwareness: MatchAwareness,
    ) {
        // Remove inactive missions.
        this.missions = this.missions.filter((missions) => missions.isActive());

        this.updateUnitIds(gameApi);

        // Batch actions to reduce spamming of actions for larger armies.
        const actionBatcher = new ActionBatcher();

        // Poll missions for requested actions.
        const missionActions: MissionWithAction<any>[] = this.missions.map((mission) => ({
            mission,
            action: mission.onAiUpdate(gameApi, actionsApi, playerData, matchAwareness, actionBatcher),
        }));

        // Handle disbands and merges FIRST
        const disbandedMissions: Map<string, any> = new Map();
        const disbandedMissionsArray: { mission: Mission<any>; reason: any }[] = [];
        this.forceDisbandedMissions.forEach((name) => disbandedMissions.set(name, null));
        this.forceDisbandedMissions = [];
        missionActions.filter(isDisbandMission).forEach((a) => {
            this.logger(`Mission ${a.mission.getUniqueName()} disbanding as requested.`);
            a.mission.getUnitIds().forEach((unitId) => {
                this.unitIdToMission.delete(unitId);
                actionsApi.setUnitDebugText(unitId, undefined);
            });
            disbandedMissions.set(a.mission.getUniqueName(), (a.action as MissionActionDisband).reason);
        });

        // Remove disbanded missions immediately
        this.missions
            .filter((missions) => disbandedMissions.has(missions.getUniqueName()))
            .forEach((disbandedMission) => {
                const reason = disbandedMissions.get(disbandedMission.getUniqueName());
                this.logger(`mission disbanded: ${disbandedMission.getUniqueName()}, reason: ${reason}`);
                disbandedMissionsArray.push({ mission: disbandedMission, reason });
                disbandedMission.endMission(disbandedMissions.get(disbandedMission.getUniqueName()));
            });
        this.missions = this.missions.filter((missions) => !disbandedMissions.has(missions.getUniqueName()));

        // Then handle unit requests (releases, specific requests, type requests, grab requests)
        // Release units
        missionActions.filter(isReleaseUnits).forEach((a) => {
            a.action.unitIds.forEach((unitId) => {
                if (this.unitIdToMission.get(unitId)?.getUniqueName() === a.mission.getUniqueName()) {
                    this.removeUnitFromMission(a.mission, unitId, actionsApi);
                }
            });
        });

        // Request specific units by ID
        const unitIdToHighestRequest = missionActions.filter(isRequestSpecificUnits).reduce(
            (prev, missionWithAction) => {
                const { unitIds } = missionWithAction.action;
                unitIds.forEach((unitId) => {
                    if (prev.hasOwnProperty(unitId)) {
                        if (prev[unitId].action.priority > prev[unitId].action.priority) {
                            prev[unitId] = missionWithAction;
                        }
                    } else {
                        prev[unitId] = missionWithAction;
                    }
                });
                return prev;
            },
            {} as Record<number, MissionWithAction<MissionActionRequestSpecificUnits>>,
        );

        // Map of Mission ID to Unit Type to Count.
        const newMissionAssignments = Object.entries(unitIdToHighestRequest)
            .flatMap(([id, request]) => {
                const unitId = Number.parseInt(id);
                const unit = gameApi.getGameObjectData(unitId);
                const { mission: requestingMission } = request;
                const missionName = requestingMission.getUniqueName();
                if (!unit) {
                    this.logger(`mission ${missionName} requested non-existent unit ${unitId}`);
                    return [];
                }
                if (!this.unitIdToMission.has(unitId)) {
                    this.addUnitToMission(requestingMission, unit, actionsApi);
                    return [{ unitName: unit?.name, mission: requestingMission.getUniqueName() }];
                }
                return [];
            })
            .reduce(
                (acc, curr) => {
                    if (!acc[curr.mission]) {
                        acc[curr.mission] = {};
                    }
                    if (!acc[curr.mission][curr.unitName]) {
                        acc[curr.mission][curr.unitName] = 0;
                    }
                    acc[curr.mission][curr.unitName] = acc[curr.mission][curr.unitName] + 1;
                    return acc;
                },
                {} as Record<string, Record<string, number>>,
            );
        Object.entries(newMissionAssignments).forEach(([mission, assignments]) => {
            this.logger(
                `Mission ${mission} received: ${Object.entries(assignments)
                    .map(([unitType, count]) => unitType + " x " + count)
                    .join(", ")}`,
            );
        });

        // Request units by type - store the highest priority mission for each unit type.
        const unitTypeToHighestRequest = missionActions.filter(isRequestUnits).reduce(
            (prev, missionWithAction) => {
                const { unitNames } = missionWithAction.action;
                unitNames.forEach((unitName) => {
                    if (prev.hasOwnProperty(unitName)) {
                        if (prev[unitName].action.priority > prev[unitName].action.priority) {
                            prev[unitName] = missionWithAction;
                        }
                    } else {
                        prev[unitName] = missionWithAction;
                    }
                });
                return prev;
            },
            {} as Record<string, MissionWithAction<MissionActionRequestUnits>>,
        );

        // Request combat-capable units in an area
        const grabRequests = missionActions.filter(isGrabCombatants);

        // Find un-assigned units and distribute them among all the requesting missions.
        const unitIds = gameApi.getVisibleUnits(playerData.name, "self");

        type UnitWithMission = {
            unit: GameObjectData;
            mission: Mission<any> | undefined;
        };
        // List of units that are unassigned or not in a locked mission.
        const freeUnits: UnitWithMission[] = unitIds
            .map((unitId) => gameApi.getGameObjectData(unitId))
            .filter((unit): unit is GameObjectData => !!unit)
            .map((unit) => ({
                unit,
                mission: this.unitIdToMission.get(unit.id),
            }))
            .filter((unitWithMission) => !unitWithMission.mission || unitWithMission.mission.isUnitsLocked() === false);

        // Sort free units so that unassigned units get chosen before assigned (but unlocked) units.
        freeUnits.sort((u1, u2) => (u1.mission?.getPriority() ?? 0) - (u2.mission?.getPriority() ?? 0));

        type AssignmentWithType = { unitName: string; missionName: string; method: "type" | "grab" };
        const newAssignmentsByType = freeUnits
            .flatMap(({ unit: freeUnit, mission: donatingMission }) => {
                if (unitTypeToHighestRequest.hasOwnProperty(freeUnit.name)) {
                    const { mission: requestingMission } = unitTypeToHighestRequest[freeUnit.name];
                    if (donatingMission) {
                        if (
                            donatingMission === requestingMission ||
                            donatingMission.getPriority() > requestingMission.getPriority()
                        ) {
                            return [];
                        }
                        this.removeUnitFromMission(donatingMission, freeUnit.id, actionsApi);
                    }
                    this.logger(
                        `granting unit ${freeUnit.id}#${freeUnit.name} to mission ${requestingMission.getUniqueName()}`,
                    );
                    this.addUnitToMission(requestingMission, freeUnit, actionsApi);
                    delete unitTypeToHighestRequest[freeUnit.name];
                    return [
                        { unitName: freeUnit.name, missionName: requestingMission.getUniqueName(), method: "type" },
                    ] as AssignmentWithType[];
                } else if (grabRequests.length > 0) {
                    const grantedMission = grabRequests.find((request) => {
                        const canGrabUnit = isSelectableCombatant(freeUnit);
                        return (
                            canGrabUnit &&
                            request.action.point.distanceTo(new Vector2(freeUnit.tile.rx, freeUnit.tile.ry)) <=
                            request.action.radius
                        );
                    });
                    if (grantedMission) {
                        if (donatingMission) {
                            if (
                                donatingMission === grantedMission.mission ||
                                donatingMission.getPriority() > grantedMission.mission.getPriority()
                            ) {
                                return [];
                            }
                            this.removeUnitFromMission(donatingMission, freeUnit.id, actionsApi);
                        }
                        this.addUnitToMission(grantedMission.mission, freeUnit, actionsApi);
                        return [
                            {
                                unitName: freeUnit.name,
                                missionName: grantedMission.mission.getUniqueName(),
                                method: "grab",
                            },
                        ] as AssignmentWithType[];
                    }
                }
                return [];
            })
            .reduce(
                (acc, curr) => {
                    if (!acc[curr.missionName]) {
                        acc[curr.missionName] = {};
                    }
                    if (!acc[curr.missionName][curr.unitName]) {
                        acc[curr.missionName][curr.unitName] = { grab: 0, type: 0 };
                    }
                    acc[curr.missionName][curr.unitName][curr.method] =
                        acc[curr.missionName][curr.unitName][curr.method] + 1;
                    return acc;
                },
                {} as Record<string, Record<string, Record<"type" | "grab", number>>>,
            );
        Object.entries(newAssignmentsByType).forEach(([mission, assignments]) => {
            this.logger(
                `Mission ${mission} received: ${Object.entries(assignments)
                    .flatMap(([unitType, methodToCount]) =>
                        Object.entries(methodToCount)
                            .filter(([, count]) => count > 0)
                            .map(([method, count]) => unitType + " x " + count + " (by " + method + ")"),
                    )
                    .join(", ")}`,
            );
        });

        this.updateRequestedUnitTypes(unitTypeToHighestRequest);

        // Send all actions that can be batched together.
        actionBatcher.resolve(actionsApi);

        // Create dynamic missions.
        this.missionFactories.forEach((missionFactory) => {
            missionFactory.maybeCreateMissions(gameApi, playerData, matchAwareness, this, this.logger);
            disbandedMissionsArray.forEach(({ reason, mission }) => {
                missionFactory.onMissionFailed(gameApi, playerData, matchAwareness, mission, reason, this, this.logger);
            });
        });
    }

    private updateRequestedUnitTypes(
        missingUnitTypeToHighestRequest: Record<string, MissionWithAction<MissionActionRequestUnits>>,
    ) {
        // Decay the priority over time.
        const currentUnitTypes = Array.from(this.requestedUnitTypes.keys());
        for (const unitType of currentUnitTypes) {
            const newPriority =
                this.requestedUnitTypes.get(unitType)! * MISSING_UNIT_TYPE_REQUEST_DECAY_MULT_RATE -
                MISSING_UNIT_TYPE_REQUEST_DECAY_FLAT_RATE;
            if (newPriority > 0.5) {
                this.requestedUnitTypes.set(unitType, newPriority);
            } else {
                this.requestedUnitTypes.delete(unitType);
            }
        }
        // Add the new missing units to the priority set, if the request is higher than the existing value.
        Object.entries(missingUnitTypeToHighestRequest).forEach(([unitType, request]) => {
            const currentPriority = this.requestedUnitTypes.get(unitType);
            this.requestedUnitTypes.set(
                unitType,
                currentPriority ? Math.max(currentPriority, request.action.priority) : request.action.priority,
            );
        });
    }

    /**
     * Returns the set of units that have been requested for production by the missions.
     *
     * @returns A map of unit type to the highest priority for that unit type.
     */
    public getRequestedUnitTypes(): Map<string, number> {
        return this.requestedUnitTypes;
    }

    private addUnitToMission(mission: Mission<any>, unit: GameObjectData, actionsApi: ActionsApi) {
        mission.addUnit(unit.id);
        this.unitIdToMission.set(unit.id, mission);
        actionsApi.setUnitDebugText(unit.id, mission.getUniqueName() + "_" + unit.id);
    }

    private removeUnitFromMission(mission: Mission<any>, unitId: number, actionsApi: ActionsApi) {
        mission.removeUnit(unitId);
        this.unitIdToMission.delete(unitId);
        actionsApi.setUnitDebugText(unitId, undefined);
    }

    /**
     * Attempts to add a mission to the active set.
     * @param mission
     * @returns The mission if it was accepted, or null if it was not.
     */
    public addMission(mission: Mission<any>): Mission<any> | null {
        if (this.missions.some((m) => m.getUniqueName() === mission.getUniqueName())) {
            // reject non-unique mission names
            return null;
        }
        this.logger(`Added mission: ${mission.getUniqueName()}`);
        this.missions.push(mission);
        return mission;
    }

    /**
     * Disband the provided mission on the next possible opportunity.
     */
    public disbandMission(missionName: string) {
        this.forceDisbandedMissions.push(missionName);
    }

    // return text to display for global debug
    public getGlobalDebugText(gameApi: GameApi): string {
        const unitsInMission = (unitIds: number[]) =>
            countBy(unitIds, (unitId) => gameApi.getGameObjectData(unitId)?.name);

        let globalDebugText = "";

        this.missions.forEach((mission) => {
            this.logger(
                `Mission ${mission.getUniqueName()}: ${Object.entries(unitsInMission(mission.getUnitIds()))
                    .map(([unitName, count]) => `${unitName} x ${count}`)
                    .join(", ")}`,
            );
            const missionDebugText = mission.getGlobalDebugText();
            if (missionDebugText) {
                globalDebugText += mission.getUniqueName() + ": " + missionDebugText + "\n";
            }
        });
        return globalDebugText;
    }

    public updateDebugText(actionsApi: ActionsApi) {
        this.missions.forEach((mission) => {
            mission
                .getUnitIds()
                .forEach((unitId) => actionsApi.setUnitDebugText(unitId, `${unitId}: ${mission.getUniqueName()}`));
        });
    }

    public getMissions() {
        return this.missions;
    }
}
