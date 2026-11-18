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

## 待选库（尚未测试，供下一轮参考）

预留候选：`visionmedia/bytes` src 源码目录、`jshttp/ms`、`sindresorhus/p-finally`、`component/emitter`、`feross/standard` 依赖链小库。

> 拉取失败或网络不可用时如实记录并跳过，不要伪造结果。每轮聚焦一个真实缺陷做扎实，不追求诊断数清零——`unknown`/`void` 是保守设计的正确兜底。
