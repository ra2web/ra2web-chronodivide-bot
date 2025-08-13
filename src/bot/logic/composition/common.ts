import { ProductionApi, QueueType, TechnoRules } from "@chronodivide/game-api";

export type UnitComposition = {
    [unitType: string]: number;
};

/**
 * 创建单位建造检查器
 * @param productionApi 生产API
 * @returns 简单的canBuild函数
 */
export function createCanBuildChecker(productionApi: ProductionApi) {
    /**
     * 检查指定单位是否可以建造
     * @param unitName 单位名称（如 "E1", "MTNK", "JUMPJET" 等）
     * @returns 是否可以建造该单位
     */
    return function canBuild(unitName: string): boolean {
        // 检查所有生产队列类型
        const queueTypes = [
            QueueType.Structures,
            QueueType.Armory,
            QueueType.Infantry,
            QueueType.Vehicles,
            QueueType.Aircrafts,
            QueueType.Ships,
        ];
        
        for (const queueType of queueTypes) {
            try {
                const options = productionApi.getAvailableObjects(queueType);
                const found = options.some((option: TechnoRules) => option.name === unitName);
                if (found) {
                    return true;
                }
            } catch (error) {
                // 如果某个队列不可用，继续检查其他队列
                continue;
            }
        }
        
        return false;
    };
}
