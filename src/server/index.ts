import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  convertRecord,
  FieldSpec,
  migrateLegacyRecord,
  prepareSerializable,
  Presence,
  summarize,
} from '../shared/presence.js';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary transform runs',revision:3,content:'transform runs: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary transform runs',revision:5,content:'transform runs: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

// 服务端批量执行使用的字段规格：与前端预览同一份语义（共享模块）。
const BATCH_SPECS: FieldSpec[] = [
  {path:'name', type:'string'},
  {path:'meta.revision', type:'number', default:0},
  {path:'meta.note', type:'string', default:''},
  {path:'meta.archived', type:'boolean', default:false},
  {path:'meta.occurredAt', type:'date', nullPolicy:'default', default:0},
  {path:'meta.reviewer', type:'string', nullPolicy:'keep', missingPolicy:'keep'},
];

/** 含全部边界的批量样本：嵌套缺键、数组空位、显式 undefined、null、零、false、''。 */
function buildBatchPayload(): Record<string, unknown>[] {
  // 刻意保留稀疏空位 [hole] 与显式 undefined，测试服务端路径读取与序列化扫描。
  const sparse: unknown[] = ['alpha'];
  sparse[2] = 'gamma'; // 索引 1 为空位
  sparse[3] = undefined; // 索引 3 为显式 undefined（内存可表达）

  return [
    {
      name: '', // 空字符串是 Present
      meta: {revision: 0, note: '', archived: false, occurredAt: 0, reviewer: null}, // 0/false/零日期/null
    },
    {
      name: 'beta',
      meta: {revision: 5, note: 'ok', archived: true, occurredAt: 1000 /* reviewer 嵌套缺键 */},
    },
    {name: 'gamma', meta: {revision: undefined /* 显式 undefined */, note: 'x', archived: false}},
    {name: sparse, meta: {revision: 7, note: 'n', archived: false, occurredAt: null}},
  ];
}

/** 旧保存数据：只有值、没有来源状态（present 字段无 presence 元数据）。 */
const LEGACY_RECORDS: Record<string, unknown>[] = [
  {name: '', meta: {revision: 0, archived: false, occurredAt: 0, note: ''}},
  {name: 'delta', meta: {revision: 3, reviewer: null}},
];

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"migration-mapping",count:rows.length}));
  app.get('/api/mappings',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/mappings/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/mappings/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/mappings/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // 字段规格：让前端与服务端确认使用同一套配置。
  app.get('/api/specs', (_req, res) => res.json({specs: BATCH_SPECS, presence: Presence}));

  // 服务端批量执行：独立从原始 payload 转换，只返回枚举状态与枚举口径摘要。
  app.post('/api/batch-convert', (req, res) => {
    const specs: FieldSpec[] = Array.isArray(req.body?.specs) ? req.body.specs : BATCH_SPECS;
    const payload: unknown = req.body?.records ?? buildBatchPayload();
    if (!Array.isArray(payload)) {
      return res.status(400).json({error: 'records_must_be_array'});
    }
    const results = payload.map((record) => convertRecord(specs as FieldSpec[], record));
    const summary = summarize(results, specs as FieldSpec[]);

    // 输出前统一扫描显式 undefined / 数组空位。
    // 输出对象本身不写 undefined 键，但字段树的 value 可能携带 undefined
    // （missing/undefined 且策略 keep）——严格模式必须在响应前拦截这种不可表达状态。
    const strict = req.body?.strictSerialization === true;
    const fieldTree = results.map((r) =>
      Object.fromEntries(r.fields.map((f) => [f.path, f.value])),
    );
    let serialized: unknown;
    let serializationIssues = [] as ReturnType<typeof prepareSerializable>['issues'];
    try {
      const outputScan = prepareSerializable(results.map((r) => r.output), {strict});
      const fieldScan = prepareSerializable(fieldTree, {strict, path: 'fields'});
      serialized = outputScan.value;
      serializationIssues = [...outputScan.issues, ...fieldScan.issues];
    } catch (error) {
      return res.status(422).json({
        error: 'unserializable_payload',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    return res.json({
      count: results.length,
      // 每条字段都附带 Presence 枚举值，前端不得重新推断。
      records: results.map((result) => ({
        output: result.output,
        fields: result.fields.map((field) => ({
          path: field.path,
          type: field.type,
          value: field.value,
          raw: field.raw,
          presence: field.presence,
          issues: field.issues,
        })),
      })),
      serialized,
      serializationIssues,
      summary,
    });
  });

  // 旧数据迁移：无来源状态 -> 结构推断，有效值原样保留。
  app.post('/api/migrate-legacy', (req, res) => {
    const specs: FieldSpec[] = Array.isArray(req.body?.specs) ? req.body.specs : BATCH_SPECS;
    const records: unknown[] = Array.isArray(req.body?.records) ? req.body.records : LEGACY_RECORDS;
    const migrated = records.map((record) => migrateLegacyRecord(specs as FieldSpec[], record));
    return res.json({
      count: migrated.length,
      records: migrated.map((result) => ({
        output: result.output,
        fields: result.fields.map((field) => ({
          path: field.path,
          type: field.type,
          value: field.value,
          raw: field.raw,
          presence: field.presence,
          inferred: field.issues.some((i) => i.code === 'LEGACY_WITHOUT_PRESENCE'),
          issues: field.issues,
        })),
      })),
    });
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
