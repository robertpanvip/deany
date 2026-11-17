# jsdoc2strict-ts

把带 JSDoc 的 JavaScript 转成**严格 TypeScript**，产出可直接交给 `tsc --strict` / [scriptc](https://scriptc.dev/) 编译的 `.ts` 源码。

核心思路：用 TypeScript Compiler API 解析 JS，在原源码位置上插入类型注解（保留原有代码与注释），并把 JSDoc 的松散类型语法归一化为 TS 类型语法。所有没有类型来源的槽位默认补 `unknown`，避免隐式 `any` 掉进 scriptc 的 dynamic tier。

## 安装

```bash
npm install
npm run build
```

CLI：

```bash
node bin/jsdoc2ts.js <input.js|dir> --out <output.ts|dir> [options]
```

| 选项 | 说明 |
| --- | --- |
| `--check` | 转换后在内存中用 `strict` 模式类型检查，失败返回非 0 |
| `--init-config` | 在输出旁生成一份 strict `tsconfig.json` |
| `--no-banner` | 不插入「生成文件」头注释 |
| `--no-typedef` | 不为 `@typedef` / `@callback` 生成类型别名 |
| `--no-annotate` | 不给没有 JSDoc 的参数/返回值补 `unknown` |
| `--no-infer-usage` | 关闭「从使用证据反推 JS 隐式 any」（默认开启） |
| `--no-callback-params` | 关闭「给缺少上下文类型的回调参数补 `unknown`」（默认开启） |
| `--array-shorthand` | 输出 `T[]` 而不是 `Array<T>` |
| `--loose` | 保留 `any` / `*` / `?` 为 `any`（不推荐） |
| `--default-type <t>` | 兜底类型，默认 `unknown` |

示例：

```bash
node bin/jsdoc2ts.js examples/input.js -o examples/output.ts --check --init-config
npx tsc -p examples/tsconfig.json --noEmit
```

目录批量转换：

```bash
node bin/jsdoc2ts.js src --out ts-src --check --init-config
```

## 反推并替换已有的 `any`（infer-any）

适用于**已经是 TS、但到处写着 `any`** 的代码：从使用点反推真实类型，再原位替换。

```bash
node bin/jsdoc2ts.js infer-any src --out ts-inferred --project tsconfig.json --check
node bin/jsdoc2ts.js infer-any app.ts -o app.inferred.ts --check
```

证据来源：

| 证据 | 例子 |
| --- | --- |
| 变量初始化器 | `const name: any = 'Ada'` → `string` |
| 赋值语句右侧 | `count = 42` → `number` |
| 调用点实参 | `takeNumber(count)` 且形参为 `number` → `number` |
| 函数外部调用实参 | `greet(who: any)` + `greet('Ada')` → `string` |
| 函数 `return` 语句 | `function f(): any { return 123 }` → `number` |
| 属性赋值 | `this.value = 'ok'` → `string` |
| 属性访问集合 | `x.foo` / `x.bar` → 合成 `{ foo: T; bar: U }`（仅当无其他证据时） |

证据按**方差**分组并按各自规则合并：

- **协变来源**（初始化器、赋值右侧、`return`、算术、`typeof`）：描述「值是什么」。多个不同来源不再视为歧义，而是合并为**联合类型**——既被赋 `number` 又被赋 `string` 的 binding，真实类型就是 `number | string`。字面量会放大（`42` → `number`），嵌套联合展平去重，顺序稳定。
- **逆变约束**（作为实参传入形参）：描述「值必须满足什么」。多个调用点约束取**交集**——同时传给 `f(number|string)` 和 `g(boolean|string)` 的值只能是 `string`。无来源时以约束为准；有来源时约束用于收窄。
- **属性形状**是最后手段，仅当上面两类都没有证据时才用来合成对象类型，避免 `arr.push` 之类 incidental 访问污染数组推断。

联合类型成员会按需加括号（函数成员、嵌套位置）以保证严格语法正确。只有完全没有任何证据时才保留 `any` 并报告 `no usage evidence`。

**链式传播（fixed point）**：推断是迭代到收敛的——一个已经推断出的类型会作为证据喂给下一轮，因此「函数返回 → 接住它的变量 → 再接住的变量」可以正向串起来，且**跨文件 / 跨 import** 同样生效：

```ts
// a.ts
export function load(): any { return 42; }   // → number
// b.ts
import { load } from './a.js';
export const snapshot: any = load();          // → number（反查 load 的推断返回类型）
export const alias: any = snapshot;           // → number（再反查 snapshot）
```

`infer-any` 与 JS 隐式 any 反推（`createUsageResolver`）共用这套迭代引擎。推断结果只增不改（一旦确定就固定），最多 16 轮，实测大型项目（lodash 单文件 579KB / async 102 文件）均在 1 秒内完成。

**嵌套 any 槽位投影**：推断表存的是「整个声明的值类型」，但替换时只把 `any` 所在的那一个槽位投影出来，避免双重包装：

```ts
const a: any[] = [1, 2];                    // → number[]（不是 Array<number>[]）
const b: Array<any> = [1, 2];               // → Array<number>
const m: Map<string, any> = new Map<string, number>(); // → Map<string, number>
const e: any[] = [];                        // → 保留 any[]（空数组无元素证据，不推断成危险的 never[]）
```

**容器变异推断**：往容器槽位里写值的方法调用，是元素/值类型的协变来源，会与初始化器等证据合并为联合；而 `.length` / `.map` 这类只读访问仍当噪音排除。这样推断出的元素类型不会窄到让写入操作报错：

```ts
const a: any[] = [1]; a.push('x');                        // → (number | string)[]（不是 number[]，避免 push 报 TS2345）
const a2: any[] = [1]; a2[1] = 'x';                       // → (number | string)[]
const e: any[] = []; e.push('x');                         // → string[]（空数组有写入证据时不再保留 any）
const m: Map<string, any> = new Map(); m.set('a', 42); m.set('b', 'x'); // → Map<string, number | string>
const s: Set<any> = new Set(); s.add(1); s.add('x');      // → Set<number | string>
```

这里选**联合类型**而非元组：`push`/`set`/`add` 是运行时动态追加，元组（固定长度与位置）无法容纳后续写入，联合才是与 TypeScript 原生推断一致、且对 ScriptC 友好的表示。

不嵌套的 `any` 仍按整个类型推断（`let x: any = [1,2]` → `Array<number>`）；函数返回类型 `Promise<any>` + `return 1` → `Promise<number>`，均不受影响。

```text
app.ts:6 any -> number
app.ts:33 any -> number | string          # 冲突证据合并为联合类型
files: 1, changed: 1, inferred sites: 6, unresolved: 0
strict type check passed.
```

注意：默认跳过 `as any` / `<any>x` 断言（这类写法通常是有意的逃逸口），需要时用 `--assertions` 打开。推断只改类型注解，不动运行时代码。

CLI：

| 选项 | 说明 |
| --- | --- |
| `-o, --out <path>` | 输出文件（单文件）或目录（目录输入） |
| `--project <path>` | 读取指定 tsconfig.json 的编译选项 |
| `--check` | 对推断结果做 strict 类型检查 |
| `--assertions` | 也处理类型断言里的 any |
| `--quiet` | 隐藏未解决的站点 |

## JS 里没有 JSDoc 的隐式 any

JS 文件不需要写 JSDoc 也能推断：`jsdoc2ts` 默认会对**没有 JSDoc 类型**的声明，先用使用证据（赋值、调用点、算术运算、数组元素、`return` 等）反推类型，推不出来才回退 `unknown`。

```bash
node bin/jsdoc2ts.js examples/js-infer-input.js -o examples/js-infer-output.ts --check
```

输入（几乎没有 JSDoc）：

```js
let count;
count = 42;

function addOne(value) {
  return value + 1;
}

let names;
names = ['a', 'b'];
```

输出：

```ts
let count: number;

function addOne(value: number): number {
  return value + 1;
}

let names: Array<string>;
```

JSDoc 始终优先于推断。想关掉这个行为，用 `--no-infer-usage`。

## 库用法

```ts
import { convertSource, checkStrict, strictTsConfig } from 'jsdoc2strict-ts';

const { output, diagnostics } = convertSource('a.js', source, {
  unknownForLoose: true,
  annotateUntyped: true,
  emitTypedefs: true,
});

const check = checkStrict('a.ts', output);
if (!check.ok) {
  console.error(check.diagnostics);
}

// 反推已有 TS 里的 any
import { inferAnyInProject, readCompilerOptions } from 'jsdoc2strict-ts';
const options = readCompilerOptions('tsconfig.json');
const inferred = inferAnyInProject(['src/a.ts'], options);
for (const file of inferred) {
  for (const site of file.sites) {
    console.log(site.line, site.inferred ?? site.reason);
  }
}
```

## 支持的 JSDoc

| 标签 | 处理 |
| --- | --- |
| `@param {T} name` / `[name=1]` / `{...T} args` | 参数类型、可选标记、rest 类型 |
| `@returns {T}` / `@return {T}` | 返回类型；async 函数自动包 `Promise<T>` |
| `@type {T}` | 变量、类字段、`this.x = ...` 赋值 |
| `@property {T} name` | 与 `@type {Object}` / `@typedef {Object}` 合成对象类型 |
| `@typedef {T} Name` | 生成 `type Name = T;` |
| `@callback Name` | 生成 `type Name = (...) => R;` |
| `@template T, U` | 生成函数泛型 `<T, U>` |
| `@this {T}` | 插入首参数 `this: T` |

类型归一化：

- `Array.<T>` → `Array<T>`（可选 `T[]`）
- `Object.<K,V>` → `Record<K, V>`
- `?T` → `T | null`，`!T` → `T`
- `*`、`?`、`any` → `unknown`
- `function(A, B): C` → `(arg0: A, arg1: B) => C`
- `{...T}` → `T[]`

## 设计取舍

- **原位插入**而非重新打印 AST：保留用户代码风格与注释，diff 可控。
- **回调参数精准标注**：作为实参传入的匿名函数，只有当参数确实没有上下文类型且解析为 `any`（即会触发 TS7006）时才补 `unknown`；`map` / `filter` / `reduce` 等有上下文推断的回调保持原样，从不加注解。无括号单参箭头会自动补括号写成 `(x: unknown) => ...`。可用 `--no-callback-params` 关闭。
- **生成器/构造器/setter 不写返回类型**：避免写出 TS 不接受的签名。
- **`this.x = ...` 提升为类字段**：配合 `strictPropertyInitialization`，在构造器里的赋值仍然成立。
- **strict tsconfig**：开启 `strict`、`noImplicitAny`、`noUncheckedIndexedAccess`、`verbatimModuleSyntax` 等，贴合 scriptc 的配置读取方式。

## 验证

```bash
npm run typecheck   # 项目自身严格检查
npm test            # 63 项单元测试（含 JS 隐式 any 反推、链式/跨文件传播、嵌套 any 槽位投影、容器变异联合推断、方差感知的联合/交集推断、回调参数与真实项目回归）
npm run demo        # JSDoc -> TS 端到端 + --check
npm run infer-demo  # TS 显式 any 反推端到端 + --check
npm run js-infer-demo # JS 隐式 any 反推端到端 + --check
```

## 已知限制

- 只解析每行一个标签的 JSDoc（多行描述会并入上一个标签）。
- 不处理 `@implements`、`@extends`、`@override` 与复杂 `@enum`。
- 非常复杂的 JSDoc 类型（嵌套函数签名、条件类型）按原样透传，可能需要人工微调。
- `infer-any` 把协变来源合并为联合、逆变约束合并为交集；只有完全无证据（或上游已是 `any`）时保留 `any` 并报告。跨文件的复杂泛型/重载调用可能证据不足。
- 转出的 TS 保证类型严格，但 scriptc 的 Tier 3 限制（如 `eval`、动态元编程）仍需另行处理。

### 真实项目压测说明

已用 lodash / async / debug 三个常见 JS 库做过全量转换压测，并据此修复了以下问题：

- `module:Foo.Bar` 命名空间前缀不再产生语法错误（剥离为 `Foo.Bar`）。
- 联合中的函数类型会正确加括号（消除 `TS1385`），推断出的联合类型同样处理。
- 裸泛型（`Array` / `Promise` / `Map` / `Set` / `Record`）自动补 `unknown` 类型参数（消除 `TS2314`）。
- 泛型类型参数的嵌套类型会递归归一化。
- JSDoc 引用了但本文件未定义的自定义类型名，会生成 `type X = unknown;` 兜底别名并给出警告（消除 `TS2304`，名字保留供后续补全）；`@template` 泛型参数不会误加别名。
- 缺少上下文类型的回调参数自动补 `unknown`（消除绝大多数 `TS7006`），有上下文的回调不动；实测 lodash 的 239 处隐式 any 参数全部清零。

仍存在的局限（属于"JS 动态模式 → strict TS"的固有难度，非语法 bug）：

- `unknown` 参与运算/索引/赋值会触发 `TS18046/TS2345/TS2322`；函数内 `this` 触发 `TS2683`。这些需按具体业务补类型或用 `infer-any` 进一步收窄。
- 回调参数的上游若已是 `any` / `unknown`（如 `anyArray.map(x => ...)`），其上下文类型为 `any`，此时回调参数保持原样——标注它无法修复上游已丢失的类型，属于 unknown 传播问题。
- 跨文件推断把自定义类型（如 `Mixed`）传播到使用点时，使用点文件可能缺少对应兜底别名（该类型只定义在别的文件 JSDoc 中）。
- `window` / `document` / `define` 等运行时全局依赖目标 lib / 环境声明，不由转换器兜底。
