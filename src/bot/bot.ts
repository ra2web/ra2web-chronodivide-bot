import { ApiEventType, Bot, GameApi, ApiEvent, ObjectType, FactoryType, Size } from "@chronodivide/game-api";

import { determineMapBounds } from "./logic/map/map.js";
import { SectorCache } from "./logic/map/sector.js";
import { MissionController } from "./logic/mission/missionController.js";
import { QueueController } from "./logic/building/queueController.js";
import { MatchAwareness, MatchAwarenessImpl } from "./logic/awareness.js";
import { Countries, formatTimeDuration } from "./logic/common/utils.js";

const DEBUG_STATE_UPDATE_INTERVAL_SECONDS = 6;

// 每秒钟的游戏刻度数（基础速度下）
const NATURAL_TICK_RATE = 15;

export class SupalosaBot extends Bot {
    private tickRatio?: number;  // 控制AI更新频率的比率
    private knownMapBounds: Size | undefined;  // 地图边界
    private missionController: MissionController;  // 任务控制器
    private queueController: QueueController;  // 建造队列控制器
    private tickOfLastAttackOrder: number = 0;  // 上次攻击命令的时间点

    private matchAwareness: MatchAwareness | null = null;  // 战场态势感知

    constructor(
        name: string,
        country: Countries,
        private tryAllyWith: string[] = [],  // 尝试结盟的玩家名单
        private enableLogging = true,
    ) {
        super(name, country);
        this.missionController = new MissionController((message, sayInGame) => this.logBotStatus(message, sayInGame));
        this.queueController = new QueueController();
    }

    override onGameStart(game: GameApi) {
        // 计算AI的操作频率
        const gameRate = game.getTickRate();
        const botApm = 300;  // 机器人的每分钟操作次数
        const botRate = botApm / 60;
        this.tickRatio = Math.ceil(gameRate / botRate);

        // 初始化战场态势感知
        this.knownMapBounds = determineMapBounds(game.mapApi);
        const myPlayer = game.getPlayerData(this.name);

        this.matchAwareness = new MatchAwarenessImpl(
            null,
            new SectorCache(game.mapApi, this.knownMapBounds),
            myPlayer.startLocation,
            (message, sayInGame) => this.logBotStatus(message, sayInGame),
        );
        this.matchAwareness.onGameStart(game, myPlayer);

        // 尝试与指定玩家结盟
        this.tryAllyWith
            .filter((playerName) => playerName !== this.name)
            .forEach((playerName) => this.actionsApi.toggleAlliance(playerName, true));
    }

    override onGameTick(game: GameApi) {
        if (!this.matchAwareness) {
            return;
        }

        const threatCache = this.matchAwareness.getThreatCache();

        // 定期更新调试状态
        if ((game.getCurrentTick() / NATURAL_TICK_RATE) % DEBUG_STATE_UPDATE_INTERVAL_SECONDS === 0) {
            this.updateDebugState(game);
        }

        // 按照设定的频率执行AI逻辑
        if (game.getCurrentTick() % this.tickRatio! === 0) {
            const myPlayer = game.getPlayerData(this.name);

            this.matchAwareness.onAiUpdate(game, myPlayer);

            // 检查投降条件：当没有作战单位、MCV和生产建筑时
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
                this.logBotStatus(`No army or production left, quitting.`);
                this.actionsApi.quitGame();
            }

            // 每3个tick执行一次任务逻辑
            if (this.gameApi.getCurrentTick() % 3 === 0) {
                this.missionController.onAiUpdate(game, this.actionsApi, myPlayer, this.matchAwareness);
            }

            // 获取需要建造的单位类型
            const unitTypeRequests = this.missionController.getRequestedUnitTypes();

            // 执行建造逻辑
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
        this.logger.info(message);
        if (sayInGame) {
            const timestamp = this.getHumanTimestamp(this.gameApi);
            this.actionsApi.sayAll(`${timestamp}: ${message}`);
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
