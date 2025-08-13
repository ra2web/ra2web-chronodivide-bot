import {
    ActionsApi,
    GameApi,
    PlayerData,
    ProductionApi,
    QueueStatus,
    QueueType,
    TechnoRules,
} from "@chronodivide/game-api";
import { GlobalThreat } from "../threat/threat";
import {
    TechnoRulesWithPriority,
    BUILDING_NAME_TO_RULES,
    DEFAULT_BUILDING_PRIORITY,
    getDefaultPlacementLocation,
} from "./buildingRules.js";
import { DebugLogger } from "../common/utils";
import { EventBus } from "../common/eventBus.js";

export const QUEUES = [
    QueueType.Structures,
    QueueType.Armory,
    QueueType.Infantry,
    QueueType.Vehicles,
    QueueType.Aircrafts,
    QueueType.Ships,
];

export const queueTypeToName = (queue: QueueType) => {
    switch (queue) {
        case QueueType.Structures:
            return "Structures";
        case QueueType.Armory:
            return "Armory";
        case QueueType.Infantry:
            return "Infantry";
        case QueueType.Vehicles:
            return "Vehicles";
        case QueueType.Aircrafts:
            return "Aircrafts";
        case QueueType.Ships:
            return "Ships";
        default:
            return "Unknown";
    }
};

type QueueState = {
    queue: QueueType;
    /** sorted in ascending order (last item is the topItem) */
    items: TechnoRulesWithPriority[];
    topItem: TechnoRulesWithPriority | undefined;
};

const REPAIR_CHECK_INTERVAL = 30;

export class QueueController {
    private queueStates: QueueState[] = [];
    private lastRepairCheckAt = 0;
    private navalMode: boolean = false;
    private lastCancelTicks: Map<QueueType, number> = new Map();

    constructor(private eventBus: EventBus) {
        this.eventBus.subscribe((ev) => {
            if (ev.type === "modeChanged") {
                this.navalMode = ev.isNaval;
            }
        });
    }

    public onAiUpdate(
        game: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        threatCache: GlobalThreat | null,
        unitTypeRequests: Map<string, number>,
        logger: (message: string) => void,
    ) {
        this.queueStates = QUEUES.map((queueType) => {
            const options = productionApi.getAvailableObjects(queueType);
            const items = this.getPrioritiesForBuildingOptions(
                game,
                options,
                threatCache,
                playerData,
                unitTypeRequests,
                logger,
                queueType,
            );
            const topItem = items.length > 0 ? items[items.length - 1] : undefined;
            return {
                queue: queueType,
                items,
                // only if the top item has a  priority above zero
                topItem: topItem && topItem.priority > 0 ? topItem : undefined,
            };
        });
        const totalWeightAcrossQueues = this.queueStates
            .map((decision) => decision.topItem?.priority!)
            .reduce((pV, cV) => pV + cV, 0);
        const totalCostAcrossQueues = this.queueStates
            .map((decision) => decision.topItem?.unit.cost!)
            .reduce((pV, cV) => pV + cV, 0);

        this.queueStates.forEach((decision) => {
            this.updateBuildQueue(
                game,
                productionApi,
                actionsApi,
                playerData,
                threatCache,
                decision.queue,
                decision.topItem,
                totalWeightAcrossQueues,
                totalCostAcrossQueues,
                logger,
            );
        });

        // Repair is simple - just repair everything that's damaged.
        if (playerData.credits > 0 && game.getCurrentTick() > this.lastRepairCheckAt + REPAIR_CHECK_INTERVAL) {
            game.getVisibleUnits(playerData.name, "self", (r) => r.repairable).forEach((unitId) => {
                const unit = game.getUnitData(unitId);
                if (!unit || !unit.hitPoints || !unit.maxHitPoints || unit.hasWrenchRepair) {
                    return;
                }
                if (unit.hitPoints < unit.maxHitPoints) {
                    actionsApi.toggleRepairWrench(unitId);
                }
            });
            this.lastRepairCheckAt = game.getCurrentTick();
        }
    }

    private updateBuildQueue(
        game: GameApi,
        productionApi: ProductionApi,
        actionsApi: ActionsApi,
        playerData: PlayerData,
        threatCache: GlobalThreat | null,
        queueType: QueueType,
        decision: TechnoRulesWithPriority | undefined,
        totalWeightAcrossQueues: number,
        totalCostAcrossQueues: number,
        logger: (message: string) => void,
    ): void {
        const myCredits = playerData.credits;

        const queueData = productionApi.getQueueData(queueType);
        if (queueData.status == QueueStatus.Idle) {
            // Start building the decided item.
            if (decision !== undefined) {
                logger(`Decision (${queueTypeToName(queueType)}): ${decision.unit.name}`);
                actionsApi.queueForProduction(queueType, decision.unit.name, decision.unit.type, 1);
            }
        } else if (queueData.status == QueueStatus.Ready && queueData.items.length > 0) {
            // Consider placing it.
            const objectReady: TechnoRules = queueData.items[0].rules;
            if (queueType == QueueType.Structures || queueType == QueueType.Armory) {
                let location: { rx: number; ry: number } | undefined = this.getBestLocationForStructure(
                    game,
                    playerData,
                    objectReady,
                );
                if (location !== undefined) {
                    logger(
                        `Completed: ${queueTypeToName(queueType)}: ${objectReady.name}, placing at ${location.rx},${
                            location.ry
                        }`,
                    );
                    actionsApi.placeBuilding(objectReady.name, location.rx, location.ry);
                } else {
                    logger(`Completed: ${queueTypeToName(queueType)}: ${objectReady.name} but nowhere to place it`);
                    if (objectReady.name === "GAYARD" || objectReady.name === "NAYARD") {
                        this.eventBus.publish({ type: "yardFailed", player: playerData.name });
                    }
                    actionsApi.unqueueFromProduction(queueType, objectReady.name, objectReady.type, 1);
                }
            }
        } else if (queueData.status == QueueStatus.Active && queueData.items.length > 0 && decision != null) {
            // Consider cancelling if something else is significantly higher priority than what is currently being produced.
            const currentProduction = queueData.items[0].rules;
            if (decision.unit != currentProduction) {
                // Changing our mind.
                let currentItemPriority = this.getPriorityForBuildingOption(
                    currentProduction,
                    game,
                    playerData,
                    threatCache,
                    queueType,
                );
                let newItemPriority = decision.priority;
                // debounce to prevent rapid changes in production
                const lastCancel = this.lastCancelTicks.get(queueType) ?? 0;
                const cooldownTicks = 900; // about 60 seconds
                if (newItemPriority > currentItemPriority * 3 && game.getCurrentTick() - lastCancel > cooldownTicks) {
                    logger(
                        `Dequeueing queue ${queueTypeToName(queueData.type)} unit ${currentProduction.name} because ${
                            decision.unit.name
                        } has 2x higher priority.`,
                    );
                    actionsApi.unqueueFromProduction(queueData.type, currentProduction.name, currentProduction.type, 1);
                    this.lastCancelTicks.set(queueType, game.getCurrentTick());
                }
            } else {
                // Not changing our mind, but maybe other queues are more important for now.
                if (totalCostAcrossQueues > myCredits && decision.priority < totalWeightAcrossQueues * 0.25) {
                    logger(
                        `Pausing queue ${queueTypeToName(queueData.type)} because weight is low (${
                            decision.priority
                        }/${totalWeightAcrossQueues})`,
                    );
                    actionsApi.pauseProduction(queueData.type);
                }
            }
        } else if (queueData.status == QueueStatus.OnHold) {
            // Consider resuming queue if priority is high relative to other queues.
            if (myCredits >= totalCostAcrossQueues) {
                logger(`Resuming queue ${queueTypeToName(queueData.type)} because credits are high`);
                actionsApi.resumeProduction(queueData.type);
            } else if (decision && decision.priority >= totalWeightAcrossQueues * 0.25) {
                logger(
                    `Resuming queue ${queueTypeToName(queueData.type)} because weight is high (${
                        decision.priority
                    }/${totalWeightAcrossQueues})`,
                );
                actionsApi.resumeProduction(queueData.type);
            }
        }
    }

    private getPrioritiesForBuildingOptions(
        game: GameApi,
        options: TechnoRules[],
        threatCache: GlobalThreat | null,
        playerData: PlayerData,
        unitTypeRequests: Map<string, number>,
        logger: DebugLogger,
        queueType: QueueType,
    ): TechnoRulesWithPriority[] {
        let priorityQueue: TechnoRulesWithPriority[] = [];
        options.forEach((option) => {
            // Enforce naval/land build caps within this bot instance
            const name = option.name;
            const isYard = name === "GAYARD" || name === "NAYARD";
            const isWarFactory = name === "GAWEAP" || name === "NAWEAP";
            if (isYard || isWarFactory) {
                const count = game.getVisibleUnits(playerData.name, "self", (r) => r.name === name).length;
                if (isYard) {
                    if (!this.navalMode) {
                        // Land mode: do not build any yard
                        return;
                    }
                    const yardCap = 4;
                    if (count >= yardCap) {
                        return;
                    }
                } else if (isWarFactory) {
                    const warCap = this.navalMode ? 1 : 4;
                    if (count >= warCap) {
                        return;
                    }
                }
            }
            const calculatedPriority = this.getPriorityForBuildingOption(option, game, playerData, threatCache, queueType);
            // Get the higher of the dynamic and the mission priority for the unit.
            const actualPriority = Math.max(
                calculatedPriority,
                unitTypeRequests.get(option.name) ?? calculatedPriority,
            );
            const randomizedPriority = actualPriority + game.generateRandom() * 0.00001;
            if (actualPriority > 0) {
                priorityQueue.push({ unit: option, priority: randomizedPriority });
            }
        });

        priorityQueue = priorityQueue.sort((a, b) => a.priority - b.priority);
        return priorityQueue;
    }

    private getPriorityForBuildingOption(
        option: TechnoRules,
        game: GameApi,
        playerStatus: PlayerData,
        threatCache: GlobalThreat | null,
        queueType: QueueType,
    ) {
        if (BUILDING_NAME_TO_RULES.has(option.name)) {
            let logic = BUILDING_NAME_TO_RULES.get(option.name)!;
            return logic.getPriority(game, playerStatus, option, threatCache);
        } else {
            // Enhanced fallback priority for unknown buildings
            const existingCount = game.getVisibleUnits(playerStatus.name, "self", (r) => r == option).length;
            
            // For Structures and Armory types, try to build at least one of each unknown building
            // This allows the bot to experiment with buildings not explicitly defined in BUILDING_NAME_TO_RULES
            if (queueType === QueueType.Structures || queueType === QueueType.Armory) {
                if (existingCount === 0) {
                    // Give a positive priority to build at least one of each unknown building
                    return 1;
                } else {
                    // Already have one, lower priority to avoid building multiple copies
                    return DEFAULT_BUILDING_PRIORITY - existingCount;
                }
            } else {
                // For other types (Infantry, Vehicles, etc.), use the original fallback logic
                return DEFAULT_BUILDING_PRIORITY - existingCount;
            }
        }
    }

    private getBestLocationForStructure(
        game: GameApi,
        playerData: PlayerData,
        objectReady: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        if (BUILDING_NAME_TO_RULES.has(objectReady.name)) {
            let logic = BUILDING_NAME_TO_RULES.get(objectReady.name)!;
            return logic.getPlacementLocation(game, playerData, objectReady);
        } else {
            // fallback placement logic
            return getDefaultPlacementLocation(game, playerData, playerData.startLocation, objectReady);
        }
    }

    public getGlobalDebugText(gameApi: GameApi, productionApi: ProductionApi) {
        const productionState = QUEUES.reduce((prev, queueType) => {
            if (productionApi.getQueueData(queueType).size === 0) {
                return prev;
            }
            const paused = productionApi.getQueueData(queueType).status === QueueStatus.OnHold;
            return (
                prev +
                " [" +
                queueTypeToName(queueType) +
                (paused ? " PAUSED" : "") +
                ": " +
                productionApi
                    .getQueueData(queueType)
                    .items.map((item) => item.rules.name + (item.quantity > 1 ? "x" + item.quantity : "")) +
                "]"
            );
        }, "");

        const queueStates = this.queueStates
            .filter((queueState) => queueState.items.length > 0)
            .map((queueState) => {
                const queueString = queueState.items
                    .map((item) => item.unit.name + "(" + Math.round(item.priority * 10) / 10 + ")")
                    .join(", ");
                return `${queueTypeToName(queueState.queue)} Prios: ${queueString}\n`;
            })
            .join("");

        return `Production: ${productionState}\n${queueStates}`;
    }
}
