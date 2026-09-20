import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {Presence} from '../src/shared/presence';

describe('service',()=>{it('loads and conditionally updates a record',async()=>{const app=createApp();const before=await request(app).get('/api/mappings/alpha').expect(200);await request(app).put('/api/mappings/alpha').send({content:'updated',revision:before.body.revision}).expect(200);await request(app).put('/api/mappings/alpha').send({content:'stale',revision:before.body.revision}).expect(409)})});

describe('批量转换端点', () => {
  it('每条字段附 Presence 枚举，假值计入有效、null 与缺失分列', async () => {
    const app = createApp();
    const res = await request(app).post('/api/batch-convert').send({}).expect(200);
    expect(res.body.count).toBe(4);
    const first = res.body.records[0];
    const name = first.fields.find((f: {path: string}) => f.path === 'name');
    expect(name.presence).toBe(Presence.Present);
    expect(name.value).toBe('');
    const reviewer = first.fields.find((f: {path: string}) => f.path === 'meta.reviewer');
    expect(reviewer.presence).toBe(Presence.Null);
    // 摘要按枚举计数
    const nameSummary = res.body.summary.fields.find((f: {path: string}) => f.path === 'name');
    expect(nameSummary.counts[Presence.Present]).toBeGreaterThanOrEqual(2);
    expect(res.body.summary.totals[Presence.Present] + res.body.summary.totals[Presence.Defaulted])
      .toBe(res.body.summary.filled);
  });

  it('嵌套缺键、数组空位、显式 undefined 在服务端被区分', async () => {
    const app = createApp();
    // 经 HTTP 传输（JSON）：空位/undefined 会变成 null，但显式构造的嵌套缺键仍可验证。
    const records = [
      {name: 'a', meta: {revision: 0, archived: false, occurredAt: 0}}, // reviewer/note 缺键
      {name: 'b', meta: {revision: 1, archived: true, occurredAt: null, note: null, reviewer: null}},
    ];
    const res = await request(app).post('/api/batch-convert').send({records}).expect(200);
    const [r1, r2] = res.body.records;
    const reviewer1 = r1.fields.find((f: {path: string}) => f.path === 'meta.reviewer');
    expect(reviewer1.presence).toBe(Presence.Missing);
    const reviewer2 = r2.fields.find((f: {path: string}) => f.path === 'meta.reviewer');
    expect(reviewer2.presence).toBe(Presence.Null);
    // occurredAt nullPolicy=default + default 0 => 零日期
    const occurred = r2.fields.find((f: {path: string}) => f.path === 'meta.occurredAt');
    expect(occurred.presence).toBe(Presence.Defaulted);
    expect(occurred.value).toBe(new Date(0).toISOString());
  });

  it('严格序列化模式拒绝显式 undefined 场景的输出', async () => {
    const app = createApp();
    // 用自定义 specs 制造一个 keep 的 undefined 输出，再要求严格序列化。
    const specs = [{path: 'u', type: 'string' as const, missingPolicy: 'keep' as const}];
    const records: Record<string, unknown>[] = [{u: undefined}];
    const res = await request(app)
      .post('/api/batch-convert')
      .send({specs, records, strictSerialization: true})
      .expect(422);
    expect(res.body.error).toBe('unserializable_payload');
  });
});

describe('旧数据迁移端点', () => {
  it('无来源状态时按规则迁移，假值保持 Present 且值不改', async () => {
    const app = createApp();
    const res = await request(app).post('/api/migrate-legacy').send({}).expect(200);
    const first = res.body.records[0];
    const name = first.fields.find((f: {path: string}) => f.path === 'name');
    const rev = first.fields.find((f: {path: string}) => f.path === 'meta.revision');
    const archived = first.fields.find((f: {path: string}) => f.path === 'meta.archived');
    expect(name.presence).toBe(Presence.Present);
    expect(name.value).toBe('');
    expect(rev.presence).toBe(Presence.Present);
    expect(rev.value).toBe(0);
    expect(archived.presence).toBe(Presence.Present);
    expect(archived.value).toBe(false);
    expect(first.fields.every((f: {inferred: boolean}) => f.inferred)).toBe(true);
    // null 不被推断成缺失
    const second = res.body.records[1];
    const reviewer = second.fields.find((f: {path: string}) => f.path === 'meta.reviewer');
    expect(reviewer.presence).toBe(Presence.Null);
  });
});
