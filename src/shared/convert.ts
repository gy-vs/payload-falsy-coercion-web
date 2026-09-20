import {
  assertSafeToken,
  normalizeJsonLike,
  parsePath,
  readPath,
  SourceStatus,
  writePath,
  type PathToken,
} from './presence.js';
import {coerce, type CoerceType} from './coerce.js';

/** null 显式存在时的默认策略；missing / undefined 一律走默认值 */
export enum NullStrategy {
  /** null 是有效值，原样保留（默认） */
  Keep = 'keep',
  /** 把 null 视同缺失，应用字段默认值（无默认值时仍保留 null） */
  Default = 'default',
}

export type Outcome = 'kept' | 'coerced' | 'defaulted' | 'failed' | 'omitted';

export interface FieldRule {
  /** 输入路径（点/括号语法） */
  source: string;
  /** 输出路径；省略时写回 source 同路径 */
  target?: string;
  type: CoerceType;
  /**
   * 配置了 hasDefault:true 才表示“存在默认值”，defaultValue 可以是 null/0/false/''，
   * 不能用 defaultValue ?? fallback 判断，否则这些有效值会被当成没配置默认值。
   */
  hasDefault?: boolean;
  defaultValue?: unknown;
  nullStrategy?: NullStrategy;
  /** 转换失败时跳过该字段（默认 false：失败也占一个结果并计入 failed） */
  omitOnFailure?: boolean;
}

/** JSON 安全的字段结果：不含任何 undefined 属性 */
export interface FieldResult {
  source: string;
  target: string;
  status: SourceStatus;
  outcome: Outcome;
  /** 实际写入输出的值；omitted/failed 且无值时省略此键 */
  value?: unknown;
  /** 应用默认值时的默认值副本，便于前端/摘要核对 */
  defaultValue?: unknown;
  defaultApplied: boolean;
  coerced: boolean;
  error?: string;
}

export type FieldCounts = Record<SourceStatus, number> & Record<Outcome, number>;

export interface ConvertRecordResult {
  recordIndex: number;
  fields: FieldResult[];
  output: Record<string, unknown>;
  counts: FieldCounts;
}

export interface BatchSummary {
  totalRecords: number;
  totalFields: number;
  byStatus: Record<SourceStatus, number>;
  byOutcome: Record<Outcome, number>;
  /** 统计口径：只有 status === present 才算有效；'' 0 false 都计入 */
  presentFields: number;
  missingFields: number;
  failedFields: number;
  defaultedFields: number;
}

export interface BatchResult {
  records: ConvertRecordResult[];
  summary: BatchSummary;
}

export interface ConvertOptions {
  /**
   * true（默认）：先按 JSON 数据模型规范化输入，模拟网络往返，
   * 使前端预览与服务端批量执行严格一致。
   * false：保留内存语义（显式 undefined、数组空位可被 readPath 区分诊断）。
   */
  jsonModel?: boolean;
}

const OUTCOMES: readonly Outcome[] = ['kept', 'coerced', 'defaulted', 'failed', 'omitted'];

export function emptyStatusCounts(): Record<SourceStatus, number> {
  return {
    [SourceStatus.Missing]: 0,
    [SourceStatus.Undefined]: 0,
    [SourceStatus.Null]: 0,
    [SourceStatus.Present]: 0,
  };
}

export function emptyOutcomeCounts(): Record<Outcome, number> {
  return {kept: 0, coerced: 0, defaulted: 0, failed: 0, omitted: 0};
}

export interface CompiledRule {
  sourceTokens: PathToken[];
  targetTokens: PathToken[];
  target: string;
  rule: FieldRule;
}

export function compileRules(rules: FieldRule[]): CompiledRule[] {
  return rules.map((rule) => {
    if (typeof rule.source !== 'string' || rule.source === '') {
      throw new Error('rule.source must be a non-empty path string');
    }
    const sourceTokens = parsePath(rule.source);
    const target = rule.target ?? rule.source;
    const targetTokens = parsePath(target);
    sourceTokens.forEach(assertSafeToken);
    targetTokens.forEach(assertSafeToken);
    return {sourceTokens, targetTokens, target, rule};
  });
}

/** 默认值是否可写入：显式配置 + 值可经 JSON 表示（undefined 无法落盘/传输） */
function resolveDefault(rule: FieldRule): {has: boolean; value: unknown} {
  if (!rule.hasDefault) return {has: false, value: undefined};
  if (rule.defaultValue === undefined) return {has: false, value: undefined};
  return {has: true, value: normalizeJsonLike(rule.defaultValue)};
}

function makeResult(partial: {
  source: string; target: string; status: SourceStatus; outcome: Outcome;
  value?: unknown; defaultValue?: unknown; error?: string;
}): FieldResult {
  const result: FieldResult = {
    source: partial.source,
    target: partial.target,
    status: partial.status,
    outcome: partial.outcome,
    defaultApplied: partial.outcome === 'defaulted',
    coerced: partial.outcome === 'coerced',
  };
  if (partial.value !== undefined) result.value = partial.value;
  if (partial.defaultValue !== undefined) result.defaultValue = partial.defaultValue;
  if (partial.error !== undefined) result.error = partial.error;
  return result;
}

/**
 * 单字段转换 —— 前端单条预览与服务端批量执行共同经过的唯一函数。
 * source 只读，结果写入独立的 output，绝不原地修改输入记录。
 */
export function convertFieldInto(
  source: unknown,
  output: Record<string, unknown>,
  compiled: CompiledRule,
): FieldResult {
  const {sourceTokens, targetTokens, target, rule} = compiled;
  const read = readPath(source, sourceTokens);
  const def = resolveDefault(rule);
  const nullUsesDefault = rule.nullStrategy === NullStrategy.Default;
  const base = {source: rule.source, target};

  // 1) 缺失（嵌套缺键、数组空位）与显式 undefined：应用默认可序列化默认值
  if (read.status === SourceStatus.Missing || read.status === SourceStatus.Undefined) {
    if (def.has) {
      writePath(output, targetTokens, def.value);
      return makeResult({...base, status: read.status, outcome: 'defaulted', value: def.value, defaultValue: def.value});
    }
    return makeResult({
      ...base, status: read.status, outcome: 'omitted',
      error: rule.hasDefault ? 'default value is undefined and cannot be serialized' : undefined,
    });
  }

  // 2) 显式 null：keep 原样保留；default 策略且有默认可序列化默认值时才替换
  if (read.status === SourceStatus.Null) {
    if (nullUsesDefault && def.has) {
      writePath(output, targetTokens, def.value);
      return makeResult({...base, status: SourceStatus.Null, outcome: 'defaulted', value: def.value, defaultValue: def.value});
    }
    writePath(output, targetTokens, null);
    return makeResult({...base, status: SourceStatus.Null, outcome: 'kept', value: null});
  }

  // 3) Present：'' 0 false 与其他有效值一视同仁，只做类型转换
  const converted = coerce(read.value, rule.type);
  if (!converted.ok) {
    return makeResult({
      ...base, status: SourceStatus.Present,
      outcome: rule.omitOnFailure ? 'omitted' : 'failed',
      error: converted.error,
    });
  }
  writePath(output, targetTokens, converted.value);
  return makeResult({
    ...base, status: SourceStatus.Present,
    outcome: rule.type === 'any' ? 'kept' : 'coerced',
    value: converted.value,
  });
}

export function convertRecord(
  record: unknown,
  rules: FieldRule[] | CompiledRule[],
  options: ConvertOptions = {},
  recordIndex = 0,
): ConvertRecordResult {
  const jsonModel = options.jsonModel ?? true;
  const source = jsonModel ? normalizeJsonLike(record) : record;
  const output: Record<string, unknown> = {};
  const compiled = rules.length > 0 && 'sourceTokens' in rules[0]
    ? (rules as CompiledRule[])
    : compileRules(rules as FieldRule[]);
  const fields = compiled.map((compiledRule) => convertFieldInto(source, output, compiledRule));
  const counts: FieldCounts = {...emptyStatusCounts(), ...emptyOutcomeCounts()};
  for (const field of fields) {
    counts[field.status] += 1;
    counts[field.outcome] += 1;
  }
  return {recordIndex, fields, output, counts};
}

/**
 * 服务端批量执行入口。与单条预览共用 compileRules/readPath/coerce，
 * 唯一差异只是循环次数，绝无另一套真假判断。
 */
export function convertBatch(records: unknown[], rules: FieldRule[], options: ConvertOptions = {}): BatchResult {
  const compiled = compileRules(rules);
  const recordResults = records.map((record, index) => convertRecord(record, compiled, options, index));
  const byStatus = emptyStatusCounts();
  const byOutcome = emptyOutcomeCounts();
  let totalFields = 0;
  for (const record of recordResults) {
    for (const status of Object.keys(byStatus) as SourceStatus[]) byStatus[status] += record.counts[status];
    for (const outcome of OUTCOMES) byOutcome[outcome] += record.counts[outcome];
    totalFields += record.fields.length;
  }
  const summary: BatchSummary = {
    totalRecords: recordResults.length,
    totalFields,
    byStatus,
    byOutcome,
    presentFields: byStatus[SourceStatus.Present],
    missingFields: byStatus[SourceStatus.Missing] + byStatus[SourceStatus.Undefined],
    failedFields: byOutcome.failed,
    defaultedFields: byOutcome.defaulted,
  };
  return {records: recordResults, summary};
}
