# deany

**deany**（de-any，去掉 `any`）把带 JSDoc 的 JavaScript、无 JSDoc 的纯 JS，以及满是显式 `any` 的 TypeScript，转为由真实使用证据推断出的**严格 TypeScript**，产出可直接交给 `tsc --strict` / [scriptc](https://scriptc.dev/) 编译的 `.ts` 源码。

> CLI 命令为 `deany`；旧的 `jsdoc2ts` 保留为向后兼容别名，行为完全一致。

核心思路：用 TypeScript Compiler API 解析 JS，在原源码位置上插入类型注解（保留原有代码与注释），并把 JSDoc 的松散类型语法归一化为 TS 类型语法。所有没有类型来源的槽位默认补 `unknown`，避免隐式 `any` 掉进 scriptc 的 dynamic tier。

> 两处刻意的弱证据例外（都**不会**覆盖真实证据）：
> - **无锚点 `+`**：`function combine(a,b){ return a+b }` 里 `+` 可能是数字加法也可能是字符串拼接，无法确定；参数补 `any`（忠实还原原始隐式-any JS，使表达式在 strict 下合法，而非 `unknown` 导致 TS18046），返回补 `string | number`（`+` 的真实结果类型，严格优于 `unknown`）。箭头 `(a,b)=>a+b` 同理。若函数名是数值语义词（`add`/`sum`/`count`/`total`/`max`/`min`…），参数改为弱 `number` 提示；真实调用点或 JSDoc 会立即覆盖它。有 number 锚点的 `+`（如 `a+1`、或已知数值的嵌套表达式）返回 concrete `number`，不被放宽。
> - **变量名弱提示**：无初始化器、且无任何使用证据的局部变量可按名字得到低置信度类型——`let names;`→`unknown[]`、`let items;`→`unknown[]`、`let text/userName;`→`string`、`let isReady/isValid;`→`boolean`、`let count;`→`number`。有初始化器、赋值、JSDoc、属性访问等真实证据时立即覆盖，名字提示永不覆盖真实数据。函数返回类型**绝不**按名字推断（会在 strict 下 TS2322）。
> - **无调用点的 reduce**：`list.reduce((a,b)=>a+b, 0)` 的接收者得到泛型签名 `<T>(cb, init:T)=>T`，由 TS 从真实的 `init` 推断累加器类型——不臆测元素类型。无 `init` 时没有类型锚点，保持保守处理。

## 安装

需要 **TypeScript 6.x** 作为 peer 依赖（deany 面向 TS6 语义模型；TS7 因模块导出形态变化、TS5 为旧基线，均不支持，CLI 会给出友好提示）：

```bash
npm install
npm run build
```

CLI：

```bash
deany <input.js|dir> --out <output.ts|dir> [options]
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
deany examples/input.js -o examples/output.ts --check --init-config
npx tsc -p examples/tsconfig.json --noEmit
```

目录批量转换：

```bash
deany src --out ts-src --check --init-config
```

## 反推并替换已有的 `any`（infer-any）

适用于**已经是 TS、但到处写着 `any`** 的代码：从使用点反推真实类型，再原位替换。

```bash
deany infer-any src --out ts-inferred --project tsconfig.json --check
deany infer-any app.ts -o app.inferred.ts --check
```

证据来源：

| 证据 | 例子 |
| --- | --- |
| 变量初始化器 | `const name: any = 'Ada'` → `string` |
| 赋值语句右侧 | `count = 42` → `number` |
| 调用点实参 | `takeNumber(count)` 且形参为 `number` → `number` |
| 函数外部调用实参 | `greet(who: any)` + `greet('Ada')` → `string` |
| 函数 `return` 语句 | `function f(): any { return 123 }` → `number` |
| 函数无带值 `return` | `function f(): any { doWork() }` / `return;` → `void`（async 函数 → `Promise<void>`；生成器 / 构造器 / setter 不适用） |
| 属性赋值 | `this.value = 'ok'` → `string` |
| 属性访问集合 | `x.foo` / `x.bar` → 合成 `{ foo: T; bar: U }`（仅当无其他证据时）；方法调用 `x.for(1)` → 成员记为可调用签名 `(...args: unknown[]) => unknown` |
| 内置 API 的对象槽位 | `Object.defineProperty(x, ...)` / `Reflect.set(x, ...)` 等要求对象的参数 → 逆变约束 `object`（`lib.d.ts` 把这些形参写成 `any`/`T`/`{}` 时也能反推；与更具体的来源共存时以来源为准） |
| 索引读写与 `for...in` | `x[k]`（读或写）/ `for (k in x)` → 逆变约束 `Record<PropertyKey, unknown>`；`Object(value)` 装箱结果也按此处理。空对象字面量 `{}` 被这样使用时升级为该类型（如 xtend / object-assign 的对象拷贝）；有更具体的来源（如调用点 `number[]`）时以来源为准 |
| 参数默认值 / 位运算 / 关系比较 / `in` | `f(x = 5)`→`number`；`x\|0`/`~x`→`number`；`x > 10`→`number \| string`；`'k' in x`→`object` |
| `for...of` / 解构 / `await` / 分支 | `for (v of x)`→`unknown[]`；`{ foo } = x`→对象形状；`await x`→`PromiseLike<unknown>`；`x \|\| fallback`/三元→对侧类型作联合来源 |
| 幂运算 / 注解目标 / 展开 / 短路赋值 | `x ** 2`→`number`；`const n: number = x`→逆变约束 `number`（仅认显式注解）；`[...x]`/`f(...x)`→`unknown[]`（对象展开 `{...x}` 不推）；`x \|\|= 5`/`x ??= 'fb'`→`number`/`string` |
| 迭代回调元素形状 | `Array.isArray(x)` + `x.map(it => it.a.b)` → `x: Array<{ a: { b: unknown } }>`；从已知迭代方法（map/forEach/filter/…）回调首参的属性访问链递归合成元素形状，只精化原本的 `unknown[]`（具体来源仍优先）；`reduce` 等首参为累加器的方法排除 |

证据按**方差**分组并按各自规则合并：

- **协变来源**（初始化器、赋值右侧、短路赋值右侧、`return`、算术含 `**`、`typeof`、分支对侧值）：描述「值是什么」。多个不同来源不再视为歧义，而是合并为**联合类型**——既被赋 `number` 又被赋 `string` 的 binding，真实类型就是 `number | string`。字面量会放大（`42` → `number`），嵌套联合展平去重，顺序稳定。
- **逆变约束**（作为实参传入形参、作为 callee/new 目标、索引/`for...in`/`for...of`/展开目标、赋给带显式注解的变量、`await` 操作数）：描述「值必须满足什么」。多个调用点约束取**交集**——同时传给 `f(number|string)` 和 `g(boolean|string)` 的值只能是 `string`。无来源时以约束为准；有来源时约束用于收窄。内置 API 的对象参数（`Object.defineProperty` / `Reflect.*` 等）即使 `lib.d.ts` 写成 `any` / `T` / `{}`，也会登记一条 `object` 约束（这些槽位的 lib 参数类型无信息量，会被跳过以免 `{}` 与 `object` 相交成空集）。`any` / `unknown` / `never` / `{}` 这类无信息约束会被交集忽略；`object` 与 `Record<PropertyKey, unknown>` 同时出现时保留更窄的后者。`Object(value)` 的 `any` 返回值被视为装箱后的可索引对象。
- **属性形状**是最后手段，仅当上面两类都没有证据时才用来合成对象类型，避免 `arr.push` 之类 incidental 访问污染数组推断。方法调用 `x.for(1)` 会记录为可调用成员 `(...args: unknown[]) => unknown`（而非 `unknown`——后者在 strict 下不可调用，会触发 TS18046）；方法签名一旦确立就不会被后续的普通属性读取降级。

联合类型成员会按需加括号（函数成员、嵌套位置）以保证严格语法正确。只有完全没有任何证据时才保留 `any` 并报告 `no usage evidence`。

**链式传播（fixed point）**：推断按轮迭代——一个已经推断出的类型会作为证据喂给下一轮，因此「函数返回 → 接住它的变量 → 再接住的变量」可以正向串起来，且**跨文件 / 跨 import** 同样生效。迭代在结果不再变化时提前收敛，上限为 16 轮；若超长反向依赖链在 16 轮内仍未收敛，收敛状态会通过 `InferFileResult.diagnostics` 暴露，CLI 会输出警告提示结果可能不完整（而不会静默产出）：

```ts
// a.ts
export function load(): any { return 42; }   // → number
// b.ts
import { load } from './a.js';
export const snapshot: any = load();          // → number（反查 load 的推断返回类型）
export const alias: any = snapshot;           // → number（再反查 snapshot）
```

**从 `typeof` 收窄反推参数与调用点**：函数的 `any` 参数会从函数体里的 `typeof x === '...'` 分支推断出可能取值的联合；这个结果还会**反向传播给传入它的 `any` 实参**（与「返回值 → 接住变量」形成镜像），并继续沿链式 / 跨文件传播。声明顺序无关，靠多轮迭代收敛：

```ts
function format(x: any) {                       // x → number | string（来自两个 typeof 分支）
  if (typeof x === 'string') return 1;
  if (typeof x === 'number') return 2;
}
let value: any;
format(value);                                  // value → number | string（反推调用点实参）
let copy: any = value;                          // copy → number | string（继续链式传播）
```

`Array.isArray(x)` 与 `x instanceof Ctor` 也是标准的类型守卫，按同样方式作为协变来源并反推到调用点：`isArray` 推断为 `unknown[]`（元素类型无可靠证据时不臆造），`instanceof` 推断为构造器的实例类型（本地类、内置类、import 的类均可）。多种守卫并存时合并为联合：

```ts
class Box { v = 1; }
function handle(x: any) {              // x → Box | unknown[]
  if (Array.isArray(x)) return x.length;
  if (x instanceof Box) return x.v;
}
```

若调用点实参本身有更直接的证据（如初始化器），以该证据为准；约束仅在其缺失时用于推断。函数体没有任何收窄信息（`typeof` / `isArray` / `instanceof`）时，参数不会被臆测为具体类型。

**收窄后调用方法的交叉精化**：`typeof x === 'object'`、`'k' in x`、`typeof x === 'function'` 这几类守卫只把值收窄到「无成员」的类别（`object` / `Function`），但分支内真实调用的 `x.render()` / `x.tag` 恰恰声明了它必须有哪些成员。工具把这些**实际访问到的成员**交叉回来源，避免 strict 下的 TS2339 / TS18046，与 `Array.isArray` 精化 `unknown[]` 是同一套结构证据机制（不是「方法名看起来像某类」的臆测——那套危险反推已回退）：

```ts
function handle(x: any) {
  if ('render' in x) { x.render(); }   // x → object & { render: (...args: unknown[]) => unknown; }
}
```

精化只作用于 `object` / `Function` 这类无成员来源，**绝不污染** `instanceof` 推出的具体类（如 `Box`）或具体来源的联合——具体类自带成员表， incidental 访问不会塞进去。该证据标记为弱，后续轮次若有更具体的调用点类型会覆盖它。

**收窄数组上的自定义方法**：`if (Array.isArray(xs))` 之后调用的**非迭代**方法（如 `xs.custom(cb)`）也被当作数组的真实成员交叉进来源——但只给方法本身一个带类型的签名，而**不臆造数组元素类型**（元素仍为 `unknown`）。回调首参的属性链被收集成回调参数形状，因此 `it.a.b` 在 strict 下可用；内置数组方法（push/map/…）被排除，不污染。回调参数不会再被多标一个 `unknown`（那会遮蔽上下文类型、重新触发 TS18046）：

```ts
function f(xs: any) {
  if (Array.isArray(xs)) { xs.custom(it => it.a.b); }
}
// xs → unknown[] & { custom: (callback: (arg: { a: { b: unknown; }; }) => void) => unknown; }
```

**自定义类型谓词守卫**：`function isFoo(x: unknown): x is T` 形式的守卫调用 `if (isFoo(x))` 会把被守卫的实参 `x` 收窄为 `T` 并作为协变来源反推到参数与调用点（谓词类型从 callee 声明的 `TypePredicateNode` 读取，只匹配谓词指名的那个参数，不影响同一调用的其他实参）。与 `typeof` / `instanceof` / `Array.isArray` 守卫一样参与链式与跨文件传播：

```ts
class Foo { a = 1; }
function isFoo(x: unknown): x is Foo { return true; }
function handle(x: any) { if (isFoo(x)) { return x.a; } }  // x → Foo
```

**弱证据的二次精化**：从「方法调用 / 属性访问」合成的对象形状（`{ toFixed: fn }`）属于弱证据，会先临时定型；如果调用点实参在后续轮次推断出了更具体的类型，参数会被**精化**为该具体类型（number 自带 `toFixed`，天然满足这个形状）：

```ts
function format(x: any) { return x.toFixed(2); }  // 先推成 { toFixed: fn }
let value: any = 42;
format(value);                                     // value → number
// 二次精化后 format 的 x → number（而非宽泛的对象形状）
```

强证据（初始化器、赋值、实参、`typeof`/守卫收窄、返回值传播）一旦确定就固定；只有弱证据形状保持可变、等待精化。没有任何具体证据时，才保留方法形状。

**公共 API 不被内部调用点收窄（S4）**：导出函数 / 方法 / 构造器 / 默认导出（含匿名箭头）的参数属于公共契约，**不会**仅因为仓库内部的 `f(具体值)` 调用就被收窄为那个具体类型——外部调用者可以传入任意合法值。这类内部调用点证据记为低置信度的 `weakSources`，不参与定案，但在歧站点的诊断里会说明「仅检测到内部调用点，公共参数保持未收窄」。真正的函数体内部证据（初始化器、`typeof` 守卫、属性/解构形状、同名 `.d.ts` 契约）不受此限制，仍可精确收窄；同名 `.d.ts` 契约置信度最高，甚至能还原 bare `unknown`。非导出的私有声明保持原有调用点推断行为不变。

`infer-any` 与 JS 隐式 any 反推（`createUsageResolver`）共用这套迭代引擎。推断结果只增不改（一旦确定就固定），最多 16 轮；每轮的收敛状态（`rounds` / `converged` / `maxRounds`）记录在 `InferenceTable.diagnostics`，并随 `InferFileResult.diagnostics` 对外暴露，未收敛时 CLI 输出警告。实测大型项目（lodash 单文件 579KB / async 102 文件）均在 1 秒内完成。

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

**无注解容器**：`new Map()` / `new Set()` 即使没有任何 `: any` 注解，也会从 `set(k, v)` / `add(v)` 反推出完整泛型参数，并且读取方法跟着收窄（同样来自调用点证据，非按方法名臆测）：

```ts
const m = new Map();          // → Map<string, number>
m.set('k', 1);
const v = m.get('k');         // → number | undefined（从 receiver 的推断泛型反推）
const s = new Set(); s.add(1); s.add('x');  // → Set<number | string>
```

没有写入证据时仍退化为 `Map<unknown, unknown>` / `Set<unknown>`（比 `any` 安全，不污染下游）。显式写了类型参数（`new Map<string, number>()`）时以用户声明为准，不被反推覆盖。

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

JS 文件不需要写 JSDoc 也能推断：`deany` 默认会对**没有 JSDoc 类型**的声明，先用使用证据（赋值、调用点、算术运算、数组元素、`return` 等）反推类型；函数体没有带值 `return` 时推断为 `void`（async 为 `Promise<void>`），只有其余推不出类型的声明才回退 `unknown`。

```bash
deany examples/js-infer-input.js -o examples/js-infer-output.ts --check
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

## 用同名 `.d.ts` 精确还原 JS

如果 JS 文件旁边有**同名声明文件**（`lib.js` + `lib.d.ts`），`deany` 会自动把 d.ts 的签名与 JS 实现**结合**：d.ts 里已经写好的函数签名、泛型、参数/返回类型、interface/type 别名都是权威契约，直接贴回实现，不再靠 JSDoc 或用法去猜。这让「JS + 声明文件」可以高保真地还原成严格 TS。

```bash
deany lib.js -o lib.ts --check
```

输入 `calc.js`（没有任何 JSDoc）：

```js
function add(a, b) { return a + b; }
const VERSION = '1.0.0';
module.exports = { add, VERSION };
```

旁边的 `calc.d.ts`：

```ts
export function add(a: number, b: number): number;
export const VERSION: string;
```

输出 `calc.ts`：

```ts
function add(a: number, b: number): number { return a + b; }
const VERSION: string = '1.0.0';
module.exports = { add, VERSION };
```

- **优先级**：同名 d.ts > JSDoc > usage 推断 > `unknown`。d.ts 存在时它的签名覆盖 JSDoc。
- **泛型与类型**：`<T>`、`T[]`、`T | null` 等原样保留；d.ts 里的 interface / type / enum 声明会原样合并到输出顶部（与 `@typedef` 同名时跳过，避免重复）。
- **类**：`declare class` 的方法签名与字段类型会贴回同名 JS class 的成员。
- **作用范围**：只处理**同名 d.ts**，不会读取 `import` 进来的第三方 d.ts（这部分由 checker 的上下文类型负责）。
- 不想要这个行为时用 `--no-dts`，将完全退回 JSDoc + usage 推断。

> 说明：d.ts 只描述公共 API 契约，函数体内部的局部变量类型仍需 JSDoc / usage 推断补充；两者结合才得到完整的严格 TS。`noUncheckedIndexedAccess` 等严格选项下，JS 实现体里原本就存在的索引访问告警（如 `items[i]` 为 `T | undefined`）属于实现本身的问题，不由 d.ts 合并修正。

## 库用法

```ts
import {
  convertSource, checkStrict, strictTsConfig,
  createUsageResolver, readCompilerOptions,
} from '@deany/core';

// 使用证据推断（赋值 / 调用点 / 算术 / 数组与容器变异等）依赖 resolver。
// 用与目标文件一致的 compilerOptions 创建，并作为 convertSource 的第 4 个参数传入。
const options = readCompilerOptions('tsconfig.json'); // 或你自己的 ts.CompilerOptions
const resolver = createUsageResolver(['a.js'], options);
const { output, diagnostics } = convertSource('a.js', source, {
  unknownForLoose: true,
  annotateUntyped: true,
  emitTypedefs: true,
}, resolver);

const check = checkStrict('a.ts', output);
if (!check.ok) {
  console.error(check.diagnostics);
}

// 反推已有 TS 里的 any
import { inferAnyInProject } from '@deany/core';
const inferred = inferAnyInProject(['src/a.ts'], options);
for (const file of inferred) {
  for (const site of file.sites) {
    console.log(site.line, site.inferred ?? site.reason);
  }
}
```

> **易踩点：`convertSource` 必须传 `resolver` 才做使用证据推断。** `convertSource(fileName, source, options, resolver?)` 的第 4 个参数是可选的，但**省略它时所有基于使用证据的推断全部关闭**——无 JSDoc 的声明一律退化为 `unknown`（或 `options.defaultType`），赋值反推、调用点反推、算术运算、数组/Map/Set 容器变异、收窄反推等都不会发生，只剩 JSDoc 与字面量注解在起作用。CLI（`deany`）会自动构建 resolver，所以命令行用户不受影响；直接调用库 API 时务必用 `createUsageResolver([...files], compilerOptions)` 创建并传入，且 `compilerOptions` 应与目标项目一致（至少 `allowJs`、`strict`、`target`、`moduleResolution`）。若确实只想要“JSDoc → TS”的字面转换、不要使用证据推断，可以不传，此时退化到 `unknown` 是预期行为。

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
npm test            # 337 项测试（含 JS 隐式 any 反推、链式/跨文件传播、typeof/isArray/instanceof 收窄反推、内置 API 对象槽位反推、callee/new 可调用签名反推、索引/for-in 可索引对象反推、默认值/位运算/比较/in、for-of/解构/await/分支、幂运算/注解目标/展开/短路赋值、迭代回调元素深层形状、typeof function 合法化、catch 变量注解规避、弱证据二次精化、嵌套 any 槽位投影、容器变异联合推断、调用点空数组实参 widening、无调用点 reduce 泛型归约签名、无锚点 + 的 any 保底/string|number 返回与数值命名弱证据、变量名分组弱提示(number/string/boolean/数组)、函数名→返回类型弱提示(boolean/数组/string，get 前缀，opaque return 自动 as 断言)、数值命名只落参数、透明包装穿透(!/括号/as 下的属性/调用/索引/赋值证据)、模板标签 callee、对象展开 object 约束、计算属性名 PropertyKey、赋值式解构形状、class 表达式非法 typeof 回退与 extends 基类约束、yield* 操作数 Iterable 约束、Map/Set/Promise 参数 Iterable 槽位、通用构造函数参数签名、setter 参数反向传播、迭代元素方法 callable、共享方法实参否决字符串族(includes/indexOf)、链式调用返回对象形状(v.foo().bar())、方差感知的联合/交集推断、大写 JSDoc 类型归一化、回调参数、公共 API 导出边界、调用/构造器展开的元组推断、d.ts 变量契约身份匹配、以及完整文件级端到端回归[strict/幂等/确定性/多文件]）
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

随后又用 8 个小型常见库（ms / is-number / fast-deep-equal / p-limit / chalk / debug / semver / nanoid）做了第二轮验证，据此修复：

- JSDoc 的大写内建类型 `String` / `Number` / `Boolean` / `Integer` / `Float` 归一化成 TS primitive（消除包装对象类型导致的 `TS2345` / `TS2362`；如 `parse(str: String): Number` → `parse(str: string): number`）。
- `module.exports = function(){}` / `exports.foo = fn` 这类赋值型函数表达式能正确关联上方 JSDoc（此前 `@param` / `@returns` 全部丢失，参数退化为属性形状推断）。
- 变量初始化器为函数时，不再同时给绑定加一份来自 checker 的函数类型注解（此前与函数本身的注解各写一份、归一化不同，触发 `TS2322` / `TS2355`）；改为只标注函数，由 TS 推导绑定类型。
- `instanceof` 推断泛型类（`Map` / `Set` 等）时用实例化后的类型，并把悬空类型参数与 `any` 槽位归一为 `unknown`（`Set<T>` → `Set<unknown>`，消除 `TS2304`）。

第三轮用另一批无 JSDoc 的小库（mimic-fn / kind-of / xtend / object-assign / is-plain-object / escape-string-regexp / p-try / is-buffer）做了隐式 any 反推验证，据此修复：

- `typeof x === 'function'` 曾把非法类型 `function` 直接写回注解（不是合法 TS 类型名）；现映射为 `Function`（strict 下可调用、可访问 `.name`/`.prototype`，也能接 `Function` 值）。
- catch 子句变量曾从 `err.message` 等推断出对象形状并写回注解，触发 `TS1196`（catch 变量只允许 `any`/`unknown`）；现跳过，保留默认 `unknown`。
- 内置 API 的对象参数槽位（`Object.defineProperty` / `Reflect.*` 等）即使 `lib.d.ts` 把形参写成 `any`/`T`/`{}` 也能反推出 `object` 约束（见上文「证据来源」）。
- 变量作为 callee 被调用（`fn(...)`）或 `new Ctor()` 时，即使在嵌套回调里，也会反推出可调用 / 可构造签名，而不是留在 `unknown`（消除 `TS18046`，如 p-try）；下游若有更具体的 call-site 签名则以具体值为准。
- `x[k]` / `for (k in x)` 目标与 `Object(value)` 装箱结果反推出 `Record<PropertyKey, unknown>`，空对象字面量 `{}` 被这样使用时升级为该类型（消除 `TS2407`/`TS7053`，xtend 清零、object-assign 从 10 个错误降到 1 个）。装箱原始类型（`new String(...)`）不可赋给 `Record`，保留其具体类型而不臆造 `any`。

第四轮按「只认运行时强制 / 语法必然 / 用户显式声明」的原则补强证据（不做"看起来像"的臆测——曾尝试的方法簇反推已据此回退）：
- 参数默认值、位运算（`| & ^ << >> >>> ~`）、关系比较（`< > <= >=` → `number | string`）、`'k' in x` → `object`。
- `for...of` / 数组解构目标 → `unknown[]`；对象解构 → 对象形状；`await x` → `PromiseLike<unknown>`；`x || fallback` / 三元 → 对侧类型作联合来源。
- 幂运算 `x ** 2` → `number`（补齐算术白名单）；`const n: number = x` 的**显式**注解 → 逆变约束 `number`（无注解或 `any`/`unknown` 不算，与具体来源冲突时来源胜出）；`[...x]` / `f(...x)` → `unknown[]`（对象展开 `{...x}` 不推）；短路赋值 `x ||= 5` / `x ??= 'fb'` → `number` / `string`。
- `Array.isArray(x)` 配合 `x.map/forEach(it => it.a.b)` 等已知迭代调用，从回调首参的**属性访问链**递归合成元素形状，把 `unknown[]` 精化为 `Array<{ a: { b: unknown } }>`（多条链合并、只含实际访问的属性；具体来源优先；`reduce` 等首参为累加器的方法排除）。JS 隐式 any 模式下，这类元素参数不再被多加 `item: unknown` 注解而覆盖上下文类型。

第五轮深挖 p-limit 的 `index.js`（此前只在第二轮粗略转换过），修复 JS 隐式 any 路径缺失的三类真实结构证据：
- 空数组字面量 `const a = []` 的 `push`/索引写入实参类型被收集为元素类型，`never[]` → `Array<T>`（消除 `TS2345`；如 p-limit 的 `promises` 队列）。此前 push 证据只在 TS 显式 any 路径收集，JS 路径没有。
- 对象字面量在构造后被追加的字段（`obj.run = fn` / `obj.m()`）以**可选字段**合入其形状，`{ reject }` → `{ reject: ...; run?: ... }`——构造时确实还没有该字段，设为可选才能同时通过初始化器与后续访问（消除 `TS2339`，且不制造 `TS2741`/`TS2722`；如 p-limit 的 `queueItem.run`）。具体类 / `instanceof` / call-site 来源不受影响。
- 关系比较 `< > <= >=` 从"协变来源 `number | string`"改为"逆变约束"：已有具体来源的操作数不再被 widen 成联合（`let n = 0; n < limit` → `n: number`，消除比较处的 `TS2365`），无来源时仍作兜底估计。

仍存在的局限（属于"JS 动态模式 → strict TS"的固有难度，非语法 bug）：

- `unknown` 参与运算/索引/赋值会触发 `TS18046/TS2345/TS2322`；函数内 `this` 触发 `TS2683`。这些需按具体业务补类型或用 `infer-any` 进一步收窄。例如 p-limit 里 `require('yocto-queue')` 的结果、`typeof` 收窄存进变量（`var type = typeof val`）后无法跨变量收窄，都会留下 `unknown`。
- 递归函数（如 fast-deep-equal 的 `equal(a, b)`）的参数若被推断为较窄的联合/对象类型，递归调用把联合成员（`Map` 的值 `unknown`）再传回参数时会触发 `TS2345`——类型推断无法预知递归数据流，属固有限制。
- 回调参数的上游若已是 `any` / `unknown`（如 `anyArray.map(x => ...)`），其上下文类型为 `any`，此时回调参数保持原样——标注它无法修复上游已丢失的类型，属于 unknown 传播问题。
- 跨文件推断把自定义类型（如 `Mixed`）传播到使用点时，使用点文件可能缺少对应兜底别名（该类型只定义在别的文件 JSDoc 中）。
- `Object.getOwnPropertyDescriptor` 等 lib API 的返回类型含 `| undefined`（如 `PropertyDescriptor | undefined`），JS 库常直接传给 `Object.defineProperty` 而不判空——工具不臆造非空断言，保留 strict 报错需业务补 `!` 或判空（如 mimic-fn）。
- 参数被推断为窄对象/数组类型后，`unknown` 实参传入会触发 `TS2345`，收窄到 `never` 后访问属性触发 `TS2339`（如 kind-of 的类型探测函数）；把 `val` 保守推成 `unknown`/`{}` 是安全的，但无法同时满足下游对具体类型（`Date` / `Error` / `RegExp`）的期待。
- 装箱原始类型（`new String(...)` / `new Number(...)`）被用 `x[k] = v` 当字典写入时触发 `TS2542`（索引签名只读）：这些类型不可赋给 `Record<PropertyKey, unknown>`，强行升级会在初始化器处触发 `TS2322`，故保留具体类型、不臆造 `any`（如 object-assign 的 `test1`）。
- 顶层 `var toString` 与 lib 全局 `toString` 同名会触发 `TS2300`（如 kind-of）——该文件无 import/export 被 TS 当全局脚本，加 `export {}` 转为模块即可规避，非推断错误。
- `window` / `document` / `define` 等运行时全局依赖目标 lib / 环境声明，不由转换器兜底。
