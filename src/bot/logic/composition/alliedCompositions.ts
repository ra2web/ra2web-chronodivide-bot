import { GameApi, PlayerData, ProductionApi } from "@chronodivide/game-api";
import { MatchAwareness } from "../awareness";
import { createCanBuildChecker, UnitComposition } from "./common.js";

export const getAlliedCompositions = (
    gameApi: GameApi,
    playerData: PlayerData,
    matchAwareness: MatchAwareness,
    productionApi: ProductionApi,
): UnitComposition => {
    const canBuild = createCanBuildChecker(productionApi);
    
    // 单个单位检查
    const canBuildInfantry = canBuild("E1");
    const canBuildSniper = canBuild("SNIPE");
    const canBuildRocketeer = canBuild("JUMPJET");
    const canBuildTankDestroyer = canBuild("TNKD");
    const canBuildTanks = canBuild("MTNK");
    const canBuildIFV = canBuild("FV");
    const canBuildPrismTank = canBuild("SREF");
    const canBuildMirageTank = canBuild("MGTK");

    const includeInfantry = !canBuildRocketeer && !canBuildPrismTank && canBuildInfantry;

    // 构建组合对象
    const composition: UnitComposition = {};

    // 基础步兵组合
    if (includeInfantry) {
        composition.E1 = 5;
    }

    // 狙击手
    if (canBuildSniper) {
        composition.SNIPE = 1;
    }

    // 坦克+IFV组合 (当没有火箭兵时)
    if (canBuildTanks && !canBuildRocketeer) {
        composition.MTNK = 6;
        if (canBuildIFV) {
            composition.FV = 1;
        }
    }

    // 坦克组合 (当有火箭兵时)
    if (canBuildTanks && canBuildRocketeer) {
        composition.MTNK = 3;
    }

    // 坦克杀手
    if (canBuildTankDestroyer) {
        composition.TNKD = 1;
    }

    // 火箭兵+IFV组合 (火箭兵可以攻击地面，保持为主力)
    if (canBuildRocketeer) {
        composition.JUMPJET = 6;
        if (canBuildIFV) {
            composition.FV = 1;
        }
    }

    // 高级单位组合 (作战实验室科技)
    if (canBuildPrismTank) {
        composition.SREF = 2;
        if (canBuildMirageTank) {
            composition.MGTK = 3;
        }
        if (canBuildIFV) {
            composition.FV = 1;
        }
    }

    return composition;
};
