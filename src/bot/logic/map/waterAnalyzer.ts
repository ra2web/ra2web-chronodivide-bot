import { GameApi, MapApi, TerrainType, Vector2 } from "@chronodivide/game-api";

export interface WaterArea {
    center: Vector2;
    size: number;  // 水域大小(格子数)
    distanceToBase: number;  // 到基地的距离
    baseLocation?: Vector2;  // 基地位置
}

/**
 * 分析地图上的水域分布
 */
export class WaterAnalyzer {
    private waterAreas: WaterArea[] = [];
    private isWaterMap: boolean = false;
    private bestShipyardLocation: Vector2 | null = null;
    private lastAnalyzedTick: number = 0;
    private waterDirection: Vector2 | null = null;  // 记录水域大致方向
    private ANALYZE_INTERVAL = 300;  // 每300tick重新分析一次
    private baseLocation: Vector2 | null = null;

    constructor(private mapApi: MapApi) {
        this.analyzeWater();
    }

    /**
     * 定期更新水域分析
     */
    public updateAnalysis(currentTick: number, baseLocation: Vector2) {
        this.baseLocation = baseLocation;
        if (currentTick - this.lastAnalyzedTick >= this.ANALYZE_INTERVAL) {
            this.waterAreas = [];  // 清空旧的水域数据
            this.analyzeWater();
            this.updateDistanceToBase(baseLocation);
            this.lastAnalyzedTick = currentTick;
        }
    }

    /**
     * 获取建议的建筑延伸方向
     */
    public getBuildingExpansionDirection(): Vector2 | null {
        if (!this.waterDirection && this.baseLocation) {
            // 如果还没有找到水域方向，尝试计算
            const nearestWater = this.waterAreas
                .filter(area => area.size > 20)
                .sort((a, b) => a.distanceToBase - b.distanceToBase)[0];

            if (nearestWater) {
                // 从基地指向水域的方向
                this.waterDirection = new Vector2(
                    nearestWater.center.x - this.baseLocation.x,
                    nearestWater.center.y - this.baseLocation.y
                );
                console.log("[WaterAnalyzer] 发现水域方向:", this.waterDirection);
            }
        }
        return this.waterDirection;
    }

    private analyzeWater() {
        const mapSize = this.mapApi.getRealMapSize();
        const visited = new Set<string>();
        
        // 遍历地图寻找水域
        for (let x = 0; x < mapSize.width; x++) {
            for (let y = 0; y < mapSize.height; y++) {
                const key = `${x},${y}`;
                if (visited.has(key)) continue;

                const tile = this.mapApi.getTile(x, y);
                if (!tile || tile.terrainType !== TerrainType.Water) continue;

                const waterArea = this.floodFillWater(x, y, visited);
                if (waterArea.size > 20) {
                    this.waterAreas.push(waterArea);
                    console.log("[WaterAnalyzer] 发现水域区域，大小:", waterArea.size, 
                              "位置:", waterArea.center,
                              "距离基地:", waterArea.distanceToBase);
                }
            }
        }

        this.isWaterMap = this.waterAreas.some(area => area.size > 100);
        console.log("[WaterAnalyzer] 水域区域总数:", this.waterAreas.length);
        console.log("[WaterAnalyzer] 是否为水域地图:", this.isWaterMap);
    }

    private floodFillWater(startX: number, startY: number, visited: Set<string>): WaterArea {
        const queue: Vector2[] = [new Vector2(startX, startY)];
        const waterTiles: Vector2[] = [];
        let size = 0;

        while (queue.length > 0) {
            const pos = queue.shift()!;
            const key = `${pos.x},${pos.y}`;
            
            if (visited.has(key)) continue;
            visited.add(key);

            const tile = this.mapApi.getTile(pos.x, pos.y);
            if (!tile || tile.terrainType !== TerrainType.Water) continue;

            size++;
            waterTiles.push(pos);

            // 检查四个方向
            const directions = [
                new Vector2(pos.x + 1, pos.y),
                new Vector2(pos.x - 1, pos.y),
                new Vector2(pos.x, pos.y + 1),
                new Vector2(pos.x, pos.y - 1),
            ];

            for (const next of directions) {
                const mapSize = this.mapApi.getRealMapSize();
                if (next.x < 0 || next.y < 0 || 
                    next.x >= mapSize.width || 
                    next.y >= mapSize.height) continue;

                queue.push(next);
            }
        }

        // 计算水域中心
        const center = new Vector2(
            Math.floor(waterTiles.reduce((sum, pos) => sum + pos.x, 0) / waterTiles.length),
            Math.floor(waterTiles.reduce((sum, pos) => sum + pos.y, 0) / waterTiles.length)
        );

        return {
            center,
            size,
            distanceToBase: 0,  // 需要后续更新
        };
    }

    /**
     * 更新水域到基地的距离
     */
    public updateDistanceToBase(baseLocation: Vector2) {
        for (const area of this.waterAreas) {
            area.distanceToBase = Math.sqrt(
                Math.pow(area.center.x - baseLocation.x, 2) + 
                Math.pow(area.center.y - baseLocation.y, 2)
            );
        }

        // 找到最适合建造造船厂的位置
        this.findBestShipyardLocation(baseLocation);
    }

    private findBestShipyardLocation(baseLocation: Vector2) {
        const SHIPYARD_SIZE = 4;  // 造船厂大小为4x4
        
        // 找到距离基地最近的大型水域
        const nearestWaterArea = this.waterAreas
            .filter(area => area.size > 100)
            .sort((a, b) => a.distanceToBase - b.distanceToBase)[0];

        if (!nearestWaterArea) {
            console.log("[WaterAnalyzer] 未找到足够大的水域区域");
            return;
        }

        console.log("[WaterAnalyzer] 开始寻找造船厂位置，水域中心:", nearestWaterArea.center);

        // 获取地图大小
        const mapSize = this.mapApi.getRealMapSize();
        let bestLocation: Vector2 | null = null;
        let minDistanceToBase = Infinity;

        // 在水域周围搜索
        const searchArea = {
            minX: Math.max(0, nearestWaterArea.center.x - 20),
            maxX: Math.min(mapSize.width - SHIPYARD_SIZE, nearestWaterArea.center.x + 20),
            minY: Math.max(0, nearestWaterArea.center.y - 20),
            maxY: Math.min(mapSize.height - SHIPYARD_SIZE, nearestWaterArea.center.y + 20)
        };

        console.log("[WaterAnalyzer] 搜索范围:", searchArea);

        // 用于调试的计数器
        let totalChecked = 0;
        let waterTilesFound = 0;
        let samplePoint = { x: 0, y: 0, waterCount: 0 };

        // 遍历搜索区域
        for (let x = searchArea.minX; x <= searchArea.maxX; x++) {
            for (let y = searchArea.minY; y <= searchArea.maxY; y++) {
                totalChecked++;
                
                // 检查4x4区域是否全部是水域
                let allWater = true;
                let waterCount = 0;
                
                // 先检查中心点是否是水域
                const centerTile = this.mapApi.getTile(x, y);
                if (!centerTile || centerTile.terrainType !== TerrainType.Water) {
                    continue;
                }
                
                // 检查4x4区域是否全部是水域
                for (let dx = 0; dx < SHIPYARD_SIZE && allWater; dx++) {
                    for (let dy = 0; dy < SHIPYARD_SIZE && allWater; dy++) {
                        const tile = this.mapApi.getTile(x + dx, y + dy);
                        if (!tile || tile.terrainType !== TerrainType.Water) {
                            allWater = false;
                        } else {
                            waterCount++;
                        }
                    }
                }

                // 记录一个样本点用于调试
                if (waterCount > samplePoint.waterCount) {
                    samplePoint = { x, y, waterCount };
                }

                if (waterCount > 0) {
                    waterTilesFound++;
                }

                // 如果不是全部水域，跳过这个位置
                if (!allWater || waterCount !== SHIPYARD_SIZE * SHIPYARD_SIZE) {
                    continue;
                }

                // 检查周围是否有我方建筑
                let hasNearbyBuilding = false;
                const BUILDING_CHECK_RADIUS = 3;  // 检查3格范围内是否有建筑

                // 检查4x4区域周围一圈是否有可建造的陆地
                for (let dx = -BUILDING_CHECK_RADIUS; dx <= SHIPYARD_SIZE + BUILDING_CHECK_RADIUS && !hasNearbyBuilding; dx++) {
                    for (let dy = -BUILDING_CHECK_RADIUS; dy <= SHIPYARD_SIZE + BUILDING_CHECK_RADIUS && !hasNearbyBuilding; dy++) {
                        // 跳过水域区域本身
                        if (dx >= 0 && dx < SHIPYARD_SIZE && dy >= 0 && dy < SHIPYARD_SIZE) {
                            continue;
                        }

                        const checkX = x + dx;
                        const checkY = y + dy;
                        const tile = this.mapApi.getTile(checkX, checkY);
                        
                        // 检查是否是可建造的陆地
                        if (tile && tile.terrainType === TerrainType.Clear) {
                            hasNearbyBuilding = true;
                            break;
                        }
                    }
                }

                if (!hasNearbyBuilding) {
                    continue;
                }

                // 计算到基地的距离
                const distanceToBase = Math.sqrt(
                    Math.pow(x - baseLocation.x, 2) + 
                    Math.pow(y - baseLocation.y, 2)
                );

                // 选择距离基地最近的位置
                if (distanceToBase < minDistanceToBase) {
                    minDistanceToBase = distanceToBase;
                    bestLocation = new Vector2(x, y);
                    console.log("[WaterAnalyzer] 找到潜在位置:", 
                        {x, y, 
                         distanceToBase: distanceToBase.toFixed(2),
                         waterCount,
                         hasNearbyBuilding: true
                        }
                    );
                }
            }
        }

        // 输出搜索统计信息
        console.log("[WaterAnalyzer] 搜索统计:", {
            totalChecked,
            waterTilesFound,
            samplePoint: `位置(${samplePoint.x},${samplePoint.y})有${samplePoint.waterCount}个水域格子`
        });

        if (bestLocation) {
            console.log("[WaterAnalyzer] 最终选择的造船厂位置:", bestLocation, 
                      "距离基地:", minDistanceToBase.toFixed(2));
        } else {
            console.log("[WaterAnalyzer] 未找到合适的造船厂位置");
        }

        this.bestShipyardLocation = bestLocation;
    }

    public isNavalMap(): boolean {
        return this.isWaterMap;
    }

    public getWaterAreas(): WaterArea[] {
        return this.waterAreas;
    }

    public getBestShipyardLocation(): Vector2 | null {
        return this.bestShipyardLocation;
    }

    /**
     * 检查一个位置是否适合作为建筑延伸点
     */
    public isGoodExpansionLocation(location: Vector2): boolean {
        if (!this.waterDirection) return true;  // 如果还没找到水域方向，任何位置都可以

        // 计算该位置是否朝向水域方向
        const nearestWater = this.waterAreas
            .filter(area => area.size > 20)
            .sort((a, b) => a.distanceToBase - b.distanceToBase)[0];

        if (!nearestWater) return true;

        // 计算位置到最近水域的向量
        const toWater = new Vector2(
            nearestWater.center.x - location.x,
            nearestWater.center.y - location.y
        );

        // 计算向量夹角的余弦值
        const dotProduct = this.waterDirection.x * toWater.x + this.waterDirection.y * toWater.y;
        const waterDirLength = Math.sqrt(this.waterDirection.x * this.waterDirection.x + this.waterDirection.y * this.waterDirection.y);
        const toWaterLength = Math.sqrt(toWater.x * toWater.x + toWater.y * toWater.y);
        const cosAngle = dotProduct / (waterDirLength * toWaterLength);

        // 如果夹角小于45度，认为是好的扩展位置
        return cosAngle > 0.7;
    }
} 