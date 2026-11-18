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

## 待选库（尚未测试，供下一轮参考）

小型、开源、可靠的候选：`sindresorhus/p-map`、`sindresorhus/p-filter`、`visionmedia/bytes`（src 目录）、`jshttp/ms`、`isaacs/yallist`、`feross/once`、`raynos/wrappy`、`component/inherits`、`sindresorhus/is-observable`、`sindresorhus/p-defer`。

> 拉取失败或网络不可用时如实记录并跳过，不要伪造结果。每轮只处理一个库，聚焦做扎实。
