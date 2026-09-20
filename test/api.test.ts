import {describe, expect, it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {convertRecord, SourceStatus, type FieldRule} from '../src/shared/index.js';

const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

describe('POST /api/convert/batch 服务端批量执行', () => {
  const rules: FieldRule[] = [
    {source: 'empty', type: 'string', hasDefault: true, defaultValue: 'D'},
    {source: 'zero', type: 'number', hasDefault: true, defaultValue: 9},
    {source: 'flag', type: 'boolean', hasDefault: true, defaultValue: true},
    {source: 'n', type: 'any'},
    {source: 'zeroDate', type: 'date'},
    {source: 'falseString', type: 'boolean'},
    {source: 'arr[1]', type: 'string', hasDefault: true, defaultValue: 'H', nullStrategy: 'default' as FieldRule['nullStrategy']},
  ];

  it('空串/0/false 保留，统计 present 而非缺失', async () => {
    const app = createApp();
    const records = [{empty: '', zero: 0, flag: false, n: null, zeroDate: 0, falseString: 'false', arr: ['', null]}];
    const res = await request(app).post('/api/convert/batch').send({records, rules}).expect(200);
    const field = (name: string) => res.body.records[0].fields.find((f: {source: string}) => f.source === name);

    expect(field('empty')).toMatchObject({status: SourceStatus.Present, value: ''});
    expect(field('zero')).toMatchObject({status: SourceStatus.Present, value: 0});
    expect(field('flag')).toMatchObject({status: SourceStatus.Present, value: false});
    expect(field('n')).toMatchObject({status: SourceStatus.Null, outcome: 'kept', value: null});
    expect(field('zeroDate').value).toBe(EPOCH_ISO);
    expect(field('falseString').value).toBe(false);
    expect(field('arr[1]')).toMatchObject({status: SourceStatus.Null, outcome: 'defaulted', value: 'H'});

    expect(res.body.summary.presentFields).toBe(5);
    expect(res.body.summary.missingFields).toBe(0);
    expect(res.body.output ?? res.body.records[0].output).toEqual({
      empty: '', zero: 0, flag: false, n: null,
      zeroDate: EPOCH_ISO, falseString: false, arr: [null, 'H'],
    });
  });

  it('与前端单条预览（convertRecord）产出一致', async () => {
    const app = createApp();
    const record = {empty: '', zero: 0, flag: false, n: null, zeroDate: 0, falseString: 'false', arr: ['', null]};
    const res = await request(app).post('/api/convert/batch').send({records: [record], rules}).expect(200);
    const preview = convertRecord(record, rules);
    expect(res.body.records[0]).toEqual(JSON.parse(JSON.stringify(preview)));
  });

  it('嵌套缺键才落默认值；显式 undefined 经 HTTP 已变缺键', async () => {
    const app = createApp();
    const res = await request(app).post('/api/convert/batch').send({
      records: [{}], rules,
    }).expect(200);
    expect(res.body.summary.defaultedFields).toBeGreaterThan(0);
    const byStatus = res.body.summary.byStatus;
    expect(byStatus[SourceStatus.Present]).toBe(0);
    expect(byStatus[SourceStatus.Null]).toBe(0);
    expect(byStatus[SourceStatus.Missing]).toBe(7);
    // 7 条规则中 4 条配了默认值 -> defaulted；其余 3 条无默认值 -> omitted
    expect(res.body.summary.defaultedFields).toBe(4);
  });

  it('非法路径规则返回 400，不执行转换', async () => {
    const app = createApp();
    const res = await request(app).post('/api/convert/batch').send({
      records: [{}], rules: [{source: 'a..b', type: 'any'}],
    }).expect(400);
    expect(res.body.error).toBe('invalid_rule');
  });

  it('请求体形状错误返回 400', async () => {
    const app = createApp();
    await request(app).post('/api/convert/batch').send({rules: []}).expect(400);
    await request(app).post('/api/convert/batch').send({records: []}).expect(400);
  });
});

describe('GET /api/saved-results/:id 旧数据迁移', () => {
  it('迁移后 0/false/空串/零日期仍为原值，且盖有确定来源状态', async () => {
    const app = createApp();
    const res = await request(app).get('/api/saved-results/legacy-alpha').expect(200);
    expect(res.body.version).toBe(2);
    const fields = res.body.records[0].fields as Array<{source: string; status: string; outcome?: string; value?: unknown}>;
    const bySource = new Map(fields.map(f => [f.source, f]));
    expect(bySource.get('revision')?.value).toBe(0);
    expect(bySource.get('revision')?.status).toBe(SourceStatus.Present);
    expect(bySource.get('flags.active')?.value).toBe(false);
    expect(bySource.get('flags.active')?.status).toBe(SourceStatus.Present);
    expect(bySource.get('note')?.value).toBe('');
    expect(bySource.get('note')?.status).toBe(SourceStatus.Present);
    expect(bySource.get('createdAt')?.value).toBe(EPOCH_ISO);
    expect(bySource.get('owner')?.status).toBe(SourceStatus.Null);
    expect(bySource.get('category')?.outcome).toBe('defaulted');
    expect(bySource.get('bad')?.outcome).toBe('failed');
    // output 完全保留
    expect(res.body.records[0].output.revision).toBe(0);
    expect(res.body.records[0].output.flags.active).toBe(false);
    expect(res.body.records[0].output.createdAt).toBe(EPOCH_ISO);
    expect(res.body.summary.presentFields).toBeGreaterThanOrEqual(7);
  });

  it('未知保存结果 404', async () => {
    const app = createApp();
    await request(app).get('/api/saved-results/nope').expect(404);
  });

  it('enums 端点暴露统一枚举', async () => {
    const app = createApp();
    const res = await request(app).get('/api/convert/enums').expect(200);
    expect(res.body.sourceStatuses).toEqual(['missing', 'undefined', 'null', 'present']);
    expect(res.body.nullStrategies).toEqual(['keep', 'default']);
  });
});

describe('原有映射端点回归', () => {
  it('加载、更新、版本冲突仍正常', async () => {
    const app = createApp();
    const before = await request(app).get('/api/mappings/alpha').expect(200);
    await request(app).put('/api/mappings/alpha').send({content: 'updated', revision: before.body.revision}).expect(200);
    await request(app).put('/api/mappings/alpha').send({content: 'stale', revision: before.body.revision}).expect(409);
  });
});
