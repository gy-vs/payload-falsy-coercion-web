/**
 * 统一存在性语义的唯一事实来源。
 * 前端预览、筛选、服务端批量摘要都必须使用 SourceStatus 枚举，
 * 禁止用 if (value) / ?? / || 等真假判断区分这些状态。
 */

export enum SourceStatus {
  /** 路径不存在：对象无此键，或数组索引超出长度（含数组空位） */
  Missing = 'missing',
  /** 键存在但值为 undefined（内存中可出现，JSON 不可序列化） */
  Undefined = 'undefined',
  /** 键存在且值为 null */
  Null = 'null',
  /** 键存在且值 !== undefined && !== null；''、0、false 都属于此项 */
  Present = 'present',
}

/** 对统计友好的全量状态顺序，摘要按此初始化，保证计数键稳定 */
export const SOURCE_STATUSES: readonly SourceStatus[] = [
  SourceStatus.Missing,
  SourceStatus.Undefined,
  SourceStatus.Null,
  SourceStatus.Present,
];

export type PathToken = string | number;

export type ReadResult =
  | {status: SourceStatus.Present; value: unknown}
  | {status: SourceStatus.Missing}
  | {status: SourceStatus.Undefined}
  | {status: SourceStatus.Null};

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$-]*$/;

/**
 * 路径解析（扫描器实现）：a.b[0]["x-y"]['z']
 * 点段须为合法标识符；括号内可放整数索引或单双引号字符串。
 * 路径是配置，语法错误直接抛错而不是猜测。
 */
export function parsePath(path: string): PathToken[] {
  if (path === '') return [];
  const tokens: PathToken[] = [];
  let i = 0;
  const readBracket = (): void => {
    i += 1; // 跳过 [
    const char = path[i];
    if (char === '"' || char === "'") {
      const quote = char;
      i += 1;
      let value = '';
      let closed = false;
      while (i < path.length) {
        const c = path[i];
        if (c === '\\') {
          value += path[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          if (path[i] !== ']') throw new Error(`expected ] after quoted key in "${path}"`);
          i += 1;
          closed = true;
          break;
        }
        value += c;
        i += 1;
      }
      if (!closed) throw new Error(`unterminated quoted key in "${path}"`);
      tokens.push(value);
    } else {
      let digits = '';
      while (i < path.length && /\d/.test(path[i])) {
        digits += path[i];
        i += 1;
      }
      if (digits === '' || path[i] !== ']') {
        throw new Error(`bracket must contain an integer index in "${path}"`);
      }
      i += 1; // 跳过 ]
      tokens.push(Number(digits));
    }
  };
  while (i < path.length) {
    const char = path[i];
    if (char === '.') {
      i += 1;
      let ident = '';
      while (i < path.length && /[^.[\]]/.test(path[i])) {
        ident += path[i];
        i += 1;
      }
      if (!IDENTIFIER_PATTERN.test(ident)) {
        throw new Error(`invalid segment "${ident}" in "${path}"`);
      }
      tokens.push(ident);
    } else if (char === '[') {
      readBracket();
    } else {
      // 起始位置允许直接跟标识符（无点前缀）
      let ident = '';
      while (i < path.length && /[^.[\]]/.test(path[i])) {
        ident += path[i];
        i += 1;
      }
      if (!IDENTIFIER_PATTERN.test(ident)) {
        throw new Error(`invalid segment "${ident}" in "${path}"`);
      }
      tokens.push(ident);
    }
  }
  return tokens;
}

const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function assertSafeToken(token: PathToken): void {
  if (typeof token === 'string' && PROTOTYPE_POLLUTION_KEYS.has(token)) {
    throw new Error(`forbidden path segment "${token}"`);
  }
}

/**
 * 按路径读取，精确区分四种来源状态。
 * 中间层为 null 时路径必然不存在（Missing）；
 * 数组空位（hole）返回 Missing；
 * 中间层为非容器值时也视为 Missing（无可继续读取的键）。
 */
export function readPath(root: unknown, path: PathToken[] | string): ReadResult {
  const tokens = typeof path === 'string' ? parsePath(path) : path;
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || current === undefined) {
      return {status: SourceStatus.Missing};
    }
    if (typeof token === 'number') {
      if (!Array.isArray(current)) return {status: SourceStatus.Missing};
      if (token < 0 || token >= current.length) return {status: SourceStatus.Missing};
      if (!(token in current)) return {status: SourceStatus.Missing}; // 数组空位
      current = current[token];
    } else {
      if (Array.isArray(current) || typeof current !== 'object') {
        return {status: SourceStatus.Missing};
      }
      if (!Object.prototype.hasOwnProperty.call(current, token)) {
        return {status: SourceStatus.Missing};
      }
      current = (current as Record<string, unknown>)[token];
    }
  }
  if (current === undefined) return {status: SourceStatus.Undefined};
  if (current === null) return {status: SourceStatus.Null};
  return {status: SourceStatus.Present, value: current};
}

/**
 * 规范化为 JSON 数据模型，模拟 JSON.stringify / JSON.parse 往返：
 * - 对象上显式 undefined 的键会被丢弃 -> Missing
 * - 数组中的 undefined 与空位会变成 null -> Null
 * 转换引擎默认走此模型，保证浏览器预览与 HTTP 批量结果一致；
 * 内存中直接调用（raw 模式）可保留 Undefined / hole 区别用于诊断。
 */
export function normalizeJsonLike(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (let i = 0; i < value.length; i += 1) {
      // 空位或 undefined 经 JSON 传输均为 null
      out.push(i in value && value[i] !== undefined && typeof value[i] !== 'function'
        ? normalizeJsonLike(value[i])
        : null);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined || typeof child === 'function') continue;
    out[key] = normalizeJsonLike(child);
  }
  return out;
}

/** 模拟一次 JSON 往返（测试与边界诊断用） */
export function roundTripJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 按路径写入输出。中间层缺失时按需创建对象/数组；
 * 中间层为非容器值时抛错，避免静默覆盖有效字段。
 */
export function writePath(root: Record<string, unknown>, tokens: PathToken[], value: unknown): void {
  let current: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i];
    assertSafeToken(token);
    const next = tokens[i + 1];
    if (Array.isArray(current)) {
      if (typeof token !== 'number') throw new Error(`cannot use key "${String(token)}" on array`);
      const existing = token in current ? current[token] : undefined;
      if (existing !== null && existing !== undefined && typeof existing !== 'object') {
        throw new Error(`segment "${String(token)}" is not a container`);
      }
      if (existing === null || existing === undefined) {
        fillArrayGaps(current, token);
        current[token] = typeof next === 'number' ? [] : {};
      }
      current = current[token] as Record<string, unknown> | unknown[];
    } else {
      if (typeof token === 'number') throw new Error(`cannot use index ${token} on object`);
      const existing = (current as Record<string, unknown>)[token];
      if (existing !== null && existing !== undefined && typeof existing !== 'object') {
        throw new Error(`segment "${token}" is not a container`);
      }
      if (existing === null || existing === undefined) {
        (current as Record<string, unknown>)[token] = typeof next === 'number' ? [] : {};
      }
      current = (current as Record<string, unknown>)[token] as Record<string, unknown> | unknown[];
    }
  }
  const last = tokens[tokens.length - 1];
  assertSafeToken(last);
  if (Array.isArray(current)) {
    if (typeof last !== 'number') throw new Error(`cannot use key "${String(last)}" on array`);
    fillArrayGaps(current, last);
    current[last] = value;
  } else {
    if (typeof last === 'number') throw new Error(`cannot use index ${last} on object`);
    (current as Record<string, unknown>)[last] = value;
  }
}

/** 写入越界索引前用 null 补齐空位，避免产生 JSON 中语义含混的稀疏数组 */
function fillArrayGaps(arr: unknown[], index: number): void {
  if (index < 0) throw new Error(`negative array index ${index}`);
  while (arr.length <= index) arr.push(null);
}
