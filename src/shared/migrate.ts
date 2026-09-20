import {readPath, SourceStatus} from './presence.js';
import type {BatchResult, BatchSummary, ConvertRecordResult, FieldResult, Outcome} from './convert.js';
import {emptyOutcomeCounts, emptyStatusCounts} from './convert.js';

/**
 * 旧保存数据迁移：为没有来源状态的字段结果补盖 SourceStatus。
 * 铁律：只补元数据，绝不修改 output / value —— ''、0、false、零日期字符串
 * 都必须逐字节保留（见测试中的 deepEqual 断言）。
 */

const VALID_STATUSES = new Set<string>(Object.values(SourceStatus));
const VALID_OUTCOMES = new Set<Outcome>(['kept', 'coerced', 'defaulted', 'failed', 'omitted']);

export const MIGRATION_VERSION = 2;

/** v1 旧形态字段：只有 source/target/value 之类，没有 status/outcome */
export interface LegacyField {
  source?: unknown;
  target?: unknown;
  value?: unknown;
  status?: unknown;
  outcome?: unknown;
  error?: unknown;
  default?: unknown; // v1 可能用 default:true 标记默认值
  fromDefault?: unknown;
  type?: unknown;
  [key: string]: unknown;
}

export interface LegacyRecord {
  fields?: LegacyField[];
  output?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LegacySavedResult {
  version?: unknown;
  records?: LegacyRecord[];
  [key: string]: unknown;
}

export interface MigrateOptions {
  /**
   * 可选：对应的原始输入记录（顺序与 records 对齐）。
   * 提供时按统一 readPath 直接判定（原生区分数组空位/显式 undefined，最精确）；
   * 经 HTTP 传输的来源中空位/undefined 已被 JSON 规范化，那是传输固有限制。
   * 不提供来源时按字段自身的 value 键做确定性推断。
   */
  sources?: unknown[];
}

function inferStatusFromField(field: LegacyField): SourceStatus {
  // 确定性推断：只看“键是否存在”和值的身份，不做真假判断
  if (!('value' in field)) return SourceStatus.Missing;
  if (field.value === null) return SourceStatus.Null;
  if (field.value === undefined) return SourceStatus.Undefined;
  return SourceStatus.Present; // '' 0 false 一律是有效值
}

function inferStatusFromSource(field: LegacyField, source: unknown): SourceStatus {
  const path = typeof field.source === 'string' ? field.source : '';
  if (path === '') return inferStatusFromField(field);
  const read = readPath(source, path);
  return read.status;
}

function inferOutcome(field: LegacyField, status: SourceStatus): Outcome {
  if (typeof field.outcome === 'string' && (VALID_OUTCOMES as Set<string>).has(field.outcome)) {
    return field.outcome as Outcome;
  }
  const hasError = typeof field.error === 'string' && field.error.length > 0;
  // 错误优先：有 error 的字段即转换失败；缺键却带 error 说明转换时就找不到值
  if (hasError) return 'failed';
  if (field.default === true || field.fromDefault === true) return 'defaulted';
  if (status === SourceStatus.Missing || status === SourceStatus.Undefined) return 'omitted';
  if (status === SourceStatus.Null) return 'kept';
  // Present 且无错误：v1 字段带类型且非 any 时标 coerced，否则 kept；仅影响标签
  return field.type && field.type !== 'any' ? 'coerced' : 'kept';
}

export function migrateLegacyField(field: LegacyField, source?: unknown): FieldResult {
  const status = typeof field.status === 'string' && VALID_STATUSES.has(field.status)
    ? (field.status as SourceStatus)
    : (source === undefined ? inferStatusFromField(field) : inferStatusFromSource(field, source));
  const outcome = inferOutcome(field, status);

  // 关键：value 原样搬运，不经过 coerce，不经过默认值逻辑
  const migrated: FieldResult = {
    source: typeof field.source === 'string' ? field.source : String(field.source ?? ''),
    target: typeof field.target === 'string' ? field.target : (typeof field.source === 'string' ? field.source : ''),
    status,
    outcome,
    defaultApplied: outcome === 'defaulted',
    coerced: outcome === 'coerced',
  };
  if ('value' in field && field.value !== undefined) migrated.value = field.value;
  if (typeof field.error === 'string') migrated.error = field.error;
  return migrated;
}

export function migrateSavedResult(raw: LegacySavedResult, options: MigrateOptions = {}): BatchResult {
  if (!raw || !Array.isArray(raw.records)) {
    throw new Error('cannot migrate: saved result has no records array');
  }
  const records: ConvertRecordResult[] = raw.records.map((legacyRecord, index) => {
    const source = options.sources?.[index];
    const fields = Array.isArray(legacyRecord.fields)
      ? legacyRecord.fields.map((field) => migrateLegacyField(field, source))
      : [];
    // output 原样保留（v1 已落盘的转换结果不可重算）
    const output: Record<string, unknown> = legacyRecord.output && typeof legacyRecord.output === 'object'
      ? (legacyRecord.output as Record<string, unknown>)
      : {};
    const counts = {...emptyStatusCounts(), ...emptyOutcomeCounts()};
    for (const field of fields) {
      counts[field.status] += 1;
      counts[field.outcome] += 1;
    }
    return {recordIndex: index, fields, output, counts};
  });

  const byStatus = emptyStatusCounts();
  const byOutcome = emptyOutcomeCounts();
  let totalFields = 0;
  for (const record of records) {
    (Object.keys(byStatus) as SourceStatus[]).forEach((status) => {byStatus[status] += record.counts[status];});
    (Object.keys(byOutcome) as Outcome[]).forEach((outcome) => {byOutcome[outcome] += record.counts[outcome];});
    totalFields += record.fields.length;
  }
  const summary: BatchSummary = {
    totalRecords: records.length,
    totalFields,
    byStatus,
    byOutcome,
    presentFields: byStatus[SourceStatus.Present],
    missingFields: byStatus[SourceStatus.Missing] + byStatus[SourceStatus.Undefined],
    failedFields: byOutcome.failed,
    defaultedFields: byOutcome.defaulted,
  };
  return {records, summary};
}

export function isLegacyResult(raw: unknown): raw is LegacySavedResult {
  return typeof raw === 'object' && raw !== null
    && Array.isArray((raw as LegacySavedResult).records)
    && (raw as LegacySavedResult).version !== MIGRATION_VERSION;
}

/** 迁移后包装版本号，供保存/传输使用 */
export function stampVersion(result: BatchResult): {version: number} & BatchResult {
  return {version: MIGRATION_VERSION, ...result};
}
