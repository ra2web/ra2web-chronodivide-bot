import { GameApi, GameMath, PlayerData, TechnoRules } from "@chronodivide/game-api";
import { GlobalThreat } from "../threat/threat.js";
import { AiBuildingRules, getDefaultPlacementLocation, numBuildingsOwnedOfType } from "./buildingRules.js";

export class BasicGroundUnit implements AiBuildingRules {
    constructor(
        protected basePriority: number,
        protected baseAmount: number,
        protected antiGroundPower: number = 1,
        protected antiAirPower: number = 0,
        protected maxGlobalCount: number | null = null,
    ) {}

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        return undefined;
    }

    getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number {
        if (this.maxGlobalCount !== null) {
            const currentCount = game.getVisibleUnits(playerData.name, "self", (r) => r.name === technoRules.name).length;
            if (currentCount >= this.maxGlobalCount) {
                return 0;
            }
        }
        return 0;
    }

    getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number | null {
        return this.maxGlobalCount;
    }
}
