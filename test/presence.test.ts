import {describe, expect, it} from 'vitest';
import {
  SourceStatus,
  readPath,
  parsePath,
  normalizeJsonLike,
  roundTripJson,
  writePath,
  convertBatch,
  convertRecord,
  NullStrategy,
  migrateSavedResult,
  stampVersion,
  MIGRATION_VERSION,
  coerce,
  type FieldRule,
} from '../src/shared/index.js';

const EPOCH_ISO = new Date(0).toISOString();

describe('readPath 存在性语义：区分缺失/null/空串/零/false/undefined', () => {
  it('空字符串、0、false 全部是 Present', () => {
    const source = {a: '', b: 0, c: false};
    expect(readPath(source, 'a')).toEqual({status: SourceStatus.Present, value: ''});
    expect(readPath(source, 'b')).toEqual({status: SourceStatus.Present, value: 0});
    expect(readPath(source, 'c')).toEqual({status: SourceStatus.Present, value: false});
  });

  it('嵌套缺键与穿透 null 中间层都是 Missing', () => {
    const source = {nested: {deep: null}};
    expect(readPath(source, 'nested.deep.leaf').status).toBe(SourceStatus.Missing);
    expect(readPath(source, 'nested.absent.leaf').status).toBe(SourceStatus.Missing);
    expect(readPath(source, 'top.absent').status).toBe(SourceStatus.Missing);
  });

  it('显式 undefined 是 Undefined，不与 Missing 混淆', () => {
    const source = {u: undefined};
    expect(readPath(source, 'u').status).toBe(SourceStatus.Undefined);
    expect(readPath(source, 'missing').status).toBe(SourceStatus.Missing);
    expect(readPath({n: {u: undefined}}, 'n.u').status).toBe(SourceStatus.Undefined);
  });

  it('数组空位为 Missing，越界为 Missing，显式 undefined 元素为 Undefined', () => {
    const arr: unknown[] = ['a', , 'c', undefined];
    expect(readPath(arr, '[1]').status).toBe(SourceStatus.Missing); // 空位
    expect(readPath(arr, '[3]').status).toBe(SourceStatus.Undefined);
    expect(readPath(arr, '[9]').status).toBe(SourceStatus.Missing);
    expect(readPath({arr}, 'arr[1]').status).toBe(SourceStatus.Missing);
    expect(readPath({arr}, 'arr[3]').status).toBe(SourceStatus.Undefined);
  });

  it('显式 null 是 Null', () => {
    expect(readPath({n: null}, 'n').status).toBe(SourceStatus.Null);
    expect(readPath([null], '[0]').status).toBe(SourceStatus.Null);
  });

  it('点号与括号路径解析（含引号键）', () => {
    const source = {a: {b: [{'x-y': 7}]}};
    expect(readPath(source, 'a.b[0]["x-y"]')).toEqual({status: SourceStatus.Present, value: 7});
    const quoted = readPath(source, parsePath('a.b[0][\'x-y\']'));
    expect(quoted.status).toBe(SourceStatus.Present);
    expect(quoted.status === SourceStatus.Present ? quoted.value : null).toBe(7);
    expect(() => parsePath('a..b')).toThrow();
    expect(() => parsePath('a.')).toThrow();
  });

  it('在非容器中间值上继续读取为 Missing 而非抛错', () => {
    expect(readPath({a: 5}, 'a.b').status).toBe(SourceStatus.Missing);
    expect(readPath({a: ''}, 'a.b').status).toBe(SourceStatus.Missing);
    expect(readPath({a: false}, 'a.b').status).toBe(SourceStatus.Missing);
  });

  it('拒绝原型污染路径', () => {
    expect(() => parsePath('__proto__.polluted')).not.toThrow(); // 解析本身允许
    const out: Record<string, unknown> = {};
    expect(() => writePath(out, parsePath('__proto__.polluted'), 1)).toThrow(/forbidden/);
  });
});

describe('coerce 类型转换：假值不被吞掉', () => {
  it('false 字符串转换：false -> "false"，"false" -> false', () => {
    expect(coerce(false, 'string')).toEqual({ok: true, value: 'false'});
    expect(coerce('false', 'boolean')).toEqual({ok: true, value: false});
    expect(coerce(true, 'string')).toEqual({ok: true, value: 'true'});
    expect(coerce('true', 'boolean')).toEqual({ok: true, value: true});
  });

  it('零的转换：0 -> "0"，false -> 0，0 字符串数字 -> 0，空串 -> 失败', () => {
    const s0 = coerce(0, 'string'); expect(s0.ok ? s0.value : null).toBe('0');
    const n0 = coerce(false, 'number'); expect(n0.ok ? n0.value : null).toBe(0);
    const n0s = coerce('0', 'number'); expect(n0s.ok ? n0s.value : null).toBe(0);
    expect(coerce('', 'number').ok).toBe(false);
    expect(coerce('   ', 'number').ok).toBe(false);
  });

  it('零日期：时间戳 0 与 new Date(0) 都转成 epoch ISO', () => {
    expect(coerce(0, 'date')).toEqual({ok: true, value: EPOCH_ISO});
    expect(coerce(new Date(0), 'date')).toEqual({ok: true, value: EPOCH_ISO});
    expect(coerce(EPOCH_ISO, 'date')).toEqual({ok: true, value: EPOCH_ISO});
    expect(coerce('', 'date').ok).toBe(false);
    expect(coerce('nonsense', 'date').ok).toBe(false);
  });

  it('空字符串是有效字符串值', () => {
    expect(coerce('', 'string')).toEqual({ok: true, value: ''});
  });

  it('数字布尔只接受 0/1', () => {
    const b0 = coerce(0, 'boolean'); expect(b0.ok ? b0.value : null).toBe(false);
    const b1 = coerce(1, 'boolean'); expect(b1.ok ? b1.value : null).toBe(true);
    expect(coerce(2, 'boolean').ok).toBe(false);
  });
});

describe('转换引擎：默认值只用于缺失，Present 假值原样保留', () => {
  const rules: FieldRule[] = [
    {source: 'empty', type: 'string', hasDefault: true, defaultValue: 'D'},
    {source: 'zero', type: 'number', hasDefault: true, defaultValue: 99},
    {source: 'flag', type: 'boolean', hasDefault: true, defaultValue: true},
  ];

  it('空串/0/false 不触发默认值（修复报告中的核心缺陷）', () => {
    const result = convertRecord({empty: '', zero: 0, flag: false}, rules);
    expect(result.fields.map(f => f.status)).toEqual([
      SourceStatus.Present, SourceStatus.Present, SourceStatus.Present,
    ]);
    expect(result.fields.every(f => f.outcome === 'coerced')).toBe(true);
    expect(result.output).toEqual({empty: '', zero: 0, flag: false});
    expect(result.counts[SourceStatus.Present]).toBe(3);
  });

  it('嵌套缺键才应用默认值', () => {
    const result = convertRecord({}, rules);
    expect(result.fields.every(f => f.outcome === 'defaulted')).toBe(true);
    expect(result.output).toEqual({empty: 'D', zero: 99, flag: true});
    expect(result.counts[SourceStatus.Missing]).toBe(3);
  });

  it('默认值本身是 0 / false / "" 时按显式配置生效，不能被 ?? 吞掉', () => {
    const r1 = convertRecord({a: 1}, [{source: 'a', type: 'any'}, {source: 'b', type: 'number', hasDefault: true, defaultValue: 0}]);
    expect(r1.output.b).toBe(0);
    const r2 = convertRecord({}, [{source: 'b', type: 'boolean', hasDefault: true, defaultValue: false}]);
    expect(r2.output.b).toBe(false);
    const r3 = convertRecord({}, [{source: 'b', type: 'string', hasDefault: true, defaultValue: ''}]);
    expect(r3.output.b).toBe('');
  });

  it('未配置默认值的缺失字段被省略，不向输出写入任何东西', () => {
    const result = convertRecord({}, [{source: 'a', type: 'string'}]);
    expect(result.fields[0].outcome).toBe('omitted');
    expect(result.output).toEqual({});
    expect('value' in result.fields[0]).toBe(false);
  });

  it('null 默认策略：keep 保留 null；default 且有默认值才替换', () => {
    const keep = convertRecord({n: null}, [{source: 'n', type: 'any'}]);
    expect(keep.fields[0]).toMatchObject({status: SourceStatus.Null, outcome: 'kept'});
    expect(keep.output.n).toBeNull();

    const keep2 = convertRecord({n: null}, [
      {source: 'n', type: 'string', hasDefault: true, defaultValue: 'x', nullStrategy: NullStrategy.Keep},
    ]);
    expect(keep2.fields[0].outcome).toBe('kept');
    expect(keep2.output.n).toBeNull();

    const replaced = convertRecord({n: null}, [
      {source: 'n', type: 'string', hasDefault: true, defaultValue: 'x', nullStrategy: NullStrategy.Default},
    ]);
    expect(replaced.fields[0]).toMatchObject({status: SourceStatus.Null, outcome: 'defaulted'});
    expect(replaced.output.n).toBe('x');

    // default 策略但没配默认值：null 仍保留，不能凭空造值
    const noDefault = convertRecord({n: null}, [
      {source: 'n', type: 'string', nullStrategy: NullStrategy.Default},
    ]);
    expect(noDefault.output.n).toBeNull();
  });

  it('显式 undefined 不可序列化：无默认值 -> omitted；默认值 undefined -> omitted 且报错', () => {
    const withDefault = convertRecord({u: undefined}, [
      {source: 'u', type: 'string', hasDefault: true, defaultValue: 'D'},
    ], {jsonModel: false});
    expect(withDefault.fields[0]).toMatchObject({status: SourceStatus.Undefined, outcome: 'defaulted'});

    const noDefault = convertRecord({u: undefined}, [{source: 'u', type: 'string'}], {jsonModel: false});
    expect(noDefault.fields[0]).toMatchObject({status: SourceStatus.Undefined, outcome: 'omitted'});

    const badDefault = convertRecord({}, [{source: 'u', type: 'string', hasDefault: true}]);
    expect(badDefault.fields[0].outcome).toBe('omitted');
    expect(badDefault.fields[0].error).toMatch(/undefined/);
  });

  it('数组空位：raw 模式 Missing 用默认值；jsonModel 下经传输变成 null 走 null 策略', () => {
    const source = {arr: ['x', , undefined] as unknown[]};
    const raw = convertRecord(source, [
      {source: 'arr[1]', type: 'string', hasDefault: true, defaultValue: 'D'},
      {source: 'arr[2]', type: 'string', hasDefault: true, defaultValue: 'E'},
    ], {jsonModel: false});
    expect(raw.fields[0]).toMatchObject({status: SourceStatus.Missing, outcome: 'defaulted'});
    expect(raw.fields[1]).toMatchObject({status: SourceStatus.Undefined, outcome: 'defaulted'});

    // 模拟 HTTP：JSON.stringify(['x', , undefined]) => ["x",null,null]
    const wired = convertRecord(roundTripJson(source), [
      {source: 'arr[1]', type: 'string', hasDefault: true, defaultValue: 'D'},
      {source: 'arr[2]', type: 'string', hasDefault: true, defaultValue: 'E', nullStrategy: NullStrategy.Default},
    ]);
    expect(wired.fields.map(f => f.status)).toEqual([SourceStatus.Null, SourceStatus.Null]);
    expect(wired.fields.map(f => f.outcome)).toEqual(['kept', 'defaulted']);
    expect(wired.output.arr).toEqual([null, null, 'E']);
  });

  it('转换失败计入 failed 且不静默替换为默认值', () => {
    const result = convertRecord({bad: ''}, [{source: 'bad', type: 'number', hasDefault: true, defaultValue: 1}]);
    expect(result.fields[0]).toMatchObject({status: SourceStatus.Present, outcome: 'failed'});
    expect(result.output).toEqual({});
  });

  it('omitOnFailure 时失败字段被跳过', () => {
    const result = convertRecord({bad: 'x'}, [{source: 'bad', type: 'number', omitOnFailure: true}]);
    expect(result.fields[0].outcome).toBe('omitted');
    expect(result.output).toEqual({});
  });

  it('不修改输入记录', () => {
    const source = {a: 5};
    convertRecord(source, [{source: 'a', type: 'string', target: 'b'}]);
    expect(source).toEqual({a: 5});
  });
});

describe('jsonModel：前端预览与服务端批量的一致性', () => {
  it('规范化等价于 JSON 往返', () => {
    const source = {u: undefined, keep: 0, arr: [1, , undefined, ''], nested: {u: undefined, n: null}};
    expect(normalizeJsonLike(source)).toEqual(roundTripJson(source));
    expect(normalizeJsonLike(source)).toEqual({keep: 0, arr: [1, null, null, ''], nested: {n: null}});
  });

  it('批量结果即逐条预览结果的汇总（同引擎同枚举）', () => {
    const records = [{a: ''}, {a: 0}, {a: false}, {a: null}, {}];
    const rules: FieldRule[] = [{source: 'a', type: 'any', hasDefault: true, defaultValue: 'D'}];
    const batch = convertBatch(records, rules);
    const singles = records.map((r, i) => convertRecord(r, rules, {jsonModel: true}, i));
    expect(batch.records).toEqual(singles);
    expect(batch.summary.presentFields).toBe(3);
    expect(batch.summary.byStatus[SourceStatus.Null]).toBe(1);
    expect(batch.summary.missingFields).toBe(1);
    expect(batch.summary.defaultedFields).toBe(1); // 只有真缺失用默认值
  });

  it('所有 FieldResult 可 JSON 序列化（不含 undefined 键）', () => {
    const source = {u: undefined, hole: ['x', , undefined], n: null, bad: ''};
    const result = convertBatch([source], [
      {source: 'u', type: 'string'},
      {source: 'hole[1]', type: 'string'},
      {source: 'hole[2]', type: 'string'},
      {source: 'n', type: 'any'},
      {source: 'bad', type: 'date'},
    ]);
    const reparsed = roundTripJson(result);
    expect(reparsed).toEqual(result);
    for (const record of result.records) {
      for (const field of record.fields) {
        expect(Object.values(field).every(v => v !== undefined)).toBe(true);
      }
    }
  });
});

describe('旧保存数据迁移：确定规则，不改动有效值', () => {
  const legacy = {
    version: 1,
    records: [{
      fields: [
        {source: 'a', value: ''},
        {source: 'b', value: 0},
        {source: 'c', value: false},
        {source: 'n', value: null},
        {source: 'd', value: EPOCH_ISO},
        {source: 'm'}, // 无 value 键
        {source: 'u', value: undefined},
        {source: 'g', value: 'D', default: true},
        {source: 'bad', value: 'not-a-number', error: 'bad input', type: 'number'},
      ],
      output: {a: '', b: 0, c: false, n: null, d: EPOCH_ISO, g: 'D'},
    }],
  };

  it('无来源时按 value 键存在性推断，且 output 逐字节保留', () => {
    const migrated = migrateSavedResult(legacy);
    const statuses = migrated.records[0].fields.map(f => [f.source, f.status]);
    expect(statuses).toEqual([
      ['a', SourceStatus.Present],
      ['b', SourceStatus.Present],
      ['c', SourceStatus.Present],
      ['n', SourceStatus.Null],
      ['d', SourceStatus.Present],
      ['m', SourceStatus.Missing],
      ['u', SourceStatus.Undefined],
      ['g', SourceStatus.Present],
      ['bad', SourceStatus.Present],
    ]);
    // 铁律：有效值不变
    const output = migrated.records[0].output;
    expect(output.a).toBe('');
    expect(output.b).toBe(0);
    expect(output.c).toBe(false);
    expect(output.d).toBe(EPOCH_ISO);
    expect(output.n).toBeNull();
  });

  it('提供原始输入时用统一 readPath 判定（嵌套缺键/数组空位精确）', () => {
    const sources = [{a: '', b: 0, c: false, n: null, d: EPOCH_ISO, arr: ['', , false]}];
    const withSources = {
      version: 1,
      records: [{fields: [
        {source: 'a', value: ''},
        {source: 'arr[1]'},
        {source: 'arr[2]', value: false},
        {source: 'deep.missing', value: 7},
      ], output: {a: '', arr: ['', , false], deep: {missing: 7}}}],
    };
    const migrated = migrateSavedResult(withSources, {sources});
    expect(migrated.records[0].fields.map(f => f.status)).toEqual([
      SourceStatus.Present, SourceStatus.Missing, SourceStatus.Present, SourceStatus.Missing,
    ]);
    // output 不重算
    expect(migrated.records[0].output).toEqual(withSources.records[0].output);
  });

  it('outcome 推断确定：default 标记/错误/缺失各归其位', () => {
    const migrated = migrateSavedResult(legacy);
    const map = new Map(migrated.records[0].fields.map(f => [f.source, f.outcome]));
    expect(map.get('g')).toBe('defaulted');
    expect(map.get('bad')).toBe('failed');
    expect(map.get('m')).toBe('omitted');
    expect(map.get('u')).toBe('omitted');
    expect(map.get('n')).toBe('kept');
    expect(map.get('a')).toBe('kept');
  });

  it('已有合法状态的数据原样透传，不重新判定也不改值', () => {
    const v2 = {
      version: MIGRATION_VERSION,
      records: [{fields: [
        {source: 'a', target: 'a', status: SourceStatus.Present, outcome: 'coerced', value: 0},
      ], output: {a: 0}}],
    };
    const migrated = migrateSavedResult(v2, {sources: [{}]}); // 即使来源里没有 a
    expect(migrated.records[0].fields[0].status).toBe(SourceStatus.Present);
    expect(migrated.records[0].output.a).toBe(0);
  });

  it('迁移结果可打版本戳并 JSON 往返', () => {
    const stamped = stampVersion(migrateSavedResult(legacy));
    expect(stamped.version).toBe(MIGRATION_VERSION);
    expect(roundTripJson(stamped)).toEqual(stamped);
  });

  it('缺少 records 数组时报错而非猜测', () => {
    expect(() => migrateSavedResult({} as never)).toThrow(/no records/);
  });
});

describe('writePath 输出路径', () => {
  it('按 target 嵌套创建对象与数组', () => {
    const out: Record<string, unknown> = {};
    writePath(out, parsePath('a.b[0].c'), 5);
    expect(out).toEqual({a: {b: [{c: 5}]}});
  });

  it('中间层是有效值时拒绝覆盖', () => {
    expect(() => writePath({a: 1}, parsePath('a.b'), 2)).toThrow(/not a container/);
    expect(() => writePath({a: false}, parsePath('a.b'), 2)).toThrow(/not a container/);
    expect(() => writePath({a: ''}, parsePath('a.b'), 2)).toThrow(/not a container/);
  });
});
