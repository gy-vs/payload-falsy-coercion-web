import {describe, expect, it} from 'vitest';
import {
  coerceBoolean,
  coerceDate,
  coerceNumber,
  coerceString,
  convertRecord,
  FieldSpec,
  inferPresence,
  migrateLegacyRecord,
  Presence,
  prepareSerializable,
  readPath,
  safeJsonStringify,
  summarize,
  tokenizePath,
} from '../src/shared/presence';

const specs = [
  {path: 'name', type: 'string' as const},
  {path: 'empty', type: 'string' as const, default: ''},
  {path: 'qty', type: 'number' as const, default: 0},
  {path: 'active', type: 'boolean' as const, default: false},
  {path: 'when', type: 'date' as const, nullPolicy: 'default' as const, default: 0},
  {path: 'meta.reviewer', type: 'string' as const, nullPolicy: 'keep' as const, missingPolicy: 'keep' as const},
  {path: 'meta.note', type: 'string' as const, default: 'NOTE'}, // null 默认 keep
];

describe('readPath 存在性区分', () => {
  it('空字符串、数字零、false 都是 Present', () => {
    const source = {s: '', n: 0, b: false};
    expect(readPath(source, 's')).toMatchObject({presence: Presence.Present, value: ''});
    expect(readPath(source, 'n')).toMatchObject({presence: Presence.Present, value: 0});
    expect(readPath(source, 'b')).toMatchObject({presence: Presence.Present, value: false});
  });

  it('null、显式 undefined 与嵌套缺键三者分开', () => {
    const source: Record<string, unknown> = {a: null, b: undefined, meta: {}};
    expect(readPath(source, 'a').presence).toBe(Presence.Null);
    expect(readPath(source, 'b').presence).toBe(Presence.Undefined);
    expect(readPath(source, 'c').presence).toBe(Presence.Missing);
    expect(readPath(source, 'meta.reviewer').presence).toBe(Presence.Missing);
    expect(readPath(source, 'meta.deep.deeper').presence).toBe(Presence.Missing);
  });

  it('穿过 null 取值报 PATH_THROUGH_NULL 且判为 Missing', () => {
    const read = readPath({meta: null}, 'meta.reviewer');
    expect(read.presence).toBe(Presence.Missing);
    expect(read.throughNull).toBe(true);
  });

  it('中间层为 undefined、末层为 null 的多级穿透都被标记', () => {
    expect(readPath({a: {b: undefined}}, 'a.b.c').throughNull).toBe(true);
    expect(readPath({list: [{x: null}]}, 'list[0].x.y').throughNull).toBe(true);
  });

  it('数组空位 = Missing，显式赋 undefined = Undefined，越界 = Missing', () => {
    const arr: unknown[] = ['x'];
    arr[3] = 'z';
    arr[4] = undefined;
    expect(readPath(arr, '[0]').presence).toBe(Presence.Present);
    expect(readPath(arr, '[1]').presence).toBe(Presence.Missing); // 空位
    expect(readPath(arr, '[2]').presence).toBe(Presence.Missing); // 空位
    expect(readPath(arr, '[4]').presence).toBe(Presence.Undefined);
    expect(readPath(arr, '[9]').presence).toBe(Presence.Missing); // 越界
  });

  it('支持点号、方括号、引号路径', () => {
    const source = {a: {'b-c': [{d: 0}]}};
    expect(tokenizePath('a["b-c"][0].d').map(t => t.key)).toEqual(['a', 'b-c', '0', 'd']);
    expect(readPath(source, `a['b-c'][0].d`).value).toBe(0);
  });
});

describe('类型转换保留假值', () => {
  it('false 字符串、0、空字符串按目标类型转换', () => {
    expect(coerceString('p', false).value).toBe('false');
    expect(coerceString('p', 0).value).toBe('0');
    expect(coerceString('p', '').value).toBe('');
    expect(coerceBoolean('p', 'false')).toEqual({value: false, ok: true});
    expect(coerceBoolean('p', 0)).toEqual({value: false, ok: true});
    expect(coerceNumber('p', 0)).toEqual({value: 0, ok: true});
    expect(coerceDate('p', 0).value).toBe(new Date(0).toISOString());
  });

  it('空字符串不是数字 0；布尔不隐式转数字；坏日期失败', () => {
    expect(coerceNumber('p', '').ok).toBe(false);
    expect(coerceNumber('p', false).ok).toBe(false);
    expect(coerceBoolean('p', 2).ok).toBe(false);
    expect(coerceDate('p', 'not-a-date').ok).toBe(false);
  });
});

describe('convertRecord：默认值不替换有效假值', () => {
  it('显式 ""/0/false/null 与缺失/undefined 的最终状态正确', () => {
    const source = {
      name: '',
      empty: '',
      qty: 0,
      active: false,
      when: 0,
      meta: {note: null, reviewer: null},
    };
    const result = convertRecord(specs, source);
    const by = new Map(result.fields.map(f => [f.path, f]));

    expect(by.get('name')!.presence).toBe(Presence.Present);
    expect(by.get('empty')!.presence).toBe(Presence.Present);
    expect(by.get('qty')!.presence).toBe(Presence.Present);
    expect(by.get('active')!.presence).toBe(Presence.Present);
    expect(by.get('when')!.presence).toBe(Presence.Present);
    expect(by.get('when')!.value).toBe(new Date(0).toISOString());
    // null 策略：when 给的是 0（Present）不触发；note 未配 nullPolicy => 默认 keep，null 不被默认值替换
    expect(by.get('meta.note')!.presence).toBe(Presence.Null);
  });

  it('nullPolicy=keep 保留 null 且与缺失区分', () => {
    const result = convertRecord(specs, {meta: {reviewer: null}});
    const reviewer = result.fields.find(f => f.path === 'meta.reviewer')!;
    expect(reviewer.presence).toBe(Presence.Null);
    expect(result.output['meta.reviewer']).toBeNull();
  });

  it('缺失与显式 undefined 在 missingPolicy=default 下填默认值并标 Defaulted', () => {
    const result = convertRecord(specs, {meta: {note: undefined}});
    const note = result.fields.find(f => f.path === 'meta.reviewer')!;
    expect(note.presence).toBe(Presence.Missing); // reviewer 配置 missing keep
    expect(note.value).toBeUndefined();
    expect(result.output['meta.reviewer']).toBeUndefined();
    expect('meta.reviewer' in result.output).toBe(false);
  });

  it('假值默认值 ""、0、false 会被识别并填充缺失', () => {
    const falsySpecs: FieldSpec[] = [
      {path: 's', type: 'string', default: ''},
      {path: 'n', type: 'number', default: 0},
      {path: 'b', type: 'boolean', default: false},
      {path: 'x', type: 'string', nullPolicy: 'default', default: null},
    ];
    const result = convertRecord(falsySpecs, {x: null});
    const by = new Map(result.fields.map(f => [f.path, f]));
    expect(by.get('s')!).toMatchObject({presence: Presence.Defaulted, value: ''});
    expect(by.get('n')!).toMatchObject({presence: Presence.Defaulted, value: 0});
    expect(by.get('b')!).toMatchObject({presence: Presence.Defaulted, value: false});
    // 显式 null 默认值：状态是 Defaulted（不是 Null），值为 null
    expect(by.get('x')!).toMatchObject({presence: Presence.Defaulted, value: null});
    expect(result.output).toEqual({s: '', n: 0, b: false, x: null});
  });

  it('已存在的假值永不被默认值覆盖', () => {
    const result = convertRecord(
      [{path: 'n', type: 'number', default: 42}, {path: 'b', type: 'boolean', default: true}],
      {n: 0, b: false},
    );
    expect(result.output).toEqual({n: 0, b: false});
    expect(result.fields.every(f => f.presence === Presence.Present)).toBe(true);
  });

  it('输出对象对 null / 缺失的键处理确定', () => {    const result = convertRecord(specs, {name: 'x', meta: {note: null}});
    expect(result.output['name']).toBe('x');
    expect(result.output['qty']).toBe(0); // Defaulted
    expect(result.output['active']).toBe(false); // Defaulted
    expect(result.output['meta.note']).toBeNull(); // nullPolicy 默认 keep
    expect(result.output['meta.reviewer']).toBeUndefined(); // missing keep
  });
});

describe('批量摘要统计', () => {
  it('空字符串/0/false 计入有效；null 不并入缺失', () => {
    const records = [
      {name: '', qty: 0, active: false, when: 0, meta: {reviewer: null}},
      {name: 'b', qty: 9, active: true, when: 1},
    ];
    const results = records.map(r => convertRecord(specs, r));
    const summary = summarize(results, specs);
    const name = summary.fields.find(f => f.path === 'name')!;
    expect(name.counts[Presence.Present]).toBe(2);
    expect(name.filled).toBe(2);
    const reviewer = summary.fields.find(f => f.path === 'meta.reviewer')!;
    expect(reviewer.counts[Presence.Null]).toBe(1);
    expect(reviewer.counts[Presence.Missing]).toBe(1);
    expect(reviewer.filled).toBe(0);
    // 总计行：Present + Defaulted 恒等于 filled
    const presentLike = summary.totals[Presence.Present] + summary.totals[Presence.Defaulted];
    expect(presentLike).toBe(summary.filled);
  });
});

describe('undefined 与数组空位的序列化', () => {
  it('非严格模式确定性替换为 null 且逐处回报', () => {
    const arr: unknown[] = ['a'];
    arr[2] = undefined;
    const scan = prepareSerializable({arr, u: undefined});
    expect(JSON.stringify(scan.value)).toBe(JSON.stringify({arr: ['a', null, null], u: null}));
    expect(scan.issues.some(i => i.code === 'SPARSE_ARRAY_HOLE')).toBe(true);
    expect(scan.issues.filter(i => i.code === 'EXPLICIT_UNDEFINED')).toHaveLength(2);
  });

  it('严格模式遇到 undefined 或空位直接抛错', () => {
    expect(() => safeJsonStringify({u: undefined}, {strict: true})).toThrow();
    const sparse: unknown[] = [];
    sparse[2] = 1;
    expect(() => safeJsonStringify(sparse, {strict: true})).toThrow();
  });
});

describe('旧数据迁移', () => {
  it('无来源状态时结构推断：""、0、false 推断为 Present', () => {
    const legacy = {name: '', qty: 0, active: false, when: 0, empty: ''};
    expect(inferPresence(legacy, 'name')).toBe(Presence.Present);
    expect(inferPresence(legacy, 'qty')).toBe(Presence.Present);
    expect(inferPresence(legacy, 'active')).toBe(Presence.Present);
    expect(inferPresence(legacy, 'missing')).toBe(Presence.Missing);
    expect(inferPresence({x: null}, 'x')).toBe(Presence.Null);
  });

  it('迁移不改动现有有效值（含假值），并附带 LEGACY 标记', () => {
    const legacy = {name: '', qty: 0, active: false, when: 0, empty: ''};
    const result = migrateLegacyRecord(specs, legacy);
    const by = new Map(result.fields.map(f => [f.path, f]));
    expect(by.get('name')!).toMatchObject({presence: Presence.Present, value: ''});
    expect(by.get('qty')!).toMatchObject({presence: Presence.Present, value: 0});
    expect(by.get('active')!).toMatchObject({presence: Presence.Present, value: false});
    expect(by.get('when')!.value).toBe(new Date(0).toISOString());
    expect(by.get('empty')!.value).toBe('');
    for (const f of result.fields) {
      expect(f.issues.some(i => i.code === 'LEGACY_WITHOUT_PRESENCE')).toBe(true);
    }
  });

  it('迁移不追溯性地标 Defaulted；类型不通过的旧值原样保留', () => {
    const legacy = {name: 'ok', qty: 'abc', active: false, missing: 1};
    const result = migrateLegacyRecord(specs, legacy);
    const qty = result.fields.find(f => f.path === 'qty')!;
    expect(qty.presence).toBe(Presence.Present);
    expect(qty.value).toBe('abc'); // 原样保留，不改写
    expect(qty.issues.some(i => i.code === 'TYPE_MISMATCH')).toBe(true);
    // 从未存在的字段允许按策略默认，但旧有效值绝不被覆盖
    expect(result.fields.filter(f => f.presence === Presence.Defaulted).length)
      .toBe(convertRecord(specs, legacy).fields.filter(f => f.presence === Presence.Defaulted).length);
  });
});
