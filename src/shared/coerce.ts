/**
 * 类型转换只在 SourceStatus === Present 的有效值上发生。
 * 每个转换器显式处理 ''、0、false，绝不依赖真假判断。
 * 无法转换时返回错误，由调用方记录 failed，而不是静默落回默认值。
 */

export type CoerceType = 'any' | 'string' | 'number' | 'boolean' | 'date';

export type CoerceResult =
  | {ok: true; value: unknown}
  | {ok: false; error: string};

const isWhitespace = (value: string): boolean => value.trim() === '';

export function coerce(value: unknown, type: CoerceType): CoerceResult {
  switch (type) {
    case 'any':
      return {ok: true, value};

    case 'string':
      if (typeof value === 'string') return {ok: true, value};
      if (value === null) return {ok: true, value: 'null'};
      if (typeof value === 'boolean') {
        // 关键：false 必须转成 "false"，不能变成 '' 或默认值
        return {ok: true, value: value ? 'true' : 'false'};
      }
      if (typeof value === 'number' || typeof value === 'bigint') return {ok: true, value: String(value)};
      return {ok: false, error: `cannot coerce ${typeof value} to string`};

    case 'number': {
      if (typeof value === 'number') {
        return Number.isFinite(value) ? {ok: true, value} : {ok: false, error: 'non-finite number'};
      }
      if (typeof value === 'boolean') return {ok: true, value: value ? 1 : 0}; // false -> 0
      if (typeof value === 'string') {
        if (isWhitespace(value)) return {ok: false, error: 'empty string is not a number'};
        const parsed = Number(value);
        return Number.isFinite(parsed)
          ? {ok: true, value: parsed}
          : {ok: false, error: `"${value}" is not a finite number`};
      }
      return {ok: false, error: `cannot coerce ${value === null ? 'null' : typeof value} to number`};
    }

    case 'boolean': {
      if (typeof value === 'boolean') return {ok: true, value};
      if (typeof value === 'number') {
        // 关键：0 是有效输入 -> false，不能因为 falsy 被当成缺失
        if (value === 0 || value === 1) return {ok: true, value: value === 1};
        return {ok: false, error: `number ${value} cannot coerce to boolean (only 0/1)`};
      }
      if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true') return {ok: true, value: true};
        if (lower === 'false') return {ok: true, value: false}; // "false" -> false
        return {ok: false, error: `"${value}" is not "true" or "false"`};
      }
      return {ok: false, error: `cannot coerce ${value === null ? 'null' : typeof value} to boolean`};
    }

    case 'date': {
      // 关键：零日期 new Date(0) / 时间戳 0 有效，输出 1970-01-01T00:00:00.000Z
      if (value instanceof Date) {
        return Number.isNaN(value.getTime())
          ? {ok: false, error: 'invalid Date instance'}
          : {ok: true, value: value.toISOString()};
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return {ok: false, error: 'non-finite timestamp'};
        return {ok: true, value: new Date(value).toISOString()};
      }
      if (typeof value === 'string') {
        if (isWhitespace(value)) return {ok: false, error: 'empty string is not a date'};
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime())
          ? {ok: false, error: `"${value}" is not a valid date"`}
          : {ok: true, value: parsed.toISOString()};
      }
      return {ok: false, error: `cannot coerce ${value === null ? 'null' : typeof value} to date`};
    }
  }
}
