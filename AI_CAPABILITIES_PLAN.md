## AI 能力识别与角色归纳（可落地方案）

本方案基于 `@chronodivide/game-api` 的已验证字段，提供一套“读取规则 → 推断能力 → 归纳角色”的实现路线，避免硬编码单位枚举，支持航母/无畏/V3 等通过投射物/舰载机进行的间接攻击判定。

### 1. 可用 API 与字段（已在项目中使用验证）

- TechnoRules 读取与缓存
  - `getCachedTechnoRules(gameApi, unitId)`（见 `src/bot/logic/common/rulesCache.ts`）
  - 可取到 `rules.primary`, `rules.secondary` 两个武器名
- 规则查询
  - `gameApi.rulesApi.getWeapon(name): WeaponRules`（见 `src/bot/logic/threat/threatCalculator.ts`）
  - `gameApi.rulesApi.getProjectile(name): ProjectileRules`
- 武器/投射物关键字段（项目中已使用）
  - `WeaponRules.damage`, `WeaponRules.range`, `WeaponRules.rof`, `WeaponRules.projectile`
  - `ProjectileRules.isAntiGround`, `ProjectileRules.isAntiAir`
- 单位即时数据（项目中已使用）
  - `UnitData.primaryWeapon?.projectileRules`, `secondaryWeapon?.projectileRules`
  - `UnitData.zone`（`ZoneType.Ground/Air`），`UnitData.rules.underwater`（用于目标/单位特性判断）

以上字段均在现有代码中被引用，具备可落地性。

### 2. 能力识别输出结构

```ts
type UnitCapabilities = {
  canAttackGround: boolean;
  canAttackAir: boolean;
  effectiveRangeGround: number; // 最大对地射程（若可对地）
  effectiveRangeAir: number;    // 最大对空射程（若可对空）
  dpsGround: number;            // 近似对地 DPS（用 damage/rof 粗估）
  dpsAir: number;               // 近似对空 DPS
};
```

说明：射程/DPS 估算仅依赖 `WeaponRules.range/damage/rof`，这些字段已在 `threatCalculator.ts` 使用；若后续需要更精确（如 Burst/弹夹/延迟），可在可用时扩展。

### 3. 推断算法（无需枚举，优先走规则）

1) 拿到武器集合（优先走规则层，保证一致性）

```ts
const rules = getCachedTechnoRules(gameApi, unit.id);
const weaponNames = [rules?.primary, rules?.secondary].filter(Boolean) as string[];
const weapons: WeaponRules[] = weaponNames.map((n) => gameApi.rulesApi.getWeapon(n));
```

2) 计算对地/对空能力

```ts
function weaponCanAttack(weapon: WeaponRules, kind: "ground" | "air"): boolean {
  const proj = gameApi.rulesApi.getProjectile(weapon.projectile);
  return kind === "ground" ? !!proj?.isAntiGround : !!proj?.isAntiAir;
}

const canAttackGround = weapons.some((w) => weaponCanAttack(w, "ground"));
const canAttackAir    = weapons.some((w) => weaponCanAttack(w, "air"));
```

3) 计算射程与 DPS（按目标域拆分）

```ts
const effectiveRangeGround = Math.max(0, ...weapons.filter((w) => weaponCanAttack(w, "ground")).map((w) => w.range));
const effectiveRangeAir    = Math.max(0, ...weapons.filter((w) => weaponCanAttack(w, "air")).map((w) => w.range));

const dpsGround = weapons
  .filter((w) => weaponCanAttack(w, "ground"))
  .reduce((s, w) => s + (w.damage / Math.max(1, w.rof)), 0);
const dpsAir = weapons
  .filter((w) => weaponCanAttack(w, "air"))
  .reduce((s, w) => s + (w.damage / Math.max(1, w.rof)), 0);
```

备注：以上字段在项目中已有使用依据（见 `threatCalculator.ts`），不会引入未知属性。

### 4. 角色归纳（用于编队/微操策略）

在不依赖实体枚举的前提下，用能力与阈值归纳角色：

```ts
type UnitRole = "escortAA" | "brawler" | "artillery" | "skirmisher";

function inferRole(c: UnitCapabilities): UnitRole {
  if (c.canAttackAir && !c.canAttackGround) return "escortAA";        // 纯防空 → 护航
  if (c.canAttackGround && c.effectiveRangeGround >= 12) return "artillery"; // 远射程 → 炮兵/攻城
  if (c.canAttackGround && c.effectiveRangeGround >= 9)  return "skirmisher"; // 中远程 → 风筝
  return "brawler";                                                    // 近中程主战
}
```

阈值选型与现有地图/单位手感相关，可在实战中微调。上述逻辑完全依赖规则推导出的射程能力。

### 5. 集成计划（最小变更）

- 新增模块：`src/bot/logic/common/capabilities.ts`
  - 导出 `getUnitCapabilities(gameApi, unit): UnitCapabilities`
  - 内部实现严格使用：`getCachedTechnoRules` → `rulesApi.getWeapon` → `rulesApi.getProjectile`
- 在微操处替换现有判定：`CombatSquad`
  - 将 `unit.primaryWeapon?.projectileRules.isAntiGround/Air` 判定替换为 `getUnitCapabilities(...).canAttackGround/Air`
  - 纯防空（`escortAA`）在无空中目标时，默认“就近护航地面锚点/回集结”，避免单兵前压送掉
- 可选：基于 `inferRole` 调整“集火/风筝/站位”细节（不影响现有防御抢兵策略）

### 6. 性能与缓存

- 规则层读取走 `getCachedTechnoRules`，避免频繁 `getUnitData`
- 每 tick 内同一单位只计算一次能力（按 unitId 做结果缓存，随单位死亡或编队变更清理）
- 若后续引入更细粒度字段（如范围伤/导引），同样只在规则层读取一次

### 7. 航母/无畏/V3 等“代理型攻击”

大多数情况下，其 `WeaponRules.projectile → ProjectileRules.isAntiGround` 即可识别为对地；
若出现特例（规则里无法反映），可在最小范围内提供“数据覆盖”映射（非必须，默认不启用）。

---

如需，我可以直接按本方案落地 `capabilities.ts` 并替换 `CombatSquad` 的判定逻辑；
该实现仅使用本文件列出的、已在项目中出现过的 API 字段，不引入未验证属性。


