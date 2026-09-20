/**
 * 存在性语义的唯一来源。
 *
 * 前端单条预览、前端筛选、服务端批量执行与摘要统计共享本文件的枚举与函数，
 * 任何路径都不得再用真值判断（`!value`、`value || fallback`、`value == null`
 * 混用）来区分字段状态——''、0、false 都是 Present。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 存在性枚举：缺失、null、空字符串、零、false 必须可以两两区分
// ─────────────────────────────────────────────────────────────────────────────

export enum Presence {
  /** 键存在，值既不是 null 也不是显式 undefined（''、0、false 均属此状态）。 */
  Present = 'present',
  /** 键存在，值为 null。受 nullPolicy 控制，绝不等于缺失。 */
  Null = 'null',
  /** 路径在源数据中不存在：嵌套缺键、数组越界、数组空位（sparse hole）。 */
  Missing = 'missing',
  /** 键存在但值为显式 undefined。内存中可表达，JSON 不可序列化。 */
  Undefined = 'undefined',
  /** 原位置缺失 / null / undefined，按策略用默认值填充后得到的值。 */
  Defaulted = 'defaulted',
  /** 键存在，但类型转换失败；无产出值（旧数据迁移除外，迁移保留原值）。 */
  Invalid = 'invalid',
}

/** 供 UI / 摘要使用的稳定中文标签，同样禁止各端自行拼写。 */
export const PRESENCE_LABEL: Record<Presence, string> = {
  [Presence.Present]: '存在',
  [Presence.Null]: 'null',
  [Presence.Missing]: '缺失',
  [Presence.Undefined]: 'undefined',
  [Presence.Defaulted]: '默认值填充',
  [Presence.Invalid]: '转换失败',
};

/** 统计口径：哪些状态算作“有效字段”。只有真正有值产出的状态计入。 */
export function isFilled(presence: Presence): boolean {
  return presence === Presence.Present || presence === Presence.Defaulted;
}

/** 统计口径：哪些状态算作“空”。null 单列，不并入缺失；转换失败也非有效。 */
export function isAbsent(presence: Presence): boolean {
  return (
    presence === Presence.Missing ||
    presence === Presence.Null ||
    presence === Presence.Undefined ||
    presence === Presence.Invalid
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 诊断 issue
// ─────────────────────────────────────────────────────────────────────────────

export type IssueCode =
  | 'PATH_THROUGH_NULL' // 路径需要穿过 null/undefined 继续下行
  | 'MISSING_NO_DEFAULT' // 缺失要求保留但无默认值可用 / 策略无法满足
  | 'UNDEFINED_NO_DEFAULT' // 显式 undefined 无法填充
  | 'NULL_NO_DEFAULT' // nullPolicy=default 但未提供默认值
  | 'TYPE_MISMATCH' // 类型转换失败
  | 'DEFAULT_TYPE_MISMATCH' // 默认值本身通不过目标类型
  | 'EXPLICIT_UNDEFINED' // 序列化树中存在显式 undefined
  | 'SPARSE_ARRAY_HOLE' // 序列化树中存在数组空位
  | 'LEGACY_WITHOUT_PRESENCE'; // 旧数据缺来源状态，按规则推断

export interface PresenceIssue {
  path: string;
  code: IssueCode;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 统一路径读取
// ─────────────────────────────────────────────────────────────────────────────

/** 支持 a.b、a[0]、a['x-y']、a["x"] 及数组命名属性；空路径表示根。 */
export type PathToken = { key: string; bracketed: boolean };

export function tokenizePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  const re = /[^.[\]]+|\[(?:'([^']*)'|"([^"]*)"|(-?\d+))\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    if (match[1] !== undefined) tokens.push({ key: match[1], bracketed: true });
    else if (match[2] !== undefined) tokens.push({ key: match[2], bracketed: true });
    else if (match[3] !== undefined) tokens.push({ key: match[3], bracketed: true });
    else tokens.push({ key: match[0], bracketed: false });
  }
  return tokens;
}

export interface PathRead {
  path: string;
  value: unknown;
  presence: Presence;
  /** 触发 PATH_THROUGH_NULL 时为 true，供诊断使用。 */
  throughNull: boolean;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 值的最终存在性分类（不含 defaulted/invalid，那是转换层概念）。 */
function classify(value: unknown): Presence {
  if (value === undefined) return Presence.Undefined;
  if (value === null) return Presence.Null;
  return Presence.Present;
}

/**
 * 统一的路径存在性读取。规则：
 * - 数组数字下标：越界 / 空位 => Missing；显式赋过 undefined => Undefined。
 * - 对象自有键缺失 => Missing；键在但值为 undefined => Undefined；null => Null。
 * - 需要穿过 null / undefined 继续下行 => Missing + PATH_THROUGH_NULL。
 */
export function readPath(source: unknown, path: string): PathRead {
  const tokens = tokenizePath(path);
  if (tokens.length === 0) {
    return {
      path,
      value: source,
      presence:
        source === undefined
          ? Presence.Undefined
          : source === null
            ? Presence.Null
            : Presence.Present,
      throughNull: false,
    };
  }

  let current: unknown = source;
  let throughNull = false;

  for (let i = 0; i < tokens.length; i++) {
    const { key, bracketed } = tokens[i];

    if (current === null || current === undefined) {
      return { path, value: undefined, presence: Presence.Missing, throughNull: true };
    }

    const last = i === tokens.length - 1;

    if (Array.isArray(current)) {
      const index = Number(key);
      const isIndex = bracketed
        ? key !== '' && Number.isInteger(index)
        : key !== '' && Number.isInteger(index) && String(index) === key;
      if (isIndex && index >= 0) {
        if (index >= current.length || !(index in current)) {
          // 越界或稀疏数组空位：位置不存在（不同于显式赋过 undefined）
          return { path, value: undefined, presence: Presence.Missing, throughNull };
        }
        const item = current[index];
        if (last) return { path, value: item, presence: classify(item), throughNull };
        if (item === null || item === undefined) throughNull = true;
        current = item;
        continue;
      }
    }

    if (isObjectLike(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        return { path, value: undefined, presence: Presence.Missing, throughNull };
      }
      const item = (current as Record<string, unknown>)[key];
      if (last) return { path, value: item, presence: classify(item), throughNull };
      if (item === null || item === undefined) throughNull = true;
      current = item;
      continue;
    }

    // 原始值上继续取键
    return { path, value: undefined, presence: Presence.Missing, throughNull: true };
  }

  // 不可达：循环内最后一个 token 一定返回。
  return { path, value: undefined, presence: Presence.Missing, throughNull };
}

// ─────────────────────────────────────────────────────────────────────────────
// 字段规格与默认值 / null 策略
// ─────────────────────────────────────────────────────────────────────────────

export type FieldType = 'string' | 'number' | 'boolean' | 'date';
/** keep：保留 null（区别于缺失）；default：用默认值替换 null。 */
export type NullPolicy = 'keep' | 'default';
/** keep：保留缺失 / undefined（输出中无此键）；default：用默认值填充。 */
export type MissingPolicy = 'keep' | 'default';

export interface FieldSpec {
  path: string;
  type: FieldType;
  /** 任何类型的默认值；填充前同样经过目标类型转换校验。 */
  default?: unknown;
  nullPolicy?: NullPolicy; // 默认 'keep'
  missingPolicy?: MissingPolicy; // 默认 'default'
}

export interface ConvertedField {
  path: string;
  type: FieldType;
  /** 转换后的值；缺失/undefined 保留时为 undefined（不出现在输出对象中）。 */
  value: unknown;
  presence: Presence;
  /** 读取到的原始值（''、0、false、null、undefined 原样保留，便于审计）。 */
  raw: unknown;
  issues: PresenceIssue[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 类型转换：存在性先行，转换不改变存在性语义
// ─────────────────────────────────────────────────────────────────────────────

export interface CoercionResult {
  value: unknown;
  ok: boolean;
}

function issue(path: string, code: IssueCode, message: string): PresenceIssue {
  return { path, code, message };
}

/** false => 'false'、0 => '0'、'' => ''；绝不把假值转成缺失或默认文案。 */
export function coerceString(path: string, value: unknown): CoercionResult {
  if (typeof value === 'string') return { value, ok: true };
  if (typeof value === 'number') return { value: String(value), ok: true };
  if (typeof value === 'boolean') return { value: value ? 'true' : 'false', ok: true };
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { value: undefined, ok: false }
      : { value: value.toISOString(), ok: true };
  }
  return { value: undefined, ok: false };
}

/** 0 => false；'false' => false；'true' => true。其余字符串/数字判失败。 */
export function coerceBoolean(path: string, value: unknown): CoercionResult {
  if (typeof value === 'boolean') return { value, ok: true };
  if (typeof value === 'number') {
    if (value === 0) return { value: false, ok: true };
    if (value === 1) return { value: true, ok: true };
    return { value: undefined, ok: false };
  }
  if (typeof value === 'string') {
    if (value === 'true') return { value: true, ok: true };
    if (value === 'false') return { value: false, ok: true };
    return { value: undefined, ok: false };
  }
  return { value: undefined, ok: false };
}

/** 0 是合法数字（零也是有效输入）；'' 不是 0，转换失败而非缺失。 */
export function coerceNumber(path: string, value: unknown): CoercionResult {
  if (typeof value === 'number') {
    return Number.isNaN(value) ? { value: undefined, ok: false } : { value, ok: true };
  }
  if (typeof value === 'boolean') {
    // 明确拒绝 true/false -> 1/0 的隐式转换，避免 false 被当作 0 或缺失。
    return { value: undefined, ok: false };
  }
  if (typeof value === 'string') {
    if (value.trim() === '') return { value: undefined, ok: false };
    const n = Number(value);
    return Number.isNaN(n) ? { value: undefined, ok: false } : { value: n, ok: true };
  }
  return { value: undefined, ok: false };
}

/** 0 => 1970-01-01T00:00:00.000Z（零日期有效）；非法日期字符串判失败。 */
export function coerceDate(path: string, value: unknown): CoercionResult {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { value: undefined, ok: false }
      : { value: value.toISOString(), ok: true };
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { value: undefined, ok: false };
    return { value: new Date(value).toISOString(), ok: true };
  }
  // 布尔不隐式当作时间戳（false 不应变成 1970，也不应变成缺失）。
  if (typeof value === 'boolean') return { value: undefined, ok: false };
  if (typeof value === 'string') {
    if (value.trim() === '') return { value: undefined, ok: false };
    const ts = Date.parse(value);
    return Number.isNaN(ts)
      ? { value: undefined, ok: false }
      : { value: new Date(ts).toISOString(), ok: true };
  }
  return { value: undefined, ok: false };
}

export function coerceValue(type: FieldType, path: string, value: unknown): CoercionResult {
  switch (type) {
    case 'string':
      return coerceString(path, value);
    case 'boolean':
      return coerceBoolean(path, value);
    case 'number':
      return coerceNumber(path, value);
    case 'date':
      return coerceDate(path, value);
  }
}

const TYPE_MISMATCH_MESSAGE: Record<FieldType, string> = {
  string: '值无法转换为字符串（对象/符号等不支持）',
  number: '值无法转换为数字；注意空字符串不是 0',
  boolean: "值无法转换为布尔；仅接受 true/false、'true'/'false'、0/1",
  date: '值无法转换为日期（零时间戳 0 是合法日期）',
};

// ─────────────────────────────────────────────────────────────────────────────
// 单条记录转换（前端预览与服务端批量调用的同一个函数）
// ─────────────────────────────────────────────────────────────────────────────

export function convertField(spec: FieldSpec, source: unknown): ConvertedField {
  const path = spec.path;
  const nullPolicy: NullPolicy = spec.nullPolicy ?? 'keep';
  const missingPolicy: MissingPolicy = spec.missingPolicy ?? 'default';
  const read = readPath(source, path);
  const issues: PresenceIssue[] = [];

  if (read.throughNull) {
    issues.push(issue(path, 'PATH_THROUGH_NULL', `路径 ${path} 需要穿过 null/undefined 取值`));
  }

  const base: Omit<ConvertedField, 'value' | 'presence'> = {
    path,
    type: spec.type,
    raw: read.value,
    issues,
  };
  // 是否“显式配置”默认值：default:'' / 0 / false / null 都算配置过，
  // 绝不能用真值或 === undefined 判断，否则假默认值会被当成没配置。
  const hasDefault = Object.prototype.hasOwnProperty.call(spec, 'default');

  // 1) null：默认保留；仅当显式配置 default 策略时才用默认值替换。
  if (read.presence === Presence.Null) {
    if (nullPolicy === 'keep' || !hasDefault) {
      if (nullPolicy === 'default' && !hasDefault) {
        issues.push(issue(path, 'NULL_NO_DEFAULT', `字段 ${path} 为 null，策略要求默认值但未配置 default`));
      }
      return { ...base, value: null, presence: Presence.Null };
    }
    return fillDefault(spec, read.value, issues);
  }

  // 2) 缺失与显式 undefined：同一套 missingPolicy，但保留状态可区分。
  if (read.presence === Presence.Missing || read.presence === Presence.Undefined) {
    if (missingPolicy === 'default' && hasDefault) {
      return fillDefault(spec, read.value, issues);
    }
    if (hasDefault) {
      // policy=keep：显式保留缺什么就是什么（missing / undefined 不合并）。
      return { ...base, value: undefined, presence: read.presence };
    }
    issues.push(
      read.presence === Presence.Undefined
        ? issue(path, 'UNDEFINED_NO_DEFAULT', `字段 ${path} 为显式 undefined，且无默认值可填充`)
        : issue(path, 'MISSING_NO_DEFAULT', `字段 ${path} 缺失，且无默认值可填充`),
    );
    return { ...base, value: undefined, presence: read.presence };
  }

  // 3) Present：只做类型转换，存在性不被转换结果改变（'' / 0 / false 保留）。
  const coerced = coerceValue(spec.type, path, read.value);
  if (!coerced.ok) {
    issues.push(issue(path, 'TYPE_MISMATCH', TYPE_MISMATCH_MESSAGE[spec.type]));
    return { ...base, value: undefined, presence: Presence.Invalid };
  }
  return { ...base, value: coerced.value, presence: Presence.Present };
}

function fillDefault(
  spec: FieldSpec,
  raw: unknown,
  issues: PresenceIssue[],
): ConvertedField {
  // 默认值显式为 null：合法的“用 null 填充”，不经过标量类型转换。
  if (spec.default === null) {
    return { path: spec.path, type: spec.type, raw, value: null, presence: Presence.Defaulted, issues };
  }
  const coerced = coerceValue(spec.type, spec.path, spec.default);
  if (!coerced.ok) {
    issues.push(
      issue(spec.path, 'DEFAULT_TYPE_MISMATCH', `字段 ${spec.path} 的默认值通不过 ${spec.type} 类型转换`),
    );
    return { path: spec.path, type: spec.type, raw, value: undefined, presence: Presence.Invalid, issues };
  }
  return { path: spec.path, type: spec.type, raw, value: coerced.value, presence: Presence.Defaulted, issues };
}

export interface ConvertOptions {
  /** 输出中是否保留 null 键（默认保留；false 时从输出对象剔除但状态仍是 Null）。 */
  includeNulls?: boolean;
}

export interface ConvertRecordResult {
  fields: ConvertedField[];
  /** 可直接序列化的输出对象；missing/undefined/invalid 的键不存在，null 默认存在。 */
  output: Record<string, unknown>;
  issues: PresenceIssue[];
}

export function convertRecord(
  specs: FieldSpec[],
  source: unknown,
  options: ConvertOptions = {},
): ConvertRecordResult {
  const includeNulls = options.includeNulls ?? true;
  const fields = specs.map((spec) => convertField(spec, source));
  const output: Record<string, unknown> = {};
  const issues: PresenceIssue[] = [];
  for (const field of fields) {
    issues.push(...field.issues);
    if (field.presence === Presence.Present || field.presence === Presence.Defaulted) {
      output[field.path] = field.value;
    } else if (field.presence === Presence.Null && includeNulls) {
      output[field.path] = null;
    }
  }
  return { fields, output, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// 批量摘要：统计只认枚举，不认真假
// ─────────────────────────────────────────────────────────────────────────────

export interface FieldSummary {
  path: string;
  type: FieldType;
  counts: Record<Presence, number>;
  /** Present + Defaulted：有效字段数。 */
  filled: number;
  /** Missing + Null + Undefined + Invalid：非有效数。 */
  nonFilled: number;
  total: number;
}

export interface BatchSummary {
  total: number;
  fields: FieldSummary[];
  totals: Record<Presence, number>;
  /** 全记录中“有效字段”总数，供缺失率统计使用。 */
  filled: number;
  issues: number;
}

function emptyCounts(): Record<Presence, number> {
  return {
    [Presence.Present]: 0,
    [Presence.Null]: 0,
    [Presence.Missing]: 0,
    [Presence.Undefined]: 0,
    [Presence.Defaulted]: 0,
    [Presence.Invalid]: 0,
  };
}

export function summarize(results: ConvertRecordResult[], specs: FieldSpec[]): BatchSummary {
  const fields: FieldSummary[] = specs.map((spec) => ({
    path: spec.path,
    type: spec.type,
    counts: emptyCounts(),
    filled: 0,
    nonFilled: 0,
    total: results.length,
  }));
  const indexByPath = new Map(fields.map((field, i) => [field.path, i]));
  const totals = emptyCounts();
  let filled = 0;
  let issues = 0;

  for (const result of results) {
    issues += result.issues.length;
    for (const field of result.fields) {
      const index = indexByPath.get(field.path);
      if (index === undefined) continue;
      const summary = fields[index];
      summary.counts[field.presence] += 1;
      totals[field.presence] += 1;
      if (isFilled(field.presence)) {
        summary.filled += 1;
        filled += 1;
      } else if (isAbsent(field.presence)) {
        summary.nonFilled += 1;
      }
    }
  }

  return { total: results.length, fields, totals, filled, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// 显式 undefined / 数组空位的序列化处理
// ─────────────────────────────────────────────────────────────────────────────

export interface SerializationScan {
  /** 经过确定性替换后的可序列化结构（undefined/空位 => null，绝不静默丢弃）。 */
  value: unknown;
  issues: PresenceIssue[];
}

/**
 * JSON.stringify 会静默丢弃对象中的 undefined、把数组空位转成 null——
 * 这正是“有效值看起来缺失”的来源之一。这里先扫描后序列化：
 * - strict 模式遇到 undefined / 空位直接抛错，强制调用方处理；
 * - 非 strict 模式确定性替换为 null 并逐处回报 issue，不做静默丢弃。
 */
export function prepareSerializable(
  root: unknown,
  opts: { strict?: boolean; path?: string } = {},
): SerializationScan {
  const strict = opts.strict ?? false;
  const issues: PresenceIssue[] = [];

  const walk = (value: unknown, path: string): unknown => {
    if (value === undefined) {
      issues.push(
        issue(path, 'EXPLICIT_UNDEFINED', `路径 ${path} 为显式 undefined，JSON 无法直接表达`),
      );
      if (strict) throw new TypeError(`不可序列化的显式 undefined：${path}`);
      return null;
    }
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value.toISOString();

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const childPath = `${path}[${i}]`;
        if (!(i in value)) {
          issues.push(issue(childPath, 'SPARSE_ARRAY_HOLE', `数组 ${path} 第 ${i} 位是空位`));
          if (strict) throw new TypeError(`不可序列化的数组空位：${childPath}`);
          out[i] = null;
          continue;
        }
        out[i] = walk(value[i], childPath);
      }
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      out[key] = walk((value as Record<string, unknown>)[key], childPath);
    }
    return out;
  };

  return { value: walk(root, opts.path ?? ''), issues };
}

export function safeJsonStringify(value: unknown, opts: { strict?: boolean } = {}): string {
  const prepared = prepareSerializable(value, opts);
  return JSON.stringify(prepared.value);
}

// ─────────────────────────────────────────────────────────────────────────────
// 旧数据迁移：无来源状态时按结构确定推断，绝不改写现有有效值
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 结构推断规则（确定、可复现）：
 * - 键不存在 / 数组越界 / 数组空位 => Missing
 * - null => Null（不并入缺失）
 * - 显式 undefined => Undefined
 * - 其余一律 Present——''、0、false 不允许被推断成缺失或默认值
 * Defaulted 状态永不回填：我们无法知道旧值是不是默认值，
 * 追溯性地打 Defaulted 会让统计虚高、也可能覆盖有效值。
 */
export function inferPresence(source: unknown, path: string): Presence {
  return readPath(source, path).presence;
}

export interface LegacyFieldMigration {
  field: ConvertedField;
  /** 推断依据，旧记录没有来源状态时恒带 LEGACY_WITHOUT_PRESENCE。 */
  inferred: boolean;
}

/**
 * 从“旧保存数据（值 + 字段定义，但无来源状态）”迁移。
 * 值原样保留：
 * - Present（含 '' / 0 / false）只做类型校验，不通过也保留原值并标 issue；
 * - null / missing / undefined 保持各自状态，仅在策略与默认值齐备时填充。
 */
export function migrateLegacyRecord(
  specs: FieldSpec[],
  source: unknown,
): { fields: ConvertedField[]; output: Record<string, unknown>; issues: PresenceIssue[] } {
  const fields: ConvertedField[] = specs.map((spec) => {
    const read = readPath(source, spec.path);
    const issues: PresenceIssue[] = [
      issue(spec.path, 'LEGACY_WITHOUT_PRESENCE', `旧数据字段 ${spec.path} 无来源状态，按结构规则推断`),
    ];
    if (read.throughNull) {
      issues.push(issue(spec.path, 'PATH_THROUGH_NULL', `路径 ${spec.path} 需要穿过 null/undefined 取值`));
    }

    // 能填默认值的情况仍走统一转换，保证语义一致。
    const hasDefault = Object.prototype.hasOwnProperty.call(spec, 'default');
    const needDefault =
      (read.presence === Presence.Null && (spec.nullPolicy ?? 'keep') === 'default') ||
      ((read.presence === Presence.Missing || read.presence === Presence.Undefined) &&
        (spec.missingPolicy ?? 'default') === 'default');
    if (needDefault && hasDefault) {
      const filled = fillDefault(spec, read.value, issues);
      return { ...filled, issues: [...issues, ...filled.issues] };
    }

    if (read.presence !== Presence.Present) {
      return {
        path: spec.path,
        type: spec.type,
        raw: read.value,
        value: read.presence === Presence.Null ? null : undefined,
        presence: read.presence,
        issues,
      };
    }

    // 有效值：类型通过就给转换值；不通过也保留原始值（迁移不改值），
    // presence 仍是 Present，只附带 TYPE_MISMATCH 供人工复核。
    const coerced = coerceValue(spec.type, spec.path, read.value);
    if (coerced.ok) {
      return {
        path: spec.path,
        type: spec.type,
        raw: read.value,
        value: coerced.value,
        presence: Presence.Present,
        issues,
      };
    }
    issues.push(
      issue(spec.path, 'TYPE_MISMATCH', `旧值通不过 ${spec.type} 转换，已原样保留，请人工复核`),
    );
    return {
      path: spec.path,
      type: spec.type,
      raw: read.value,
      value: read.value,
      presence: Presence.Present,
      issues,
    };
  });

  const output: Record<string, unknown> = {};
  const issues: PresenceIssue[] = [];
  for (const field of fields) {
    issues.push(...field.issues);
    if (field.presence === Presence.Present || field.presence === Presence.Defaulted) {
      output[field.path] = field.value;
    } else if (field.presence === Presence.Null) {
      output[field.path] = null;
    }
  }
  return { fields, output, issues };
}
