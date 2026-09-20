# Migration Mapping Studio

Local workbench for transform runs.

Run `npm install`, then `npm run dev` (client on :4173, API on :4174).

## Payload 转换的存在性语义

`src/shared/` 是前端预览、筛选与服务端批量执行共同依赖的唯一转换内核，
存在性判定只允许使用 `SourceStatus` 枚举，禁止用真假判断（`if (value)` / `??` / `||`）区分状态：

| 状态 | 含义 |
| --- | --- |
| `present` | 键存在且非 null/undefined。**`''`、`0`、`false` 都是有效值**，只做类型转换，不替换默认值 |
| `missing` | 嵌套缺键、数组越界、数组空位（hole）、穿透 null 中间层 |
| `undefined` | 显式 `undefined`（内存中可出现，JSON 不可序列化） |
| `null` | 显式 `null` |

- **默认值**：只在 `missing` / `undefined` 上应用；`null` 是否应用由
  `nullStrategy: 'keep' | 'default'` 决定（默认 keep，且没有配置默认值时永远保留 null）。
  字段用 `hasDefault: true` 显式声明默认值存在，因此默认值本身可以是 `0` / `false` / `''` / `null`。
- **jsonModel（默认开启）**：先按 JSON 数据模型规范化输入（对象的 `undefined` 键丢弃、
  数组空位/`undefined` 变 `null`），保证浏览器预览与 HTTP 批量结果严格一致；
  关闭后保留内存语义，`readPath` 可区分数组空位与显式 undefined，用于诊断。
- **结果**：每个字段返回 `FieldResult { status, outcome, value, defaultApplied, coerced, error? }`，
  outcome ∈ `kept | coerced | defaulted | failed | omitted`；摘要同时给 `byStatus` 与 `byOutcome`，
  “有效字段”统计口径就是 `status === present`。
- **旧数据迁移**（`migrateSavedResult`）：只补盖 `status/outcome`，**output/value 逐字节保留**；
  提供原始输入时用统一 `readPath` 判定，不提供时按 `value` 键存在性确定性推断。

### API

- `POST /api/convert/batch` — `{records, rules, options?}`，返回 `BatchResult`
- `GET  /api/convert/last` — 最近一次批量结果
- `GET  /api/saved-results/legacy-alpha` — v1 旧保存结果的迁移演示
- `GET  /api/convert/enums` — 统一状态/策略枚举

## 测试

`npm test`（vitest + supertest），覆盖：嵌套缺键、数组空位、显式 undefined 不可序列化、
null 默认策略、零日期、false 字符串转换、预览/批量同语义、旧数据迁移不改值。
