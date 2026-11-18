# deany 支持 Flow 语法 —— 可行性评估

> 评估日期：2026-11-18。结论：**技术上可行但需分层；建议先做 A 档（识别并跳过已有 Flow 注解），B/C 档视真实目标决定。**
> 本次仅评估，未修改任何代码。

## 一、核心结论

deany 是「**补类型**」工具——假设输入是「没有注解的 JS」或「满是 any 的 TS」，往里**插入**类型。
而 Flow 文件**本身已写满类型注解**，真实需求是「**翻译已有类型**」（Flow → TS）。这是两件事。

直接用现有流程处理 Flow 文件会**重复插入**，产出非法语法：

```js
// 输入（Flow）
function add(a: number, b: number): number { return a + b; }
// 当前工具输出（坏）
function add(a: unknown: number, b: unknown: number): unknown: number { ... }
```

**根本障碍不是「解析」，而是工具定位**：必须先让工具识别「这里已经有类型了」，才谈得上翻译。

## 二、实测：TS 编译器（5.9）对 Flow 语法的解析能力

| Flow 语法 | TS 能否解析 | 说明 |
| --- | --- | --- |
| `function f(a: number): string` | ✅ | 与 TS 语法重叠 |
| `type User = { name: string }` | ✅ | 重叠 |
| `interface Shape { area(): number }` | ✅ | 重叠 |
| `import type { Foo } from './foo'` | ✅ | 重叠 |
| 字面量联合 `'a' \| 'b'` | ✅ | 重叠 |
| `?number`（Flow 可空） | ✅ 解析 | 但语义与 TS `?` 不同，需转换 |
| `{\| a: string \|}`（精确对象） | ❌ | `Property or signature expected` |
| `opaque type ID = string` | ❌ | `Unexpected keyword` |
| 泛型箭头 `<T>(x: T) => T` | ❌ | 被当成 JSX 解析 |
| variance `+T` / `-T` | ❌ | `Property or signature expected` |
| `(value: number)` 类型强转 | ❌ | `'=>' expected` |
| `$ReadOnly` / `$Exact` / `$Shape` 等工具类型 | ⚠️ | 当普通标识符解析，语义未转换 |

**要点**：约一半高频 Flow 语法与 TS 重叠（TS 能解析但工具会重复注解）；另一半 Flow 专有语法 TS 解析器**根本无法解析**，必须先做文本预处理或引入独立解析器。

## 三、实现层次

### A 档（低风险，推荐先做）—— 识别并跳过已有 Flow 注解
- 处理函数/参数节点上已有的 `typeAnnotation`，有则**跳过**插入 `unknown`，避免 `a: unknown: number`
- 识别 `// @flow` 头注释作为「Flow 文件」信号
- 效果：`type`/`interface`/基础类型/联合/泛型等重叠语法**原样保真**输出
- 工作量：小。零臆测，不破坏现有能力

### B 档（中等）—— Flow 专有类型语法归一化
- 新增 `normalizeFlowType`：`?T`→`T | null | undefined`、`{| |}`→`{...}`、`$ReadOnly<T>`→`Readonly<T>`、`$Exact`、对象字段 `,`→`;` 等
- **难点**：专有语法 TS 解析器解析不了，需先文本预扫描改写成 TS 可解析形式，再走 AST——这是主要工程量
- 可靠覆盖需引入 `flow-parser`（npm）做独立解析

### C 档（高风险，不建议）—— 完整 Flow 支持
- 集成 `flow-parser` AST 与 TS AST 双轨，做完整语义翻译
- Flow 的 variance、opaque、existential `*`、`$` 工具类型与 TS 差异大，很难「可靠不臆测」
- 工作量接近重写转换器

## 四、建议

1. **先做 A 档**：防御性能力，风险极低、立竿见影，符合「可靠、不臆测」原则。让 deany 至少**不破坏** Flow 文件，重叠语法正确保真。
2. **B 档取决于目标**：
   - 只求「别把 Flow 文件转坏」→ A 档足够
   - 求「批量把 Flow 项目迁到 TS」→ 本质是个**迁移器**，建议直接用成熟方案（Facebook 官方 `flow-to-ts` codemod），不必在 deany 上从头造
3. **C 档不建议**：投入产出比低，且与 deany 的核心定位（usage 驱动补类型）偏离。

## 五、技术前提（若日后启动）

- 当前零运行时依赖，仅 `typescript` + `tsx` 开发依赖
- 若做 B/C 档，需评估新增 `flow-parser` 依赖的体积与维护成本
- 解析入口：`src/convert.ts` 的 `convertSource`（`ts.createSourceFile(..., ScriptKind.JS)`）与 `src/inferAny.ts` 的 `ts.createProgram`
- 类型归一化入口：`src/normalize.ts` 的 `normalizeJsDocType`
