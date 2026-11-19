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

## 第七轮详情（会话内定时压测 · 随机抽库）

工作模式：会话内后台脚本每 10 分钟随机抽 3 个未测库（候选池 42 个）→ 下载 → 转换 → strict 检查 → 落盘报告；主会话逐轮读取报告做智能分析修复。共 20 轮。

### 第一轮（随机抽中 p-any / p-map-series / p-each-series）

| 库 | 版本 | strict 诊断（原始 → 转换后 → 修复后） |
| --- | --- | --- |
| p-any | 5.0.0 | 6 → 7 → 7（余下均为缺依赖级联，固有限制） |
| p-map-series | 2.0.0 | 2 → 1 → **0** |
| p-each-series | 3.0.0 | 2 → **0** |

**本轮修复：空数组 push 不透明值冻结成 `Array<never>`**

`p-map-series` 的 `const result = []; result.push(await mapper(...))` 被推成 `Array<never>`，所有 push 报 TS2345。根因：`collectMutationEvidence.add()` 在 `typeText()` 对 push 实参（call/await 表达式，checker 类型为 `any`）返回 `undefined` 时**没有收集任何证据**，导致 `writes=[]`，空数组回退到 checker 默认的 `Array<never>`。

修复：`add()` 对无法命名类型的已写入值收集 `'unknown'`——它仍是真实写入，元素槽必须能容纳该值；`Array<unknown>` 接受任意 push 且 strict-clean，不臆造具体类型。同时空数组分支增加防御：writes 非空但合并结果为空时显式用 `Array<unknown>`。三条最小复现（`push(fn(x))` / `push(await fn(x))` / `push(await v)`）全部清零。`test/realLib.test.ts` 新增回归测试。现有 `push(Promise.resolve(1)) → Array<Promise<number>>` 行为不变（153/153 测试全绿）。

**p-any 剩余 7 条（未修，固有限制）**：3×TS2307 缺 `p-some`/`p-cancelable` 依赖；TS2698/TS18046/TS2339/TS2488 源于 `PCancelable.fn(async onCancel => ...)` 回调参数——外部库 API + 依赖缺失，无法可靠推断，留 `unknown` 是保守正确。

### 第二轮（随机抽中 quick-lru / decamelize / p-memoize）

| 库 | 版本 | strict 诊断（原始 → 转换后 → 修复后） |
| --- | --- | --- |
| quick-lru | 6.1.1 | 57 → 43（TS4114 ×13 为 class override 检查门槛，非转换缺陷） |
| decamelize | 5.0.1 | 3 → 4 → **2**（修复后仅余 2×TS1501 检查门槛误报） |
| p-memoize | 7.1.1 | 15 → 22（多为缺依赖 `mimic-fn` 级联 + `this` 隐式类型） |

### 第三轮（随机抽中 array-flatten / p-locate / pify）

| 库 | 版本 | strict 诊断（原始 → 转换后 → 修复后） |
| --- | --- | --- |
| array-flatten | 2.1.2 | 6 → **0** |
| p-locate | 6.0.0 | 9 → 9 → **7**（解构字段 TS2339 减少，余为缺依赖 `p-limit` 级联） |
| pify | 5.0.0 | 20 → 34（回调/rest 参数动态性，固有限制） |

**本轮修复：解构参数默认值字段丢失（decamelize / p-locate）**

`function f(text, { separator = '_', preserve = false } = {})` 被推成 `text, { ... }: {}`，字段 `separator`/`preserve` 全丢，每次访问报 TS2339。根因：`collectEvidence` 对解构参数只用 `= {}` 初始化器推成裸 `{}`，从未从 binding element 的默认值收集字段类型——尽管 checker 本身能精确推出 `{ separator?: string; preserve?: boolean }`。

修复：owner 是参数且 name 为 ObjectBindingPattern 时，遍历 binding elements，用 `typeText(ctx, element.initializer)`（widened）收集每个字段的类型进 `evidence.properties`；`objectLiteralInit` 使 `mergeEvidence` 以可选字段输出（`{ separator?: string; ... }`，参数可整体省略），与 checker 形状一致。字段名取 `propertyName`（属性名而非本地绑定名），带引号的非法标识符正确 JSON 引用。最小复现（单/多默认值、重命名键、引号键）全部 strict-clean。`test/realLib.test.ts` 新增 2 条回归测试。实测 decamelize 4→2（TS2339×2 清零）、p-locate 9→7。**155/155 测试全绿**。

**未修（固有限制/检查门槛）**：TS1501（正则 `v`/`s` flag，checkStrict 固定 ES2022 的门槛误报，产物与源码一致）、TS4114（class override）、缺依赖级联（TS2307）、`this` 隐式类型（TS2683）、回调/rest 动态参数。

### 第四轮（随机抽中 which-typed-array / p-finally / slash）

| 库 | 版本 | strict 诊断（原始 → 转换后） |
| --- | --- | --- |
| which-typed-array | 2.0.0 | 21 → 18（余下多为缺依赖 TS2307×6 + TS2578 冗余） |
| p-finally | 2.0.0 | 1 → **0** |
| slash | 5.1.0 | 1 → 1（单条 TS2322，regex 参数重载） |

### 第五轮（随机抽中 p-reduce / is-arguments / p-finally）

| 库 | 版本 | strict 诊断（原始 → 转换后 → 修复后） |
| --- | --- | --- |
| p-reduce | 3.1.0 | 4 → 3 → **2**（void 参数污染消除，余 2 条泛型/Symbol 固有限制） |
| is-arguments | 1.2.0 | 2 → 4（缺依赖 `call-bound` + TS2306 模块解析 + 冗余 @ts-expect-error） |
| p-finally | 2.0.0 | 1 → **0** |

**本轮修复：函数 void 返回泄漏为值参数类型（p-reduce）**

`const next = async total => { resolve(total); return; }; next(initialValue)` 中，`initialValue`/`total` 被推成 `void`——把值传给 void 参数在 strict 下报 TS2345/TS2322。根因：`a => { return; }` 无值 return 使函数返回推成 `void`（正确），但该 void 经固定点迭代通过「实参传参」的形参约束（`constraintsFromReference` 的 `addConstraint`）泄漏到值参数 owner；约束交集把值钉成 void。

修复：`addConstraint` 丢弃 `void`/`Promise<void>` 约束——void 描述函数返回而非值，不应收窄值绑定；函数返回仍走 `addSource`（returns 表）不受影响。最小复现（`init`/`a`/`next(initialValue)`）参数从 void → unknown，TS2345 清零，函数返回 void 保留。实测 p-reduce 4→2（TS2345 消除）。`test/realLib.test.ts` 新增回归测试。**156/156 测试全绿**。

**未修（固有限制）**：p-reduce 余 TS2571/TS2322 为 `Record<PropertyKey,unknown>` 上 `Symbol.iterator` 槽 unknown + 泛型 `Promise<any>` resolve 的深层限制，非臆测范围；is-arguments 的 TS2306/TS2307 为缺依赖与模块解析。

### 第六轮（随机抽中 p-times / p-throttle / is-finite）

| 库 | 版本 | strict 诊断（原始 → 转换后） |
| --- | --- | --- |
| p-times | 5.0.0 | 7 → 3（余为缺依赖 `p-map` 级联） |
| p-throttle | 7.0.0 | 35 → 38（`this`/闭包 + 缺依赖深层动态性，固有限制） |
| is-finite | 1.1.0 | 见报告（缺依赖族） |

### 第七轮（随机抽中 is-date-object / is-regex / object-inspect）

| 库 | 版本 | strict 诊断（原始 → 转换后 → 修复后） |
| --- | --- | --- |
| is-date-object | 1.1.0 | 2 → 2（缺依赖 `call-bound`） |
| is-regex | 1.1.5 | 2 → 9 → **8**（内置工具类型别名冲突消除，余为缺依赖级联） |
| object-inspect | 1.13.4 | 105 → 135（545 行大库，大量动态属性/序列化逻辑，固有限制累积） |

**本轮修复：TS 内置工具类型被误生成 fallback 别名（is-regex）**

`is-regex` 的 JSDoc `@type {(... receiver: ThisParameterType<...> ...)}` 中 `ThisParameterType` 是 TS 内置工具类型，但 `normalize.ts` 的 `BUILTIN_TYPE_NAMES` 名单漏了它，`convert.ts` 的 dangling-typedef 逻辑据此生成了 `type ThisParameterType = unknown;`——与 lib 声明冲突（TS2300）、且无泛型别名被当泛型用（TS2315）。

修复：补全内置工具类型名单——`ThisParameterType`、`OmitThisParameter`、`ConstructorParameters`、`Uppercase`/`Lowercase`/`Capitalize`/`Uncapitalize`、`ReadonlyArray`、`This`、`NoInfer`。产物中 `type ThisParameterType = unknown;` 消失，TS2300/TS2315 消除，is-regex 9→8。`test/normalize.test.ts` 新增回归测试。**157/157 测试全绿**。

**未修（固有限制）**：object-inspect 的 TS2339×41/TS2345×20 等为 545 行库对任意对象的反射式属性访问 + `typeof X === 'function' && X.prototype` 逻辑与未定型（回退 unknown）的累积，非单一可修点、不臆造；is-regex 余项均为缺依赖 `call-bound`/`hasown`/`gopd`。

## 第八轮详情（复审历轮「未修项」是否可修）

逐个复审前几轮标注为「未修复」的项，区分「真实可修缺陷」与「多因素叠加/缺依赖级联，不宜单点修」。共处理三项，只修 1 项：

### 已修：JSDoc 点号参数丢子字段（bytes，第六轮遗留）
- **复现**：`@param {object} [options]` + `@param {string} [options.thousandsSeparator]` → `options: object`，子字段全丢（TS2339×6）。
- **根因**：`jsdoc.ts` 把 `options.thousandsSeparator` 解析为独立 tag，`convert.ts` 参数循环只按完整名匹配 `@param`，点号 tag 匹配不到 `options`，checker 又把整体压成裸 `object`。
- **修复**：`normalize.ts` 新增 `objectTypeFromDottedParams(root, tags, options)`，把 `options.a` / `[options.b]` 折叠成嵌套 inline 对象（可选字段保留 `?`）；`convert.ts` 参数循环在按名匹配前先收集 `name.` 前缀的点号 tag，命中则合成对象形状并标记 tag 已用（消除误报警告）。必填/可选、多层嵌套、非法标识符均覆盖。
- **效果**：bytes 真实写法 6×TS2339 清零；产物 `options?: { decimalPlaces?: number; thousandsSeparator?: string; }`。`test/realLib.test.ts` 新增 2 条回归测试。**159/159 测试全绿**。

### 复审后不修（如实记录原因）

- **函数对象后追加字段（once，第六轮）**：`var f = function(){}` + `f.called/f.value` 的函数内引用报 11×TS2339。受控实验：给 `var f` 加交叉注解（`{(...args):any; called; value}`）虽把 18→13，但函数表达式初始化点立刻产生 TS2739（缺属性），且 `fn` 的 `this`/`arguments`/缺依赖 `wrappy` 是独立问题——多因素叠加，非单一可修点。强行改 `processVariable` 跳过函数绑定的既有逻辑风险高，维持原状。
- **define-properties 的 `name: unknown`（第九轮）**：`name in obj` / `obj[name]` 的 key 被推 `unknown`（TS18046/TS2538）。实验：仅把 key 改 `PropertyKey` 只是把 TS2538 换成 TS7053（容器 `object` 无索引签名），净收益为零；连同容器改 `Record` 又引入调用点 TS2345。根因是缺依赖 `object-keys` 令 `map`/`props` 类型丢失的级联，非 key 约束单点可解，维持原状。
- 其余历轮未修项（缺依赖 TS2307、正则 flag TS1501、class override TS4114、外部泛型/Symbol 槽、object-inspect 反射式动态属性）均为检查门槛或保守兜底正确，不在臆测范围内。

## 第九轮详情（复审未修项 · 解构绑定成员访问）

用户要求把历轮未修项全部摊开讨论是否可修。按「证据确凿 / 多库受益 / 单点可修 / 风险可控」四标准复审，逐项结论：

| 未修项 | 出处 | 结论 | 依据 |
|---|---|---|---|
| 解构绑定成员访问 `unknown` | delay / p-debounce / p-locate | **本轮修复** | `signal.aborted` 等是真实证据却丢失 |
| 类型谓词 `@type` 与成员访问冲突 | is-symbol | 不修 | 仅 1 条，需改注解优先级，风险>收益 |
| 函数对象后追加字段 | once | 不修 | 实验 18→13 但引入 TS2739，多因素叠加 |
| key 推 `unknown`（in/索引） | define-properties | 不修 | PropertyKey 只把 TS2538 换 TS7053 |
| async 递归参数污染 | p-whilst | 不修 | 固定点深层问题，仅 1 条 |
| 缺依赖 / class override / 正则 flag / `this` / 非标准 Symbol / 大库反射 | 十余库 | 不修 | 检查门槛或保守兜底正确 |

### 本轮修复：解构绑定的成员访问证据回折到解构源

**现象**：`const { signal } = opts` / `function f({ signal } = {})` 中，`signal` 被推 `unknown`，`signal.aborted`/`signal.addEventListener(...)` 报 TS2339/TS18046（delay 11 条里大半、p-debounce、p-locate 同类）。

**根因**：解构出的 binding element 从未作为独立 owner 收集证据（infer 返回 `undefined`），其成员访问证据完全丢失；且 converter 给解构 pattern 加空洞的 `: {}` 注解，掩盖了解构源本可携带的形状。

**修复**（三处协同）：
1. `symbolOf` / `collectDeclarations` 支持 `BindingElement` 作为 owner，使其成员访问被收集为对象形状。
2. `collectEvidence`：当标识符被解构（`const {…} = x`）或 owner 自身是解构 pattern 时，直接计算各 binding element 的形状（`mergeEvidence(collectEvidence(element))`，避开固定点顺序），作为**可选属性**回折进解构源的 `evidence.properties`。
3. `convert.ts`：解构 pattern 推断为 `{}` / `unknown` 时不加注解，让 TS 从已带形状的解构源推断（否则空洞注解覆盖正确类型）。

**效果**：delay strict 诊断 11→8（signal 成员访问类仅余 1 条闭包内 TS18048，属固有限制）；最小复现 `const {signal}=opts` + 可选链访问清零。`test/realLib.test.ts` 新增 2 条回归测试。**161/161 测试全绿**。

**为何字段是可选**：解构源默认 `= {}`，字段确实可能缺失，工具推 `signal?` 是忠实的；真实库用 `signal?.aborted` 可选链访问，strict-clean。`value` 这类无成员访问、无默认值的字段仍保持缺失/unknown，符合「不臆测」原则。

## 用户 84 用例测试报告修复（@deany/core 0.1.2）

用户提供 84 用例报告（63 通过 / 21 失败），逐项验证后修复 12 项（含 1 个阻断 bug）。所有修复均经最小复现确认 + strict 校验 + 回归测试，测试数 157→173。

### 阻断级：--check 门禁在 Windows 恒通过

`checkStrict` 用 `diagnostic.file.fileName === resolved` 过滤诊断，Windows 上 TS 内部 fileName 是正斜杠、`ts.sys.resolvePath` 是反斜杠，永不相等 → 全部诊断被过滤 → 恒 `ok:true`。改为 **SourceFile 对象引用比较**（`d.file === target`），平台无关。补非归一化文件名回归测试。

### 确凿证据类

- **1.1 this.x 提升为类字段**：`processThisAssignment` 原来只在有 JSDoc 时触发；改为无 JSDoc 时从 RHS 推断（resolver.typeOf，缺失时用字面量兜底），统一用 `!:` definite assignment（JS 动态赋值 TS 建模不到）。新增 `UsageResolver.typeOf`。高影响：class 构造器赋值字段全线 TS2339 消除。
- **1.3 非空数组 push 合并**：原仅空数组 `[]` 收集变异证据；非空中也收集并与字面量元素类型合并为联合（`[1]; a.push('x')` → `Array<number|string>`）。新增 `arrayElementTypeOf`。
- **1.8 关系比较**：`n < x`（n 已知 number）原把 x 推成 `number|string` 致 TS2365；改为另一侧为具体可比较原始类型时用它作约束，两侧都未知才回退 `number|string`。
- **1.9 下标键**：`x[k]` 原只约束容器 x，k 留 unknown 致 TS2538；给 argumentExpression 加 `PropertyKey` 约束（容器已是 `Record<PropertyKey,unknown>`，无 TS7053 风险）。

### 深层属性链

- **1.4 属性链深度**：`o.a.b.c` 原只推一层 `{a:unknown}`；新增 `shapeChain: ShapeNode` 收集以 owner 为根的最长访问链，mergeEvidence last-resort 渲染嵌套 `{a:{b:{c:unknown}}}`。
- **1.5 无守卫迭代方法**：`xs.map(it=>it.a.b)` 无 Array.isArray 时退化为方法形状；elementShape 非空且属性全是 ITERATION_METHODS 时，last-resort 直接用 `Array<shape>`。map/forEach/filter 全部清零。

### 回调 / 高阶函数

- **1.6 reduce 回调**：`nums` 有 JSDoc `{...number}`（转 `number[]`），但 checker 视角无上下文，回调被硬标 unknown 致 TS18046。新增 AST 检测"接收者有 JSDoc 数组类型"时跳过回调参数注解，让 TS 用转换后的上下文类型。
- **1.7 高阶函数**：`apply(fn,v)` 有调用点时 fn 从未标注箭头退化成 `(s:any)=>any`（比无调用点更差）。改为：opaque 回调实参不注入 any，而用其参数 usage 推断构造精确签名 `{length:unknown}`；回调参数注解也优先用 resolver.infer 而非 defaultType。fn 与回调实参精确匹配。

### 内建类型反推（用户明确解禁原 C 档方法名臆测）

- **1.2 内建容器 any**：`new Map()/Set()/WeakMap()/Promise()` 无显式类型参数时 checker 给 `Map<any,any>`，与 de-any 宗旨冲突；无 typeArguments 时把 any→unknown。显式类型参数与 `new Date()` 不受影响。
- **1.10 Math.max 展开**：`Math.max(...xs)` 的形参 `...values:number[]` 是确定逆变约束；给 xs 加 `number[]` 约束（lib.d.ts 签名，非臆测）。
- **1.11 lib 唯一方法反推**：`toUpperCase`→string、`toFixed`→number、`getTime`→Date 等——方法在 lib.d.ts 中只属一个 family。**弱证据 + 严格守卫**：仅当 binding 无任何 source 且所有观测属性都是同一 family 的唯一方法（且值为 method 签名）时收窄；有调用点具体类型或非唯一方法共存时不收窄，避免误伤自定义同名方法。
  - **对象字面量自带同名方法（已验证）**：`const o: any = { toUpperCase(){…} }`（即使只有这一个方法）保留为 `{ toUpperCase(): string }` 形状，不收窄成 string——初始化器是强 source，优先于 weak 兜底；`{ toUpperCase(){…}, extra: 1 }` 作为实参传给只调 `toUpperCase` 的函数时，call-site 具体形状同样胜过 weak string。仅「裸 `any` 参数只观测到 `toUpperCase` 调用」才按设计收窄成 string。回归测试：`test/inferAny.test.ts` 的 `keeps an object literal with its own toUpperCase as a shape, not string`。
  - **方法返回签名必须和内置一致（已验证，本轮修复）**：方法名唯一只是必要条件，返回类型对不上同样不能收窄。`function f(x:any): number { return x.toUpperCase() }` / `const n: number = x.toUpperCase()` / `x.toFixed(2)` 被当 number：用 `checker.getContextualType(call)` 取期望返回类型，与内置返回（`toUpperCase`→string、`toFixed`→string、逐方法表 `BUILTIN_METHOD_RETURN`）冲突时，否决族收窄，并把方法签名合成为 `(...args: unknown[]) => <观察到的返回>`——既阻止臆造 string/number，又让调用点 strict 通过（否则返回 unknown 会触发 TS2322）。返回语境一致（`: string`）或裸调用（无语境）仍正常收窄为 string/number。回归测试：`does not narrow a lib-unique method whose return signature contradicts the builtin` 与 `still narrows … when the return signature agrees`。

### 已知边界（未修，记录避免重复评估）

- 1.2 的 Map/Set 键值精确反推（`m.set('k',1)` → `Map<string,number>`）：容器变异证据目前只覆盖数组，属增强非缺陷。
- 1.4 叶子参与 `+`（`o.a.b + o.x.y`）：深层形状已推对，但叶子 unknown 参与算术是本轮之外的问题。
- 报告第 2 节 6 项（无调用点 add、递归、switch typeof、可选链链深、`require('node:path')`、esm-export-infer）：均为已确认取舍或门禁限制。

## 同名 d.ts 精确还原（用户提出，本轮实现）

- **需求**：JS 文件旁边有同名 `.d.ts` 时，把声明签名与 JS 实现结合，高保真还原成 TS——checker 里 d.ts 签名本就完整可取（`(opts: Options) => Result`、泛型 `find<T>`、interface 全在），此前 `fs.ts` 把 d.ts 排除、从不读取，属「没做」非「做不到」。
- **实现**：新增 `src/dts.ts` 的 `loadDeclarations`——解析同名 d.ts AST（不用 checker，保留泛型/重载/类型名原文），按符号名收集函数签名、变量类型、class 成员、interface/type/enum 声明。`convertSource` 新增可选 `declarations` 参数，作为**最强 source**：d.ts > JSDoc > usage > unknown；函数参数按位置贴回、返回类型/`<T>` 原样采用、class 方法字段贴回、interface/type 原样合并到输出顶部（与 `@typedef` 同名跳过，且从 dangling 别名中剔除避免冲突）。`fs.ts`/`cli.ts` 接线，新增 `--no-dts` 关闭。
- **验证**：真实样例 `calc.js`+`calc.d.ts`（无 JSDoc）→ `add(a:number,b:number):number`/`VERSION:string`，strict 通过；泛型 `wrap<T>(value:T):T[]`；interface 合并；d.ts 覆盖 JSDoc（`string`→`number`）、`--no-dts` 回退；class 方法字段。测试 `test/dts.test.ts` 5 项 + 全套 **181/181 全绿**，typecheck/build 通过。
- **已知边界**：d.ts 只覆盖公共 API，函数体内部局部变量仍靠 JSDoc/usage；同名 d.ts 之外不读取 import 的第三方 d.ts；`noUncheckedIndexedAccess` 下 JS 实现体原有的索引访问告警（`items[i]` → `T | undefined`）是实现本身问题，不在 d.ts 合并范围。

## 切到 TypeScript 6 单一基线（用户要求，本轮实现）

- **需求**：用户明确「支持 TS6 就可以了，不需要支持 TS5.9」——把项目基线从 TS5 切到 TS6，仅支持 TS6（「更接近以后的语义」）。TS7 因 `ts.TypeFormatFlags` 等导出形态变化会在 import 期崩溃，仍拒绝；TS5 为旧基线，不再兼容。
- **差异点**：TS6 的 `createCompilerHost` **不再自动加载 `@types/*`**（TS5.9 会）。表现为含 Node 全局（`module`/`require`/`process`/`node:fs`/`NodeJS.*`）的转换输出在 `--check` 下误报 TS2591/TS2304/TS2503。d.ts 还原功能本身在 TS6 下签名断言全过，非功能缺陷。
- **修复**（按需加载 node 类型）：
  1. `src/check.ts` 抽出 `collectDiagnostics`；首轮检查若出现 Node 全局缺失诊断（码 2304/2503/2580/2591 + 消息含 `module|require|process|…|NodeJS`），且 `types` 未显式指定、`resolveTypeReferenceDirective('node', file)` 能从被检文件位置解析到 `@types/node`，则注入 `types: ['node']` 重检一次（调用方已通过 extraOptions 传 `types` 时跳过）。
  2. `tsconfig.json` 加 `"types": ["node"]`，让 deany 自身源码在 TS6 下 `build`/`typecheck` 通过。
  3. peer 收窄 `>=5.4 <7` → `>=6 <7`；devDependency 升到 `^6.0.3`；两个 bin 守卫改为 `major !== 6`（仅 TS6 放行，TS7/TS5/TS4 均友好拒绝）。
- **验证**：工作区本地 TS 升到 `6.0.3`（npm install 更新 lock）→ build/typecheck 通过、test **182/182 全绿**、CLI 守卫放行 TS6、真实转换 + d.ts 还原 + `--check` 全绿。新增回归测试 `checkStrict accepts Node globals emitted verbatim from JS`，反证：换回旧 check.ts 后该用例在 TS6 下精确变红、修复后转绿。
- **诚实兜底**：无 JSDoc/无 d.ts 时 `add(a,b)` 推不出 → `unknown`，`unknown + unknown` 在 strict 下仍报 TS18046——这是「不臆测」原则的正确表现，非回归。

## 社区 60 用例报告修复（本轮实现，5 问题全修）

报告测 `@deany/core@0.1.5`（52 通过 / 8 失败 → 归并 5 问题）。在当前基线逐条复现，**5 项全部属实并全部修复**：

- **P3（高）联合中 `function()` 未归一化→TS8020**：`(function():number)|string`、`(number|function():void)` 输出非法 TS。根因：`splitTopLevel` 遇括号不拆，`convertFunctionType` 的 `^function` 锚点拒绝开头的 `(`。修复：`src/normalize.ts` 加 `stripOuterParens`（仅首尾配对时剥离，不误伤 `(a)|(b)`），在 `convertFunctionType` 前剥离后递归。三种复现 + 括号语义保留均验证；类型匹配样例 `checkStrict` 通过。注意：报告样例 `return 1` 与返回类型联合不匹配报的 TS2322 是**正确类型检查**，非工具 bug（TS8020 非法语法已消除）。
- **P4（高）`--assertions` 空开关**：开启后仅报告、不推断。根因：`ownerOf` 遇 `AsExpression`/`TypeAssertionExpression` 返回 undefined。修复：`inferAny.ts` 的 `visit` 里对断言位置的 any 单独处理——用 `checker.getTypeAtLocation(assertion.expression)` + `widenedTypeText` 取被断言表达式类型作为证据。不碰建表逻辑。实测 `1 as any→1 as number`、`<any>"hi"→<string>"hi"`、`changed:1/unresolved:0`、strict 通过；`unknown` 表达式无证据时保留 any（不臆造）；默认仍跳过。
- **P1（中）README 导入路径**：两处 `from 'deany'` → `from '@deany/core'`。
- **P5（中）收窄引入 TS2454**：`let v:any; fmt(v)` 推断具体类型后 tsc 报 used-before-assigned。**与项目核心卖点同源**（call-site 反推就靠这个写法），不可粗暴跳过推断（会毁掉 16 个反推测试）。修复：推断照常进行，但对「无 initializer + 从未被赋值 + 非 ambient」的 let 在变量名后补 definite-assignment assertion（`let v!: T`）——保留精确类型、消除 TS2454、strict 通过。排除 `declare var`（TS1255）与有初始化/赋值的声明。16 个既有反推测试断言改为 `/let v!?:/` 兼容可选 `!`。
- **P2（低）无参崩溃**：`normalizeJsDocType(raw, options)` 的 options 加默认值 `DEFAULT_OPTIONS`。

**验证**：新增 4 个回归测试（P2/P3 在 `normalize.test.ts`、P4/P5 在 `inferAny.test.ts`），全套 **186/186 全绿**，typecheck/build 通过。

## 扩充 152 项复测 + P6 修复（本轮实现）

来源：独立于上一轮 60 项报告的扩充轮，共 152 项（143 通过 / 9 失败），归并为 6 问题。在本仓库按清单复现代码逐条验证：

- **P1/P2/P3/P4/P5（上一轮已修，本轮复现确认通过）**：README 导入路径、options 默认值、联合中 `function()` 归一化、`--assertions` 生效、TS2454 definite-assignment `!` 均按预期工作。P3 的 `checkStrict` 现在报 TS2322（样例 JSDoc 返回类型与 `return 1` 不符，属正确类型检查）而非原 TS8020 非法语法。
- **P6（本轮新发现，真实存在并已修复）**：`const rec: Record<string, any> = { a: 1, b: 2 }` 被推断为 `Record<string, { a: number; b: number; }>` → TS2322。根因：`any` 在 Record 的 `[1]` 值槽位，而对象字面量初始化器被 checker 报告为整体形状（无 `<...>`），`projectSlotType` 无法投影、回退返回整个对象；Map/Array 的 wholeType 本身是泛型形式故不受影响。修复：`inferAny.ts` 新增 `recordValueSlotType`，识别 `Record`/`ReadonlyRecord` 值槽位 + 对象字面量初始化器，直接从字面量各属性值推断槽位类型（用既有 `mergeMutationEvidence` 联合去重），主循环投影处优先采用；不匹配时仍走原投影路径。结果 `Record<string, number>`，strict 通过。混合值、`ReadonlyRecord`、嵌套对象值均覆盖。
- **验证**：新增 4 个回归测试（`test/inferAny.test.ts`），全套 **190/190 全绿**，typecheck/build 通过。

## 定时压测第 21~35 轮补录（会话内后台脚本 · 事后归类）

背景：第七轮启动的会话内定时压测（任务 `YRXO76`，第 21~60 轮、每 10 分钟抽 3 库）因沙箱休眠在**第 35 轮中断**，后台任务丢失。报告已落盘 `round_21~35.json/.txt`，但第 22~35 轮当时**未被主会话逐轮读取归类**（只有第 21 轮在 19:00 读过一次，判 8→8 无新缺陷）。本轮补做归类，恢复可追溯性。合计 15 轮 / 45 个库样本（去重约 20 库），诊断 1693→1504（全部轮次累计）。

归类结论（第 22~35 轮）：

| 类别 | 库（轮次） | 诊断变化 | 判定依据 |
| --- | --- | --- | --- |
| **真实缺陷（本轮修复）** | normalize-path（22/30/32/34） | 2→5 | `var segs = path.split()` 在 `path = path.slice(2)` 重赋值后 checker 视 receiver 为 any，签名丢失 → segs 被推成 `Record<PropertyKey, unknown>`，`segs.length/pop/join` 报 TS18046×3 + TS2322。详见下方。 |
| 缺依赖级联（TS2307/TS2306） | is-string / is-number-object / is-boolean-object（多轮）、is-symbol、p-waterfall、is-generator-function | 多为 2→2 / 3→4 / 5→1 | 缺 `call-bound`/`safe-regex-test`/`p-*` 依赖， chained 类型退化为 unknown；is-symbol 的 2×TS2322 是类型谓词丢失级联，与第九轮"类型谓词冲突不修"一致。 |
| 动态性/大库反射（固有限制） | p-queue（66→81~115）、fill-range（57→35~43）、object-inspect、pify | 改善或未清零 | TS2571×32（unknown 上运算）、TS2345×18（动态参数）、TS2339 反射访问，多因素叠加，历轮已判非单点可修。 |
| 回调/闭包/`this` 动态参数 | delay / p-debounce / p-locate / map-obj / is-callable | 18→8 / 39→25 / 19→15 / 20→16 | 余项为 TS2683(this)、TS18048(闭包内)、TS2550(ES 版本门槛)、缺依赖，历轮已判定。 |
| 非工具问题 | pWait（31 轮） | DOWNLOAD_FAILED | 下载失败，如实跳过。 |

### 本轮修复：重赋值接收者导致内建方法签名丢失（normalize-path segs）

- **现象**：`if (typeof path !== 'string') throw; path = path.slice(2); var segs = path.split(...)` 中，`segs` 被推成 `Record<PropertyKey, unknown>`（2→5 条诊断，TS18046×3 + TS2322），而正确的 `string[]` 明明就摆在 checker 眼前（无重赋值时 `typeOf(path.split()) = string[]`）。
- **根因**：JS 文件里 `path = path.slice(2)` 让 checkJs 在后续 `path.split()` 处把 receiver 视为 `any`（RHS `path.slice()` 自身 opaque，污染控制流），`getResolvedSignature` 为 none，签名丢失。工具其实已确证 `infer(path) = string`，但 `typeText` 的兜底 `resolveViaTable` 对 call 只能在 resolved signature 存在时取返回类型，此处拿不到 → source 丢失；`segs` 转而靠 `segs[k]` 索引约束（`Record<PropertyKey, unknown>`）+ `.pop()` 方法形状兜底。
- **修复**：`typeText` 增加 `builtinCallResultFromReceiver` 兜底——当 call 的 checker 类型 opaque 且是 `X.method()` 形式时，仅当 receiver 的**推断表类型**已是具体内建 primitive（string/number/Date）、且方法在该族的 `UNIQUE_BUILTIN_METHODS` 中、`BUILTIN_METHOD_RETURN` 有确定返回（如 `split → string[]`）时，返回该 lib 签名结果。**不是按方法名臆测 receiver**：receiver 类型必须先被独立确证。
- **效果**：with-reassign 与真实 normalize-path 模式的 `segs` 均为 `string[]`，segs 相关 TS18046×3 + TS2322 清零；完整样本诊断 5→1（余 1 条 `ch = path[2]` 的 `string|undefined`，属既有的字符串索引问题，原 JS 在 checkJs 下同型，不在本信号范围）。`test/realLib.test.ts` 新增回归测试 `builtin method return survives a reassigned receiver`，全套 **191/191 全绿**，typecheck/build 通过。

### 定时循环续跑（基于 0.1.10，第 36 轮起）

- 背景：第 21~35 轮的 40 轮计划因沙箱休眠中断，任务系统失联；本轮从 `round_36` 用最新代码（0.1.10，含 segs 修复）重启循环，`START_ROUND=36 ROUNDS=60 INTERVAL=600 N=3`，脚本按已落盘文件跳过，从第 37 轮续跑。循环交由任务系统管理，避免再次脱离。
- **端到端验证 segs 修复**：normalize-path 名字已进过 TESTING_LOG，被探针"已测过滤"永久排除，随机轮次不会再抽到它。故用 `verify-latest.mjs` 直接对真实 `normalize-path/package/index.js` 转换：产物为 `var segs: string[] = path.split(...)`，segs 相关 TS18046×3 + TS2322 **全部清零**，诊断 **2→1**（余 1 条 `prefix` 的 `string|undefined`，属既有字符串索引问题，原 JS 在 checkJs 下同型）。segs 修复在最新代码上端到端确认生效。
- **第 36 轮新信号：is-arrayish（1→4，TS2339×4 on `never`）**：产物 `obj: Array<unknown> | string | unknown[]` 过窄，TS 控制流在 `typeof obj === 'string'` 与 `instanceof Array`/`Array.isArray` 守卫负分支把 `obj` 收窄为 `never`，`obj.length/splice/constructor` 报 TS2339。实测不同注解：`unknown`→3、`object|string`→3、`Record<PropertyKey,unknown>|string`→2、`any`→0；原始 JS 在 checkJs 下本就是隐式 any（TS7006×1）。结论：这是**纯 duck-typing 库**（函数靠 `length/splice/constructor.name` 结构检测，无类型信息可推），任何安全注解都无法归零，与历轮"类型谓词/成员访问冲突不修"一致，归类为**固有限制，不修**（避免动核心守卫反推逻辑引入回归）。

### 可靠类型信息来源扩展（三项优先级改进）

基于"还能从哪里获取可靠类型信息"的梳理，实现三项实测驱动的改进（全套 **196/196 全绿**，typecheck/build 通过）：

1. **控制流窄化取点（checker 已算好的收窄类型）**：实测确认即使 `checkJs: false`，checker 在守卫真分支的引用点也给出精确收窄类型（`x.length` 处 `x=string`、`x.getTime` 处 `x=Date`），而普通引用点（调用/初始化器/方法接收者）仍是 any——即 checker 自己就是"是否收窄"的天然判据。新增 `controlFlowNarrowedType`，在 `if` 真分支、三元真支、`&&` 右操作、`switch` case、自定义谓词守卫体内直接读该类型作为 source；严格过滤 any/unknown/never/`{}`/`object`/含 any 容器，确保具体调用点/迭代/内建证据仍优先。**新增能力**：`switch (typeof x) { case 'string': x.length }` 从错误的 `{ length: number }` 修为 `string`（语法反推只能匹配 `typeof x === 'literal'` 二元式，switch 完全看不到）；`instanceof`/谓词守卫体同样命中。普通未守卫使用点不受污染（保留属性形状保守推断）。
2. **结构化槽位投影替换字符串投影**：`projectSlotType` 靠解析打印出的类型字符串投影，遇类型参数含逗号（函数类型）会失败并双重包装——`const m: Map<string, any> = new Map<string, (a: number, b: string) => void>()` 曾输出 `Map<string, Map<string, ...>>` + TS2322。新增 `structuredSlotType`，用 checker 对初始化器的 `getTypeArguments`/数组索引类型沿槽位路径结构化投影，优先于字符串投影；过滤改用 widened flags（避免函数返回 `void` 字样被文本正则误杀）。修复后输出 `Map<string, (a: number, b: string) => void>`，strict 1→0。tuple 括号场景（ `[any, any]` ）属数组字面量元素推断、非投影范畴，未触及。
3. **内建返回的确定兜底**：实测确认 checker 对 `Object.keys/values/entries`、`Array.map`、`JSON` 等在可自然触发场景都直接给出正确返回类型，`BUILTIN_METHOD_RETURN` 与 `UNIQUE_BUILTIN_METHODS` 无缺口——补这些条目属死代码，按"不写无效代码"原则未加。找到并修复真实缺口：`join`/`toString` 返回 `string` 与元素类型无关，但当 checker 把链式调用（`mk().join(',')`，receiver opaque）判为 any 时拿不到。新增 `ARRAY_SCALAR_RETURN`，在 `builtinCallResultFromReceiver` 中当 receiver 的推断类型被独立确证为数组时返回确定类型（非按方法名臆测）。`const s: any = mk().join(',')` 由 any → `string`。

## 定时压测第 38~41 轮（会话内连跑 · 基于 0.1.11 最新代码）

昨晚循环断在第 37 轮（沙箱休眠），本次在主会话内**同步连跑**第 38~41 轮避开休眠，全部基于当前 HEAD `10c3567`。四轮合计抽到：define-properties / pWait / normalize-path / is-arrayish / is-callable / p-waterfall / is-boolean-object / p-series / fill-range。**无新缺陷**，逐项归类：

| 库（轮次） | 诊断变化 | 归类 |
| --- | --- | --- |
| define-properties（38） | 8→6 | 余项 TS2307×2（缺 `object-inspect`/`define-data-property` 依赖）、TS7053 动态下标、TS2345/TS18046 回调谓词 unknown —— 缺依赖级联 + 动态性，历轮已判定 |
| pWait（38） | DOWNLOAD_FAILED | 网络/包名问题，如实跳过 |
| normalize-path（38/39/41） | 2→1 | 余 1 条 TS2322 `string\|undefined` 字符串索引，原 JS 在 checkJs 下同型，已知边界 |
| is-arrayish（39/41） | 1→4 | TS2339×4 on `never`，纯 duck-typing 库，任何安全注解都无法归零，已判固有限制不修 |
| is-callable（39） | 20→15 | 余 TS2584/TS2304（缺 DOM lib：`document`/`HTMLAllCollection`）、TS2345/TS2349/TS2554（动态调用/反射）—— 环境缺失 + 动态性，非单点可修 |
| p-waterfall（40） | 5→1 | 余 TS2307 缺 `p-reduce` 依赖，级联 |
| is-boolean-object（40） | 2→2 | TS2307/TS2306 缺 `call-bound` 依赖，级联 |
| p-series（40） | 1→1 | TS18046 `task` unknown（回调闭包参数），历轮已判 |
| fill-range（41） | 57→35 | TS2345×18 动态参数、TS2339×9 反射访问，历轮已判非单点可修 |

**关键发现：候选池已榨干**。`已测过滤后候选数` 恒定 20，但四轮里 normalize-path/is-arrayish/fill-range/is-boolean-object 被反复抽到——因为 `MANUAL_TESTED`/日志正则只覆盖部分包名，未测与已测库混在同 20 个池子里反复出现。继续跑只会重复这些库，发现新缺陷的概率极低。**下一步应先扩充候选池**（`random_probe.ts` 的 `POOL` / `MANUAL_TESTED`）再跑，否则边际收益趋近于零。代码侧本轮无需改动，196/196 仍全绿。

## 定时压测第 42~44 轮（扩充候选池后 · 发现新库）

因 38~41 轮候选池枯竭（反复抽同几库），先给 `random_probe.ts` 的 `POOL` 补充 22 个新的小型纯 JS 库、并把 21~41 轮已充分归类的库补进 `MANUAL_TESTED` 去重，再续跑。新库成功被抽到，归类如下：

| 库（轮次） | 诊断变化 | 归类 |
| --- | --- | --- |
| dot-prop（42） | 40→22 | 大幅改善；余项 TS7053×7（`parent[key]` 动态下标）、TS2345×5（动态路径参数）、TS2322×4 等，全是动态属性访问，无可靠类型信息，历轮已判 |
| p-whilst（42） | 4→1 | 余 TS2345 `unknown` 传入回调，动态性 |
| snake-case（42） | 2→2 | TS2307×2 缺 `tslib`/`dot-case` 依赖，级联 |
| clone（43/44） | 50→53 | **唯一诊断上涨，已 dump 逐条确认**：净增 3 条是 `depth = circular.depth` 类 unknown→`number\|undefined` 赋值（54/55/57 行）。原 JS 中 `circular` 为隐式 any 不报错，转显式 unknown 后触发 TS2322——**去 any 化的必然代价，非推断错误**。库靠 `Object.keys` + constructor 反射做深拷贝，全 53 条同类，无可靠类型信息。归类固有限制不修（修需引入"赋值约束跨属性传播"，影响面过大、易回归） |
| p-all（43/44） | 4→1 | TS2307 缺 `p-map` 依赖，级联 |
| is-object（43） | 1→0 | 清零 |
| safe-buffer（44） | 13→9 | 改善；余 TS2339×4（`Buffer.from/alloc` 缺 Node 类型上下文）、TS7053 动态下标等，环境/动态性 |

**结论**：本轮 7 轮（38~44）共 21 个库样本，**无新的可修真实缺陷**。扩充候选池后已能持续抽到新库，去重清单同步更新（新测库已补入 `MANUAL_TESTED`）。代码无需改动，196/196 仍全绿、typecheck 干净。

## 待选库（尚未测试，供下一轮参考）

预留候选：`visionmedia/bytes` src 源码目录、`jshttp/ms`、`sindresorhus/p-finally`、`component/emitter`、`feross/standard` 依赖链小库。扩充时优先加入这些，并把本轮反复出现的库（normalize-path/is-arrayish/fill-range）补进 `MANUAL_TESTED` 去重。

> 拉取失败或网络不可用时如实记录并跳过，不要伪造结果。每轮聚焦一个真实缺陷做扎实，不追求诊断数清零——`unknown`/`void` 是保守设计的正确兜底。

## 用户缺陷清单 2.x 三项修复（@deany/core 0.1.12）

用户对 0.1.5 报告的 2.1/2.2/2.3/2.4 四项，逐条复现后：2.3（递归）与 2.4 的 `+`（可能字符串拼接）维持固有边界不修；其余三项全部修复，均经最小复现确认 + checkJs:false/true 双验证 + strict 诊断清零。全套 **203/203 全绿**（196→203，新增 7 项回归），typecheck/build 通过。

- **2.1 Map/Set 无注解泛型反推（新能力）**：`const m = new Map(); m.set('k',1); const v = m.get('k')` 原输出 `Map<unknown,unknown>` + `v: unknown`。根因：`collectMutationEvidence` 虽已支持 `map`/`set` 变异收集，但只在**显式 `: any` 槽位投影**路径用到；`new Map()` 无注解场景只做 `any→unknown` 替换，从不收集 `set/add`。修复分两步：① 新增 `containerInstantiationFromMutations`，对 `new Map()/new Set()` 无类型参数且 checker 报 `Map<any,any>` 的 owner，收集 `set(k,v)` 的 key/value、`add(v)` 的 value 合成 `Map<K,V>`/`Set<V>`（协变证据，与数组 push 同源）；② 扩展 `builtinCallResultFromReceiver`，当 receiver 的**推断表类型**已是具体 `Map<K,V>` 时，`get→V|undefined`、`has/delete→boolean`、`clear→void`（receiver 驱动，非按方法名臆测）。结果 `m: Map<string,number>`、`v: number|undefined`，strict 0。无写入证据仍退化 `Map<unknown,unknown>`；显式 `new Map<string, number>()` 不受影响。调试中发现并修正一处正则笔误（`Map$<` → `Map$`）。
- **2.2 构造器参数纳入调用点反推**：`class Point { constructor(x,y){...} } new Point(1,2)` 原输出 `x: unknown; y: unknown` + TS2339×2（字段未提升），而普通方法参数 `c.m(1)` 早已能从调用点反推。根因：`callsOf` 只收集 `ts.CallExpression`，`new Point()` 是 `ts.NewExpression`，构造器签名永远匹配不到调用点。修复：新增 `CallSite = CallExpression | NewExpression`，`callsOf` 同时收集两者的 resolved signature（`getResolvedSignature` 对 new 返回构造器声明），参数分支用 `call.arguments?.[index]`（NewExpression.arguments 可选）。结果 `constructor(x:number,y:number)` + `x!/y!: number` 字段提升，strict 0；普通方法反推不受影响。`this.x = x` 字段类型来自参数已被反推后的 `resolver.typeOf`。
- **2.4 纯数值运算符操作数推 number**：`function sub(a,b){return a-b}` 原 `a/b: unknown` + TS18046×2。根因：`arithmeticNumberType` 只在另一侧已是 number 时才推 number，无证据的 `-` 推不出；位运算则无条件 `addSource('number')`。修复：新增 `NUMERIC_COERCION_OPERATORS = {-,*,/,%,**}`（刻意排除 `+`），操作数与位运算一样无条件收 number 证据（JS 语义下必然数值强转，`'a'-'b'` 得 NaN 但操作数仍被数值化）。结果 `sub/div: a:number,b:number`，strict 0；`+` 仍保守推 unknown（可能字符串拼接），不被污染。有 bigint 具体来源时不被覆盖。

**2.3（递归）/ 2.4 的 `+`**：与 0.1.2 一致，属正确取舍。引擎只向前迭代、不假设函数自身签名，递归自调用不构成返回值证据；`+` 无证据时可能是字符串拼接，保持 unknown 是"不臆测"的正确表现。

**文档**：README 补 `convertSource(fileName, source, options, resolver?)` 的醒目说明——第 4 个 resolver 省略时所有使用证据推断（赋值/调用点/算术/容器变异/收窄）全部关闭，无 JSDoc 声明一律退化 `unknown`（CLI 自动构建 resolver 不受影响）；示例改为正确传 `createUsageResolver`。容器变异章节补无注解 Map/Set 反推样例。
