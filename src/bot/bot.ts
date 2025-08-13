import { ApiEventType, Bot, GameApi, ApiEvent, ObjectType, FactoryType, Size } from "@chronodivide/game-api";
// enable file logging when dev in local
// import * as fs from "fs";
// import * as path from "path";

import { determineMapBounds } from "./logic/map/map.js";
import { SectorCache } from "./logic/map/sector.js";
import { MissionController } from "./logic/mission/missionController.js";
import { QueueController } from "./logic/building/queueController.js";
import { MatchAwareness, MatchAwarenessImpl } from "./logic/awareness.js";
import { Countries, formatTimeDuration } from "./logic/common/utils.js";
import { EventBus } from "./logic/common/eventBus.js";

const DEBUG_STATE_UPDATE_INTERVAL_SECONDS = 6;

// Number of ticks per second at the base speed.
const NATURAL_TICK_RATE = 15;

export class SupalosaBot extends Bot {
    private tickRatio?: number;
    private knownMapBounds: Size | undefined;
    private missionController: MissionController;
    private queueController: QueueController;
    private tickOfLastAttackOrder: number = 0;

    private logFilePath: string | null = null;

    private matchAwareness: MatchAwareness | null = null;
    private eventBus = new EventBus();

    constructor(
        name: string,
        country: Countries,
        private tryAllyWith: string[] = [],
        private enableLogging = true,
    ) {
        super(name, country);
        this.missionController = new MissionController(this.eventBus, (message, sayInGame) => this.logBotStatus(message, sayInGame));
        this.queueController = new QueueController(this.eventBus);
    }

    override onGameStart(game: GameApi) {
        const gameRate = game.getTickRate();
        const botApm = 300;
        const botRate = botApm / 60;
        this.tickRatio = Math.ceil(gameRate / botRate);

        this.knownMapBounds = determineMapBounds(game.mapApi);
        const myPlayer = game.getPlayerData(this.name);

        this.matchAwareness = new MatchAwarenessImpl(
            null,
            new SectorCache(game.mapApi, this.knownMapBounds),
            myPlayer.startLocation,
            (message, sayInGame) => this.logBotStatus(message, sayInGame),
        );
        this.matchAwareness.onGameStart(game, myPlayer);

        this.logBotStatus(`Map bounds: ${this.knownMapBounds.width}, ${this.knownMapBounds.height}`);

        this.tryAllyWith
            .filter((playerName) => playerName !== this.name)
            .forEach((playerName) => this.actionsApi.toggleAlliance(playerName, true));

        // Create battle log file when dev in local
        // if (this.enableLogging) {
        //     try {
        //         const logDir = path.resolve(process.cwd(), "battle_logs");
        //         if (!fs.existsSync(logDir)) {
        //             fs.mkdirSync(logDir, { recursive: true });
        //         }
        //         const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        //         this.logFilePath = path.join(logDir, `battle-${timestamp}.log`);
        //         fs.writeFileSync(this.logFilePath, `=== Battle started at ${new Date().toISOString()} ===\n`);
        //     } catch (err) {
        //         // If FS is unavailable (e.g., browser env), silently ignore.
        //         this.logger.warn?.(`Unable to create battle log file: ${err}`);
        //         this.logFilePath = null;
        //     }
        // }
    }

    override onGameTick(game: GameApi) {
        if (!this.matchAwareness) {
            return;
        }

        const threatCache = this.matchAwareness.getThreatCache();

        if ((game.getCurrentTick() / NATURAL_TICK_RATE) % DEBUG_STATE_UPDATE_INTERVAL_SECONDS === 0) {
            this.updateDebugState(game);
        }

        if (game.getCurrentTick() % this.tickRatio! === 0) {
            const myPlayer = game.getPlayerData(this.name);

            this.matchAwareness.onAiUpdate(game, myPlayer);

            // hacky resign condition
            const armyUnits = game.getVisibleUnits(this.name, "self", (r) => r.isSelectableCombatant);
            const mcvUnits = game.getVisibleUnits(
                this.name,
                "self",
                (r) => !!r.deploysInto && game.getGeneralRules().baseUnit.includes(r.name),
            );
            const productionBuildings = game.getVisibleUnits(
                this.name,
                "self",
                (r) => r.type == ObjectType.Building && r.factory != FactoryType.None,
            );
            if (armyUnits.length == 0 && productionBuildings.length == 0 && mcvUnits.length == 0) {
                this.logBotStatus(`No army or production left, quitting. ${armyUnits}, ${productionBuildings}, ${mcvUnits}`);
                this.actionsApi.quitGame();
            }

            // Mission logic every 3 ticks
            if (this.gameApi.getCurrentTick() % 3 === 0) {
                this.missionController.onAiUpdate(game, this.productionApi, this.actionsApi, myPlayer, this.matchAwareness);
            }

            const unitTypeRequests = this.missionController.getRequestedUnitTypes();

            // Build logic.
            this.queueController.onAiUpdate(
                game,
                this.productionApi,
                this.actionsApi,
                myPlayer,
                threatCache,
                unitTypeRequests,
                (message) => this.logBotStatus(message),
            );
        }
    }

    private getHumanTimestamp(game: GameApi) {
        return formatTimeDuration(game.getCurrentTick() / NATURAL_TICK_RATE);
    }

    private logBotStatus(message: string, sayInGame: boolean = false) {
        if (!this.enableLogging) {
            return;
        }
        const gameTimestamp = this.getHumanTimestamp(this.gameApi);
        const formattedMsg = `[${gameTimestamp}] ${message}`;

        this.logger.info(formattedMsg);

        // enable file logging when dev in local
        // if (this.logFilePath) {
        //     try {
        //         fs.appendFileSync(this.logFilePath, `${formattedMsg}\n`);
        //     } catch (err) {
        //         // Silently ignore FS errors after initialisation.
        //     }
        // }

        if (sayInGame) {
            this.actionsApi.sayAll(`${gameTimestamp}: ${message}`);
        }
    }

    private updateDebugState(game: GameApi) {
        if (!this.getDebugMode()) {
            return;
        }
        // Update the global debug text.
        const myPlayer = game.getPlayerData(this.name);
        const harvesters = game.getVisibleUnits(this.name, "self", (r) => r.harvester).length;

        let globalDebugText = `Cash: ${myPlayer.credits} | Harvesters: ${harvesters}\n`;
        globalDebugText += this.queueController.getGlobalDebugText(this.gameApi, this.productionApi);
        globalDebugText += this.missionController.getGlobalDebugText(this.gameApi);
        globalDebugText += this.matchAwareness?.getGlobalDebugText();

        this.missionController.updateDebugText(this.actionsApi);

        // Tag enemy units with IDs
        game.getVisibleUnits(this.name, "enemy").forEach((unitId) => {
            this.actionsApi.setUnitDebugText(unitId, unitId.toString());
        });

        this.actionsApi.setGlobalDebugText(globalDebugText);
    }

    override onGameEvent(ev: ApiEvent) {
        switch (ev.type) {
            case ApiEventType.ObjectDestroy: {
                // Add to the stalemate detection.
                if (ev.attackerInfo?.playerName == this.name) {
                    this.tickOfLastAttackOrder += (this.gameApi.getCurrentTick() - this.tickOfLastAttackOrder) / 2;
                }
                break;
            }
            default:
                break;
        }
    }
}
