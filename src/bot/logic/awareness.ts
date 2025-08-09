import { GameApi, GameObjectData, ObjectType, PlayerData, UnitData, Vector2, SpeedType, Tile } from "@chronodivide/game-api";
import { SectorCache } from "./map/sector";
import { GlobalThreat } from "./threat/threat";
import { calculateGlobalThreat } from "./threat/threatCalculator.js";
import { determineMapBounds, getDistanceBetweenPoints, getPointTowardsOtherPoint } from "./map/map.js";
import { Circle, Quadtree } from "@timohausmann/quadtree-ts";
import { ScoutingManager } from "./common/scout.js";

export type UnitPositionQuery = { x: number; y: number; unitId: number };

/**
 * The bot's understanding of the current state of the game.
 */
export interface MatchAwareness {
    /**
     * Returns the threat cache for the AI.
     */
    getThreatCache(): GlobalThreat | null;

    /**
     * Returns the sector visibility cache.
     */
    getSectorCache(): SectorCache;

    /**
     * Returns the enemy unit IDs in a certain radius of a point.
     * Warning: this may return non-combatant hostiles, such as neutral units.
     */
    getHostilesNearPoint2d(point: Vector2, radius: number): UnitPositionQuery[];

    /**
     * Returns the enemy unit IDs in a certain radius of a point.
     * Warning: this may return non-combatant hostiles, such as neutral units.
     */
    getHostilesNearPoint(x: number, y: number, radius: number): UnitPositionQuery[];

    /**
     * Returns the main rally point for the AI, which updates every few ticks.
     */
    getMainRallyPoint(): Vector2;

    onGameStart(gameApi: GameApi, playerData: PlayerData): void;

    /**
     * Update the internal state of the Ai.
     * @param gameApi
     * @param playerData
     */
    onAiUpdate(gameApi: GameApi, playerData: PlayerData): void;

    /**
     * True if the AI should initiate an attack.
     */
    shouldAttack(): boolean;

    getScoutingManager(): ScoutingManager;

    getGlobalDebugText(): string | undefined;
}

const SECTORS_TO_UPDATE_PER_CYCLE = 8;

const RALLY_POINT_UPDATE_INTERVAL_TICKS = 300;

const THREAT_UPDATE_INTERVAL_TICKS = 30;

type QTUnit = Circle<number>;

const rebuildQuadtree = (quadtree: Quadtree<QTUnit>, units: GameObjectData[]) => {
    quadtree.clear();
    units.forEach((unit) => {
        quadtree.insert(new Circle<number>({ x: unit.tile.rx, y: unit.tile.ry, r: 1, data: unit.id }));
    });
};

export class MatchAwarenessImpl implements MatchAwareness {
    private _shouldAttack: boolean = false;

    private hostileQuadTree: Quadtree<QTUnit>;
    private scoutingManager: ScoutingManager;

    constructor(
        private threatCache: GlobalThreat | null,
        private sectorCache: SectorCache,
        private mainRallyPoint: Vector2,
        private logger: (message: string, sayInGame?: boolean) => void,
    ) {
        const { width, height } = sectorCache.getMapBounds();
        this.hostileQuadTree = new Quadtree({ width, height });
        this.scoutingManager = new ScoutingManager(logger);
    }

    getHostilesNearPoint2d(point: Vector2, radius: number): UnitPositionQuery[] {
        return this.getHostilesNearPoint(point.x, point.y, radius);
    }

    getHostilesNearPoint(searchX: number, searchY: number, radius: number): UnitPositionQuery[] {
        const intersections = this.hostileQuadTree.retrieve(new Circle({ x: searchX, y: searchY, r: radius }));
        const result = intersections
            .map(({ x, y, data: unitId }) => ({ x, y, unitId: unitId! }))
            .filter(({ x, y }) => new Vector2(x, y).distanceTo(new Vector2(searchX, searchY)) <= radius)
            .filter(({ unitId }) => !!unitId);
        
        return result;
    }

    getThreatCache(): GlobalThreat | null {
        return this.threatCache;
    }
    getSectorCache(): SectorCache {
        return this.sectorCache;
    }
    getMainRallyPoint(): Vector2 {
        return this.mainRallyPoint;
    }
    getScoutingManager(): ScoutingManager {
        return this.scoutingManager;
    }

    shouldAttack(): boolean {
        return this._shouldAttack;
    }

    private checkShouldAttack(threatCache: GlobalThreat, threatFactor: number) {
        let scaledGroundPower = threatCache.totalAvailableAntiGroundFirepower * 1.1;
        let scaledGroundThreat =
            (threatFactor * threatCache.totalOffensiveLandThreat + threatCache.totalDefensiveThreat) * 1.1;

        let scaledAirPower = threatCache.totalAvailableAirPower * 1.1;
        let scaledAirThreat =
            (threatFactor * threatCache.totalOffensiveAntiAirThreat + threatCache.totalDefensiveThreat) * 1.1;

        return scaledGroundPower > scaledGroundThreat || scaledAirPower > scaledAirThreat;
    }

    public onGameStart(gameApi: GameApi, playerData: PlayerData) {
        this.scoutingManager.onGameStart(gameApi, playerData, this.sectorCache);
    }

    onAiUpdate(game: GameApi, playerData: PlayerData): void {
        const sectorCache = this.sectorCache;

        sectorCache.updateSectors(game.getCurrentTick(), SECTORS_TO_UPDATE_PER_CYCLE, game.mapApi, playerData);

        this.scoutingManager.onAiUpdate(game, playerData, sectorCache);

        let updateRatio = sectorCache?.getSectorUpdateRatio(game.getCurrentTick() - game.getTickRate() * 60);
        if (updateRatio && updateRatio < 1.0) {
            this.logger(`${updateRatio * 100.0}% of sectors updated in last 60 seconds.`);
        }

        // Build the quadtree, if this is too slow we should consider doing this periodically.
        const hostileUnitIds = game.getVisibleUnits(playerData.name, "enemy");
        try {
            const hostileUnits = hostileUnitIds
                .map((id) => game.getGameObjectData(id))
                .filter(
                    (gameObjectData: GameObjectData | undefined): gameObjectData is GameObjectData =>
                        gameObjectData !== undefined,
                );

            rebuildQuadtree(this.hostileQuadTree, hostileUnits);
        } catch (err) {
            // Hack. Will be fixed soon.
            console.error(`caught error`, hostileUnitIds);
        }

        if (game.getCurrentTick() % THREAT_UPDATE_INTERVAL_TICKS == 0) {
            let visibility = sectorCache?.getOverallVisibility();
            if (visibility) {
                this.logger(`${Math.round(visibility * 1000.0) / 10}% of tiles visible. Calculating threat.`);
                // Update the global threat cache
                this.threatCache = calculateGlobalThreat(game, playerData, visibility);

                // As the game approaches 2 hours, be more willing to attack. (15 ticks per second)
                const gameLengthFactor = Math.max(0, 1.0 - game.getCurrentTick() / (15 * 7200.0));
                this.logger(`Game length multiplier: ${gameLengthFactor}`);

                if (!this._shouldAttack) {
                    // If not attacking, make it harder to switch to attack mode by multiplying the opponent's threat.
                    this._shouldAttack = this.checkShouldAttack(this.threatCache, 1.25 * gameLengthFactor);
                    if (this._shouldAttack) {
                        this.logger(`Globally switched to attack mode.`);
                    }
                } else {
                    // If currently attacking, make it harder to switch to defence mode my dampening the opponent's threat.
                    this._shouldAttack = this.checkShouldAttack(this.threatCache, 0.75 * gameLengthFactor);
                    if (!this._shouldAttack) {
                        this.logger(`Globally switched to defence mode.`);
                    }
                }
            }
        }

        // Update rally point every few ticks.
        if (game.getCurrentTick() % RALLY_POINT_UPDATE_INTERVAL_TICKS === 0) {
            const enemyPlayers = game
                .getPlayers()
                .filter((p) => p !== playerData.name && !game.areAlliedPlayers(playerData.name, p));
            const enemy = game.getPlayerData(enemyPlayers[0]);
            // Use findPath to find 70% position of Track path from our startLocation to enemy.startLocation
            const startTile = selectPassableStartTile(game, playerData);
            const targetTile = game.mapApi.getTile(enemy.startLocation.x, enemy.startLocation.y);
            
            const fallbackRallyPoint = getPointTowardsOtherPoint(
                game,
                playerData.startLocation,
                enemy.startLocation,
                9, // 9 to fit the map like lostlake.map
                9,
                0,
            );

            if (startTile && targetTile) {
                try {
                    const path = game.mapApi.findPath(
                        SpeedType.Track,
                        false,
                        { tile: startTile, onBridge: false },
                        { tile: targetTile, onBridge: false },
                        {
                            bestEffort: true,
                        }
                    );
                    
                    if (path && path.length > 0) {
                        // Select point at 10% position of path
                        const midPointIndex = Math.floor(path.length / 10 * 9);
                        const midTile = path[midPointIndex].tile;
                        this.mainRallyPoint = new Vector2(midTile.rx, midTile.ry);
                        this.logger(`Rally point set to path 70% position: (${midTile.rx}, ${midTile.ry}), path length: ${path.length}`);
                    } else {
                        this.mainRallyPoint = fallbackRallyPoint;
                        this.logger(`No path found, using fallback rally point: (${this.mainRallyPoint.x}, ${this.mainRallyPoint.y})`);
                    }
                } catch (error) {
                    this.mainRallyPoint = fallbackRallyPoint;
                    this.logger(`Path finding error, using fallback rally point: ${error}`);
                }
            } else {
                this.mainRallyPoint = fallbackRallyPoint;
                this.logger(`Cannot get tiles, using fallback rally point`);
            }
        }
    }

    public getGlobalDebugText(): string | undefined {
        if (!this.threatCache) {
            return undefined;
        }
        return (
            `Threat LAND: Them ${Math.round(this.threatCache.totalOffensiveLandThreat)}, us: ${Math.round(
                this.threatCache.totalAvailableAntiGroundFirepower,
            )}.\n` +
            `Threat DEFENSIVE: Them ${Math.round(this.threatCache.totalDefensiveThreat)}, us: ${Math.round(
                this.threatCache.totalDefensivePower,
            )}.\n` +
            `Threat AIR: Them ${Math.round(this.threatCache.totalOffensiveAirThreat)}, us: ${Math.round(
                this.threatCache.totalAvailableAntiAirFirepower,
            )}.`
        );
    }
}

function selectPassableStartTile(game: GameApi, playerData: PlayerData): Tile | null {
    const sx = playerData.startLocation.x;
    const sy = playerData.startLocation.y;
    // radius 0..5, check (x±r, y) and (x, y±r)
    for (let r = 0; r <= 5; r++) {
        const candidates = [
            { x: sx, y: sy },
            { x: sx + r, y: sy },
            { x: sx - r, y: sy },
            { x: sx, y: sy + r },
            { x: sx, y: sy - r },
        ];
        for (const { x, y } of candidates) {
            const tile = game.mapApi.getTile(x, y);
            if (tile && game.mapApi.isPassableTile(tile, SpeedType.Track, false, false)) {
                return tile;
            }
        }
    }
    const fallback = game.mapApi.getTile(sx, sy);
    return fallback ?? null;
}
