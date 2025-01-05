import { GameApi, PlayerData, TechnoRules, Vector2 } from "@chronodivide/game-api";
import { GlobalThreat } from "../threat/threat.js";
import { AiBuildingRules, getDefaultPlacementLocation, numBuildingsOwnedOfType } from "./buildingRules.js";
import { WaterAnalyzer } from "../map/waterAnalyzer.js";

/**
 * 造船厂建造规则
 */
export class NavalYard implements AiBuildingRules {
    private waterAnalyzer: WaterAnalyzer | null = null;
    private hasAnalyzedMap: boolean = false;
    private lastLogTime: number = 0;
    private LOG_INTERVAL: number = 300; // 每300个tick输出一次日志

    constructor(
        private basePriority: number,
        private maxNeeded: number,
    ) {}

    private initializeWaterAnalyzer(game: GameApi, playerData: PlayerData) {
        if (!this.hasAnalyzedMap) {
            this.waterAnalyzer = new WaterAnalyzer(game.mapApi);
            this.waterAnalyzer.updateDistanceToBase(playerData.startLocation);
            this.hasAnalyzedMap = true;
            console.log("[NavalYard] 初始化WaterAnalyzer完成");
            console.log("[NavalYard] 是否为水域地图:", this.waterAnalyzer.isNavalMap());
            console.log("[NavalYard] 水域区域数量:", this.waterAnalyzer.getWaterAreas().length);
            console.log("[NavalYard] 最佳造船厂位置:", this.waterAnalyzer.getBestShipyardLocation());
        }
    }

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined {
        this.initializeWaterAnalyzer(game, playerData);

        // 获取最佳造船厂位置
        const bestLocation = this.waterAnalyzer?.getBestShipyardLocation();
        if (!bestLocation) {
            if (game.getCurrentTick() - this.lastLogTime > this.LOG_INTERVAL) {
                console.log("[NavalYard] 未找到合适的造船厂位置");
                this.lastLogTime = game.getCurrentTick();
            }
            return undefined;
        }

        // 检查是否可以在该位置建造
        const canPlace = game.canPlaceBuilding(
            playerData.name, 
            technoRules.name, 
            game.mapApi.getTile(bestLocation.x, bestLocation.y)!
        );

        if (game.getCurrentTick() - this.lastLogTime > this.LOG_INTERVAL) {
            console.log("[NavalYard] 尝试建造位置:", bestLocation);
            console.log("[NavalYard] 是否可建造:", canPlace);
            this.lastLogTime = game.getCurrentTick();
        }

        if (canPlace) {
            return { rx: bestLocation.x, ry: bestLocation.y };
        }

        // 如果最佳位置不可用,尝试使用默认放置逻辑
        const defaultLocation = getDefaultPlacementLocation(
            game, 
            playerData, 
            bestLocation, 
            technoRules, 
            true,
            1,
            this.waterAnalyzer || undefined
        );
        
        if (game.getCurrentTick() - this.lastLogTime > this.LOG_INTERVAL) {
            console.log("[NavalYard] 默认位置:", defaultLocation);
        }
        return defaultLocation;
    }

    getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number {
        this.initializeWaterAnalyzer(game, playerData);

        // 如果不是水域地图,不建造造船厂
        if (!this.waterAnalyzer?.isNavalMap()) {
            if (game.getCurrentTick() - this.lastLogTime > this.LOG_INTERVAL) {
                console.log("[NavalYard] 不是水域地图，不建造造船厂");
                this.lastLogTime = game.getCurrentTick();
            }
            return 0;
        }

        const numOwned = numBuildingsOwnedOfType(game, playerData, technoRules);
        if (numOwned >= this.maxNeeded) {
            if (game.getCurrentTick() - this.lastLogTime > this.LOG_INTERVAL) {
                console.log("[NavalYard] 已达到最大数量限制:", numOwned);
                this.lastLogTime = game.getCurrentTick();
            }
            return 0;
        }

        // 如果有敌方海军单位,提高优先级
        const enemyNavalUnits = game.getVisibleUnits(playerData.name, "hostile", (r) => r.naval).length;
        const priority = enemyNavalUnits > 0 ? this.basePriority * 1.5 : this.basePriority;

        if (game.getCurrentTick() - this.lastLogTime > this.LOG_INTERVAL) {
            console.log("[NavalYard] 当前优先级:", priority);
            console.log("[NavalYard] 敌方海军单位数:", enemyNavalUnits);
            this.lastLogTime = game.getCurrentTick();
        }

        return priority;
    }

    getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number | null {
        return this.maxNeeded;
    }
} 