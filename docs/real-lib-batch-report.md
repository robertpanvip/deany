# 真实库批量测试报告（v0.1.48）

复用 react / react-dom 的"转换 + strict 门禁"方法，对 9 个 deany 之前未测过的经典 npm 库做批量验证。所有库经 `npm pack` 下载，取主入口 JS，用 `createUsageResolver` 建跨文件推断，再 `convertSource` + `checkStrict`。

## 结论速览

| 库 | 版本 | 入口 | 原始 checkJs 隐式 any 错误 | 转换耗时 | 转换后新语法错误 | 备注 |
|---|---|---|---|---|---|---|
| minimist | 1.2.8 | index.js | 45 | 7ms | 0 | 干净 |
| debug | 4.4.3 | src/common.js | 20 | 6ms | 0 | 干净 |
| semver | 7.8.6 | classes/semver.js | 31 | 5ms | 0 | 干净 |
| uuid | 14.0.3 | dist/v1.js | 12 | 1ms | 0 | 干净 |
| **p-map** | 7.1.1 | index.js | 54 | 3ms | 0 | **类型爆炸 bug** |
| camelcase | 10.0.0 | index.js | 25 | 2ms | 0 | 干净 |
| chalk | 6.0.1 | source/index.js | 43 | 2ms | 0 | 干净 |
| ora | 10.0.0 | index.js | 63 | 10ms | 0 | 干净 |
| kind-of | 6.0.3 | index.js | 11 | 1ms | 0 | 干净 |

- **9 / 9 全部转换成功**，无崩溃、无 OOM、无非法 `: function` 语法、无 TS1196（catch 变量注解）等新语法类错误。
- 用 `.js` 文件名检查时，唯一诊断是 TS6504（"is a JavaScript file, enable allowJs"），属探针配置提示，非产物缺陷。
- 用 `.ts` 文件名按 react/react-dom 门禁口径检查时，8 个库的诊断均为常规严格模式收紧项（如 TS7053 索引、TS18046 可为空、跨文件 require 未解析），与 react-dom 基线 4533 同类；**唯独 p-map 出现异常量级**。

## 关键发现：p-map 类型爆炸（真实 bug）

p-map 的 `pMap` / `mapConcurrently` 第三个参数 `options`（解构默认值 `{ concurrency, stopOnError, signal } = {}`）被推断成巨型对象类型：

- 单个对象类型里 `concurrency?` 字段重复 **255 次**，`signal?` 重复 240 次。
- 函数签名行长 **49,107 字符**，参数解构行长 **55,431 字符**。
- `unknown` token 出现 4,551 次。
- 按 `.ts` strict 检查产生 **2,336 个 TS2300（重复标识符）** —— 这不只是体积问题，而是直接让产物无法通过 strict。

**根因**：fixed-point 迭代中，同一对象形状被反复作为 source 回流并参与 `mergeObjectShapes`。每轮生成的形状文本在可选性 / `| undefined` 上略有差异（`concurrency?: number` vs `concurrency?: number | undefined`），`Set` 按整串去重失效，字段逐轮累积。`MAX_SHAPE_TEXT = 200_000` 的护栏只在超过 200K 时拒绝合并，而这里停在 ~55K，未触发护栏。

**影响范围**：用 git worktree 二分确认，该问题在 **v0.1.30 即已存在**（v0.1.30 / 36 / 40 / 44 / 48 均复现），是长期遗留 bug，非最近别名证据改动引入。CLI 单文件转换（会合并 `index.d.ts`）同样复现，排除探针调用方式因素。

## 修复结果（v0.1.49）

根因定位到 `mergeObjectShapeWithProperties`（`src/inferAny/shape.ts`）：提取已有字段名时用 `field.slice(0, colon).trim()`，**没有去掉可选标记 `?`**，得到 `concurrency?` 而非 `concurrency`；而属性表的 key 是 `concurrency`，于是 `existing.has(name)` 永远为 false，每个 fixed-point 轮次把同一字段重新追加一次（1→3→6→10…，三角数增长）。`splitFieldNameType` 本就正确剥离了 `?`，此处是遗漏。

修复：在 `mergeObjectShapeWithProperties` 的 key 提取处同样剥离尾部 `?`。

| 指标（p-map） | 修复前 | 修复后 |
|---|---|---|
| 最长行 | 55,431 字符 | 566 字符 |
| `concurrency?` 字段 | 255 | 10 |
| `unknown` token | 4,551 | 75 |
| TS2300 重复标识符 | 2,336 | 0 |
| 收敛 | 16 轮未收敛 | 3 轮收敛 |

**回归验证**：387/387 测试通过（新增 1 条 fixed-point 去重回归测试）、typecheck 干净、react 267=267 / react-dom 4533=4533（delta=0、added/removed=0）。基线诊断零变化，修复无副作用。

## 建议下一步

- 其余库的 TS18046 / TS7053 属常规严格收紧项（如 kind-of 19 个 TS18046），可作为后续新证据通道的候选，但风险与收益需单独评估，本次不动。
