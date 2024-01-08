import { Agent, Bot, cdapi } from "@chronodivide/game-api";
import { SupalosaBot } from "./bot/bot.js";

async function main() {
    /*
    Ladder maps:
    CDR2            1v1             2_malibu_cliffs_le.map
    CDR2            1v1             4_country_swing_le_v2.map
    CDR2            1v1             mp01t4.map, large map, oil derricks
    CDR2            1v1             tn04t2.map, small map
    CDR2            1v1             mp10s4.map <- depth charge, naval map (not supported). Cramped in position 1.
    CDR2            1v1             heckcorners.map
    CDR2            1v1             4_montana_dmz_le.map
    CDR2            1v1             barrel.map
    
    Other maps:
    mp03t4 large map, no oil derricks
    mp02t2.map,mp06t2.map,mp11t2.map,mp08t2.map,mp21s2.map,mp14t2.map,mp29u2.map,mp31s2.map,mp18s3.map,mp09t3.map,mp01t4.map,mp03t4.map,mp05t4.map,mp10s4.map,mp12s4.map,mp13s4.map,mp19t4.map,
    mp15s4.map,mp16s4.map,mp23t4.map,mp33u4.map,mp34u4.map,mp17t6.map,mp20t6.map,mp25t6.map,mp26s6.map,mp30s6.map,mp22s8.map,mp27t8.map,mp32s8.map,mp06mw.map,mp08mw.map,mp14mw.map,mp29mw.map,
    mp05mw.map,mp13mw.map,mp15mw.map,mp16mw.map,mp23mw.map,mp17mw.map,mp25mw.map,mp30mw.map,mp22mw.map,mp27mw.map,mp32mw.map,mp09du.map,mp01du.map,mp05du.map,mp13du.map,mp15du.map,mp18du.map,
    mp24du.map,mp17du.map,mp25du.map,mp27du.map,mp32du.map,c1m1a.map,c1m1b.map,c1m1c.map,c1m2a.map,c1m2b.map,c1m2c.map,c1m3a.map,c1m3b.map,c1m3c.map,c1m4a.map,c1m4b.map,c1m4c.map,c1m5a.map,
    c1m5b.map,c1m5c.map,c2m1a.map,c2m1b.map,c2m1c.map,c2m2a.map,c2m2b.map,c2m2c.map,c2m3a.map,c2m3b.map,c2m3c.map,c2m4a.map,c2m4b.map,c2m4c.map,c2m5a.map,c2m5b.map,c2m5c.map,c3m1a.map,c3m1b.map,
    c3m1c.map,c3m2a.map,c3m2b.map,c3m2c.map,c3m3a.map,c3m3b.map,c3m3c.map,c3m4a.map,c3m4b.map,c3m4c.map,c3m5a.map,c3m5b.map,c3m5c.map,c4m1a.map,c4m1b.map,c4m1c.map,c4m2a.map,c4m2b.map,c4m2c.map,
    c4m3a.map,c4m3b.map,c4m3c.map,c4m4a.map,c4m4b.map,c4m4c.map,c4m5a.map,c4m5b.map,c4m5c.map,c5m1a.map,c5m1b.map,c5m1c.map,c5m2a.map,c5m2b.map,c5m2c.map,c5m3a.map,c5m3b.map,c5m3c.map,c5m4a.map,
    c5m4b.map,c5m4c.map,c5m5a.map,c5m5b.map,c5m5c.map,tn01t2.map,tn01mw.map,tn04t2.map,tn04mw.map,tn02s4.map,tn02mw.map,amazon01.map,eb1.map,eb2.map,eb3.map,eb4.map,eb5.map,invasion.map,arena.map,
    barrel.map,bayopigs.map,bermuda.map,break.map,carville.map,deadman.map,death.map,disaster.map,dustbowl.map,goldst.map,grinder.map,hailmary.map,hills.map,kaliforn.map,killer.map,lostlake.map,
    newhghts.map,oceansid.map,pacific.map,potomac.map,powdrkeg.map,rockets.map,roulette.map,round.map,seaofiso.map,shrapnel.map,tanyas.map,tower.map,tsunami.map,valley.map,xmas.map,yuriplot.map,
    cavernsofsiberia.map,countryswingfixed.map,4_country_swing_le_v2.map,dorado_descent_yr_port.mpr,dryheat.map,dunepatrolremake.map,heckbvb.map,heckcorners.map,heckgolden.mpr,heckcorners_b.map,
    heckcorners_b_golden.map,hecklvl.map,heckrvr.map,hecktvt.map,isleland.map,jungleofvietnam.map,2_malibu_cliffs_le.map,mojosprt.map,4_montana_dmz_le.map,6_near_ore_far.map,8_near_ore_far.map,
    offensedefense.map,ore2_startfixed.map,rekoool_fast_6players.mpr,rekoool_fast_8players.mpr,riverram.map,tourofegypt.map,unrepent.map,sinkswim_yr_port.map
    */
    const mapName = "mp03t4.map";
    // Bot names must be unique in online mode
    const timestamp = String(Date.now()).substr(-6);
    const firstBotName = `Joe${timestamp}`;
    const secondBotName = `Bob${timestamp}`;
    const thirdBotName = `Mike${timestamp}`;
    const fourthBotName = `Charlie${timestamp}`;

    await cdapi.init(process.env.MIX_DIR || "./");

    console.log("Server URL: " + process.env.SERVER_URL!);
    console.log("Client URL: " + process.env.CLIENT_URL!);

    /*
    Countries:
    0=Americans
    1=Alliance -> Korea
    2=French
    3=Germans
    4=British

    5=Africans -> Libya
    6=Arabs -> Iraq
    7=Confederation -> Cuba
    8=Russians
    */

    const onlineSettings = {
        online: true as true,
        serverUrl: process.env.SERVER_URL!,
        clientUrl: process.env.CLIENT_URL!,
        agents: [new SupalosaBot(firstBotName, "Americans"), { name: secondBotName, country: "French" }] as [
            Bot,
            ...Agent[],
        ],
    };

    const offlineSettings1v1 = {
        agents: [
            new SupalosaBot(firstBotName, "French", [], true).setDebugMode(true),
            new SupalosaBot(secondBotName, "Russians", [], false),
        ],
    };

    const offlineSettings2v2 = {
        agents: [
            new SupalosaBot(firstBotName, "French", [firstBotName], false),
            new SupalosaBot(secondBotName, "Russians", [firstBotName], true).setDebugMode(true),
            new SupalosaBot(thirdBotName, "Russians", [fourthBotName], false),
            new SupalosaBot(fourthBotName, "French", [thirdBotName], false),
        ],
    };

    const game = await cdapi.createGame({
        ...offlineSettings1v1,
        buildOffAlly: false,
        cratesAppear: false,
        credits: 10000,
        gameMode: cdapi.getAvailableGameModes(mapName)[0],
        gameSpeed: 6,
        mapName,
        mcvRepacks: true,
        shortGame: true,
        superWeapons: false,
        unitCount: 0,
    });
    while (!game.isFinished()) {
        await game.update();
    }

    game.saveReplay();
    game.dispose();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
