# 真实库压测日志

本文件记录 `deany`（原 `jsdoc2strict-ts`）历次真实开源库压测，供自动化迭代任务查阅以避免重复拉取同一库。
每轮任务：**从 GitHub 拉取一个尚未列出的、开源可靠的小型 JS/TS 库 → 转换 → strict 检查 → 区分「库自身动态性限制」与「工具真实缺陷」→ 修复工具缺陷 + 补回归测试 → 全量验证 → 本地提交 → 追加本表**。

原则：**只做可靠的类型生成**——类型必须来自真实使用证据（初始化器、赋值、实参、返回、typeof/instanceof/Array.isArray/类型谓词、成员访问、索引/for-in、默认值、解构、await、位运算、比较、展开、容器变异等）；严禁按方法名「看起来像」臆测类型；推不出保持 `unknown`/`void`，绝不编造具体类型。

## 已测库清单

| 库 | 大致版本/来源 | 轮次 | 结论 | 相关提交 |
| --- | --- | --- | --- | --- |
| lodash | npm 常见版 | 第一轮 | 修复命名空间/联合函数括号/裸泛型/回调参数等；239 处隐式 any 清零 | 早期提交 |
| async | npm 常见版 | 第一轮 | 同上 | 早期提交 |
| debug | npm 常见版 | 第一/二轮 | 同上 | 早期提交 |
| ms | npm | 第二轮 | 大写 primitive 归一化等 | 早期提交 |
| is-number | npm | 第二轮 | 同上 | 早期提交 |
| fast-deep-equal | npm | 第二轮 | 递归函数为固有限制 | 早期提交 |
| p-limit | sindresorhus/p-limit（GitHub） | 第二轮 | 粗略转换；index.js 深度复现见第五轮 | `e0c0d2d` 起 |
| chalk | npm | 第二轮 | — | 早期提交 |
| semver | npm | 第二轮 | — | 早期提交 |
| nanoid | npm | 第二轮 | — | 早期提交 |
| mimic-fn | npm | 第三轮 | Object.defineProperty 对象槽位反推 | `983f3b2` 起 |
| kind-of | npm | 第三轮 | catch 注解规避；顶层 toString 冲突为固有限制 | `ab96f7e` |
| xtend | npm | 第三轮 | 索引/for-in → Record；清零 | `5d0fa24` |
| object-assign | npm | 第三轮 | 空对象字典升级；装箱类型固有限制 | `5d0fa24` |
| is-plain-object | npm | 第三轮 | — | `ab96f7e` |
| escape-string-regexp | npm | 第三轮 | — | `ab96f7e` |
| p-try | npm | 第三轮 | callee 可调用签名反推 | `674f4e2` |
| is-buffer | npm | 第三轮 | — | `ab96f7e` |
| **p-limit（深挖 index.js）** | `git clone https://github.com/sindresorhus/p-limit` HEAD | **第五轮** | 22 → 19 条 strict 诊断；修复空数组 push、对象追加字段、关系比较三类缺陷 | 本轮提交 |

## 第五轮详情（p-limit 深挖）

测试对象：`index.js`（148 行，纯 ESM JS，无 JSDoc）。转换后 strict 诊断从 22 降到 19；修复的三个缺陷及最小复现已固化为 `test/realLib.test.ts` 回归用例。

本轮修复：
1. **空数组 + push**：`const a = []; a.push(x)` → `Array<T>`（原 `Array<never>`）。
2. **对象字面量后追加字段**：`const o = {a}; o.b = v` → `{ a; b?: T }`（构造后字段设为可选）。
3. **关系比较**：改为逆变约束，避免把已有具体来源 widen 成 `number | string` 联合。

仍存的 19 条（非工具缺陷或属已知局限）：
- `TS2307` 缺 `yocto-queue` 依赖（外部包未安装）。
- `queue.size` / `queue.dequeue()` 等 `unknown`（外部泛型类型 + JS 动态性）。
- `typeof x === 'object'` 后解构赋值 `({concurrency, rejectOnClear} = concurrency)` 的 `TS2339`（解构目标收窄未反推）。
- 关系比较中 `number < (number | string)` 的 `TS2365`（`limit` 只用于比较，无法判定 number/string，保守不臆测）。
- `promise`/generator 返回类型被推成 `Array<any>` 的连锁（表达式体箭头 + 嵌套 Promise 推断，属独立返回类型推断问题）。

## 第六轮详情（10 个 npm 小库批量压测）

一次性拉取 10 个未测过的可靠小库（npm registry），对每个库主入口 JS 跑 deany 转换 + `checkStrict`。来源与版本：

| 库 | 版本 | 入口 | strict 诊断（原始 JS → 转换后） |
| --- | --- | --- | --- |
| inherits | 2.0.4 | inherits.js | 0 → **0**（本轮修复前为 1，TS2502） |
| bytes | 3.1.2 | index.js | 10 → 11 |
| is-observable | 3.0.0 | index.js | 4 → 4 |
| once | 1.4.0 | once.js | 17 → 18（修复前 19） |
| p-defer | 4.0.1 | index.js | 3 → 1 |
| p-filter | 4.1.0 | index.js | 13 → 5 |
| p-map | 7.1.1 | index.js | 57 → 34（修复前 36） |
| p-timeout | 8.1.0 | index.js | 17 → 16 |
| wrappy | 1.0.2 | wrappy.js | 6 → 6 |
| yallist | 5.0.0 | dist/esm/index.js | 34 → 83 |
| **合计** | | | **161 → 178**（修复前 182；`inherits`/`p-map`/`once` 三库净降 5） |

### 本轮修复：CommonJS `require()` 自引用类型（真实工具缺陷）

**现象**：`var util = require('util')` 被注解成 `var util: typeof util`（TS2502 循环自引用）；`require('path')` → `path.PlatformPath`（TS2503）、`require('fs')` → `typeof fs`。所有 CommonJS 库的中招。

**根因**：`collectEvidence` 收集 initializer 时用 `checker.typeToString` 打印类型，TypeChecker 会用**本地绑定名**打印模块命名空间类型（`typeof util`），写成注解即自引用。

**修复**：新增 `requireModuleType()`，识别 `require('mod')` 调用并重述为不含绑定名的 `typeof import("mod")`；同时加 `isSelfReferentialType()` 兜底拦截其它自引用文本。推理依据：checker 能打印出自引用模块类型 ⟺ 模块类型可解析 ⟹ `typeof import("mod")` 同样可解析，不会退化成 `unknown`。三条最小复现（util/path/fs）strict 诊断全部清零。`test/realLib.test.ts` 新增 3 个回归测试（覆盖 infer-any 与 JS 两条路径）。

**效果**：`inherits` 1→0、`p-map` 36→34、`once` 19→18；总体 182→178。`typeof import("util")` 等类型精确且 strict-clean，不再臆造 `any`/`unknown`。

### 剩余诊断分类（未修，多为固有限制）

- **JSDoc 点号参数**：`bytes` 用 `@param {string} [options.thousandsSeparator]` 明确声明子字段，但工具只推 `options: object`，丢字段（TS2339×6）。属可靠证据遗漏，但需改 JSDoc→对象形状合成，面较大，留待专门一轮。
- **函数对象后追加字段**：`once` 的 `f.called = false; f.value = ...`（TS2339×4）。类似已修的"对象字面量后追加字段"，但函数表达式绑定被 convert 刻意跳过注解（避免重复），修复需动该逻辑，风险较高。
- **泛型/外部类型**：`p-map`/`yallist`/`p-timeout` 的 TS2345/TS2322/TS2526 多为 `unknown` 传入泛型槽位、外部类型、`get/set` 访问器配对等，属 JS 动态性固有限制。
- **非标准 API**：`is-observable` 的 `Symbol.observable`（TS2339/TS2571）非标准 Symbol，lib.d.ts 无声明，工具不应臆造。
- **缺依赖**：`p-filter`/`p-map` 的 TS2307 为外部包未安装（对照环境未装 node_modules）。
- **`this` 隐式类型**：`wrappy` 的 TS2683、`p-timeout` 的 TS4114（override）。

## 待选库（尚未测试，供下一轮参考）

预留候选：`visionmedia/bytes` src 源码目录（区别于已测的 npm 发布版）、`jshttp/ms`、`sindresorhus/p-locate`、`sindresorhus/p-finally`、`sindresorhus/p-any`、`component/emitter`、`feross/standard` 依赖链小库。

> 拉取失败或网络不可用时如实记录并跳过，不要伪造结果。每轮聚焦一个真实缺陷做扎实，不追求诊断数清零——`unknown`/`void` 是保守设计的正确兜底。
