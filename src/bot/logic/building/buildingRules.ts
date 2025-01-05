import {
    BuildingPlacementData,
    GameApi,
    GameMath,
    LandType,
    ObjectType,
    PlayerData,
    Rectangle,
    Size,
    TechnoRules,
    Tile,
    Vector2,
} from "@chronodivide/game-api";
import { GlobalThreat } from "../threat/threat.js";
import { AntiGroundStaticDefence } from "./antiGroundStaticDefence.js";
import { ArtilleryUnit } from "./artilleryUnit.js";
import { BasicAirUnit } from "./basicAirUnit.js";
import { BasicBuilding } from "./basicBuilding.js";
import { BasicGroundUnit } from "./basicGroundUnit.js";
import { PowerPlant } from "./powerPlant.js";
import { ResourceCollectionBuilding } from "./resourceCollectionBuilding.js";
import { Harvester } from "./harvester.js";
import { uniqBy } from "../common/utils.js";
import { AntiAirStaticDefence } from "./antiAirStaticDefence.js";
import { NavalYard } from "./navalYard.js";
import { WaterAnalyzer } from "../map/waterAnalyzer.js";

export interface AiBuildingRules {
    getPriority(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number;

    getPlacementLocation(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
    ): { rx: number; ry: number } | undefined;

    getMaxCount(
        game: GameApi,
        playerData: PlayerData,
        technoRules: TechnoRules,
        threatCache: GlobalThreat | null,
    ): number | null;
}

export function numBuildingsOwnedOfType(game: GameApi, playerData: PlayerData, technoRules: TechnoRules): number {
    return game.getVisibleUnits(playerData.name, "self", (r) => r == technoRules).length;
}

export function numBuildingsOwnedOfName(game: GameApi, playerData: PlayerData, name: string): number {
    return game.getVisibleUnits(playerData.name, "self", (r) => r.name === name).length;
}

/**
 * Computes a rect 'centered' around a structure of a certain size with an additional radius (`adjacent`).
 * The radius is optionally expanded by the size of the new building.
 *
 * This is essentially the candidate placement around a given structure.
 *
 * @param point Top-left location of the inner rect.
 * @param t Size of the inner rect.
 * @param adjacent Amount to expand the building's inner rect by (so buildings must be adjacent by this many tiles)
 * @param newBuildingSize? Size of the new building
 * @returns
 */
function computeAdjacentRect(point: Vector2, t: Size, adjacent: number, newBuildingSize?: Size): Rectangle {
    return {
        x: point.x - adjacent - (newBuildingSize?.width || 0),
        y: point.y - adjacent - (newBuildingSize?.height || 0),
        width: t.width + 2 * adjacent + (newBuildingSize?.width || 0),
        height: t.height + 2 * adjacent + (newBuildingSize?.height || 0),
    };
}

function getAdjacentTiles(game: GameApi, range: Rectangle, onWater: boolean) {
    // use the bulk API to get all tiles from the baseTile to the (baseTile + range)
    const adjacentTiles = game.mapApi
        .getTilesInRect(range)
        .filter((tile) => !onWater || tile.landType === LandType.Water);
    return adjacentTiles;
}

export function getAdjacencyTiles(
    game: GameApi,
    playerData: PlayerData,
    technoRules: TechnoRules,
    onWater: boolean,
    minimumSpace: number,
): Tile[] {
    const placementRules = game.getBuildingPlacementData(technoRules.name);
    const { width: newBuildingWidth, height: newBuildingHeight } = placementRules.foundation;
    const tiles = [];
    const buildings = game.getVisibleUnits(playerData.name, "self", (r: TechnoRules) => r.type === ObjectType.Building);
    const removedTiles = new Set<string>();
    for (let buildingId of buildings) {
        const building = game.getUnitData(buildingId);
        if (!building?.rules?.baseNormal) {
            // This building is not considered for adjacency checks.
            continue;
        }
        const { foundation, tile } = building;
        const buildingBase = new Vector2(tile.rx, tile.ry);
        const buildingSize = {
            width: foundation?.width,
            height: foundation?.height,
        };
        const range = computeAdjacentRect(buildingBase, buildingSize, technoRules.adjacent, placementRules.foundation);
        const adjacentTiles = getAdjacentTiles(game, range, onWater);
        if (adjacentTiles.length === 0) {
            continue;
        }
        tiles.push(...adjacentTiles);

        // Prevent placing the new building on tiles that would cause it to overlap with this building.
        const modifiedBase = new Vector2(
            buildingBase.x - (newBuildingWidth - 1),
            buildingBase.y - (newBuildingHeight - 1),
        );
        const modifiedSize = {
            width: buildingSize.width + (newBuildingWidth - 1),
            height: buildingSize.height + (newBuildingHeight - 1),
        };
        const blockedRect = computeAdjacentRect(modifiedBase, modifiedSize, minimumSpace);
        const buildingTiles = adjacentTiles.filter((tile) => {
            return (
                tile.rx >= blockedRect.x &&
                tile.rx < blockedRect.x + blockedRect.width &&
                tile.ry >= blockedRect.y &&
                tile.ry < blockedRect.y + blockedRect.height
            );
        });
        buildingTiles.forEach((buildingTile) => removedTiles.add(buildingTile.id));
    }
    // Remove duplicate tiles.
    const withDuplicatesRemoved = uniqBy(tiles, (tile) => tile.id);
    // Remove tiles containing buildings and potentially area around them removed as well.
    return withDuplicatesRemoved.filter((tile) => !removedTiles.has(tile.id));
}

function getTileDistances(startPoint: Vector2, tiles: Tile[]) {
    return tiles
        .map((tile) => ({
            tile,
            distance: distance(tile.rx, tile.ry, startPoint.x, startPoint.y),
        }))
        .sort((a, b) => {
            return a.distance - b.distance;
        });
}

function distance(x1: number, y1: number, x2: number, y2: number) {
    var dx = x1 - x2;
    var dy = y1 - y2;
    let tmp = dx * dx + dy * dy;
    if (0 === tmp) {
        return 0;
    }
    return GameMath.sqrt(tmp);
}

export function getDefaultPlacementLocation(
    game: GameApi,
    playerData: PlayerData,
    idealPoint: Vector2,
    technoRules: TechnoRules,
    onWater: boolean = false,
    minSpace: number = 1,
    waterAnalyzer?: WaterAnalyzer,
): { rx: number; ry: number } | undefined {
    // Closest possible location near `startPoint`.
    const size: BuildingPlacementData = game.getBuildingPlacementData(technoRules.name);
    if (!size) {
        return undefined;
    }
    const tiles = getAdjacencyTiles(game, playerData, technoRules, onWater, minSpace);
    const tileDistances = getTileDistances(idealPoint, tiles);

    // 如果有水域分析器，按照朝向水域的程度对位置进行排序
    if (waterAnalyzer) {
        // 获取水域方向
        const waterDirection = waterAnalyzer.getBuildingExpansionDirection();
        if (waterDirection) {
            // 计算每个位置到水域的方向
            const tileScores = tileDistances.map(td => {
                const toWater = new Vector2(
                    waterDirection.x,
                    waterDirection.y
                );
                const tileVector = new Vector2(
                    td.tile.rx - idealPoint.x,
                    td.tile.ry - idealPoint.y
                );
                
                // 计算方向相似度（点积）
                const dotProduct = toWater.x * tileVector.x + toWater.y * tileVector.y;
                const waterLength = Math.sqrt(toWater.x * toWater.x + toWater.y * toWater.y);
                const tileLength = Math.sqrt(tileVector.x * tileVector.x + tileVector.y * tileVector.y);
                const cosAngle = dotProduct / (waterLength * tileLength);

                // 结合距离和方向计算分数
                // distance 权重为0.4，方向权重为0.6
                const distanceScore = 1 - (td.distance / 100);  // 归一化距离分数
                const directionScore = (cosAngle + 1) / 2;  // 将cosAngle转换到0-1范围
                const score = distanceScore * 0.4 + directionScore * 0.6;

                return {
                    tile: td.tile,
                    score
                };
            });

            // 按分数排序
            tileScores.sort((a, b) => b.score - a.score);

            // 尝试按新的顺序放置建筑
            for (const tileScore of tileScores) {
                if (game.canPlaceBuilding(playerData.name, technoRules.name, tileScore.tile)) {
                    console.log("[BuildingRules] 选择建造位置，分数:", tileScore.score.toFixed(2), 
                              "位置:", tileScore.tile.rx, tileScore.tile.ry);
                    return tileScore.tile;
                }
            }
        }
    }

    // 如果没有水域分析器或找不到合适的位置，使用原有逻辑
    for (let tileDistance of tileDistances) {
        if (tileDistance.tile && game.canPlaceBuilding(playerData.name, technoRules.name, tileDistance.tile)) {
            return tileDistance.tile;
        }
    }
    return undefined;
}

// Priority 0 = don't build.
export type TechnoRulesWithPriority = { unit: TechnoRules; priority: number };

export const DEFAULT_BUILDING_PRIORITY = 0;

export const BUILDING_NAME_TO_RULES = new Map<string, AiBuildingRules>([
    // Allied
    ["GAPOWR", new PowerPlant()],
    ["GAREFN", new ResourceCollectionBuilding(10, 3)], // Refinery
    ["GAWEAP", new BasicBuilding(15, 1)], // War Factory
    ["GAPILE", new BasicBuilding(12, 1)], // Barracks
    ["CMIN", new Harvester(15, 4, 2)], // Chrono Miner
    ["GADEPT", new BasicBuilding(1, 1, 10000)], // Repair Depot
    ["GAAIRC", new BasicBuilding(10, 1, 500)], // Airforce Command
    ["AMRADR", new BasicBuilding(10, 1, 500)], // Airforce Command (USA)

    ["GATECH", new BasicBuilding(20, 1, 4000)], // Allied Battle Lab
    ["GAYARD", new NavalYard(25, 1)], // Naval Yard - 提高优先级到25

    ["GAPILL", new AntiGroundStaticDefence(2, 1, 5, 5)], // Pillbox
    ["ATESLA", new AntiGroundStaticDefence(2, 1, 10, 3)], // Prism Cannon
    ["NASAM", new AntiAirStaticDefence(2, 1, 5)], // Patriot Missile
    ["GAWALL", new AntiGroundStaticDefence(0, 0, 0, 0)], // Walls

    ["E1", new BasicGroundUnit(2, 2, 0.2, 0)], // GI
    ["ENGINEER", new BasicGroundUnit(1, 0, 0)], // Engineer
    ["MTNK", new BasicGroundUnit(10, 3, 2, 0)], // Grizzly Tank
    ["MGTK", new BasicGroundUnit(10, 1, 2.5, 0)], // Mirage Tank
    ["FV", new BasicGroundUnit(5, 2, 0.5, 1)], // IFV
    ["JUMPJET", new BasicAirUnit(10, 1, 1, 1)], // Rocketeer
    ["ORCA", new BasicAirUnit(7, 1, 2, 0)], // Rocketeer
    ["SREF", new ArtilleryUnit(10, 5, 3, 3)], // Prism Tank
    ["CLEG", new BasicGroundUnit(0, 0)], // Chrono Legionnaire (Disabled - we don't handle the warped out phase properly and it tends to bug both bots out)
    ["SHAD", new BasicGroundUnit(0, 0)],

    // Soviet
    ["NAPOWR", new PowerPlant()],
    ["NAREFN", new ResourceCollectionBuilding(10, 3)], // Refinery
    ["NAWEAP", new BasicBuilding(15, 1)], // War Factory
    ["NAHAND", new BasicBuilding(12, 1)], // Barracks
    ["HARV", new Harvester(15, 4, 2)], // War Miner
    ["NADEPT", new BasicBuilding(1, 1, 10000)], // Repair Depot
    ["NARADR", new BasicBuilding(10, 1, 500)], // Radar
    ["NANRCT", new PowerPlant()], // Nuclear Reactor
    ["NAYARD", new NavalYard(25, 1)], // Naval Yard - 提高优先级到25

    ["NATECH", new BasicBuilding(20, 1, 4000)], // Soviet Battle Lab

    ["NALASR", new AntiGroundStaticDefence(2, 1, 5, 5)], // Sentry Gun
    ["NAFLAK", new AntiAirStaticDefence(2, 1, 5)], // Flak Cannon
    ["TESLA", new AntiGroundStaticDefence(2, 1, 10, 3)], // Tesla Coil
    ["NAWALL", new AntiGroundStaticDefence(0, 0, 0, 0)], // Walls

    ["E2", new BasicGroundUnit(2, 2, 0.2, 0)], // Conscript
    ["SENGINEER", new BasicGroundUnit(1, 0, 0)], // Soviet Engineer
    ["FLAKT", new BasicGroundUnit(2, 2, 0.1, 0.3)], // Flak Trooper
    ["YURI", new BasicGroundUnit(1, 1, 1, 0)], // Yuri
    ["DOG", new BasicGroundUnit(1, 1, 0, 0)], // Soviet Attack Dog
    ["HTNK", new BasicGroundUnit(10, 3, 3, 0)], // Rhino Tank
    ["APOC", new BasicGroundUnit(6, 1, 5, 0)], // Apocalypse Tank
    ["HTK", new BasicGroundUnit(5, 2, 0.33, 1.5)], // Flak Track
    ["ZEP", new BasicAirUnit(5, 1, 5, 1)], // Kirov
    ["V3", new ArtilleryUnit(9, 10, 0, 3)], // V3 Rocket Launcher
]);
