import express from 'express';
import {fileURLToPath} from 'node:url';
import {
  convertBatch,
  migrateSavedResult,
  stampVersion,
  SourceStatus,
  NullStrategy,
  type BatchResult,
  type FieldRule,
} from '../shared/index.js';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary transform runs',revision:3,content:'transform runs: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary transform runs',revision:5,content:'transform runs: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

/** 最近一次批量执行结果（内存态） */
let lastBatch: BatchResult | null = null;

/**
 * v1 旧保存数据：字段只有 source/value，没有 status/outcome。
 * 特意包含 0、false、''、零日期字符串、null、缺键，验证迁移不改值。
 */
const legacySources = [{
  name:'Primary transform runs',
  revision: 0,
  note: '',
  flags: {active: false},
  owner: null,
  createdAt: new Date(0).toISOString(),
  tags: ['zero', ''],
  bad: 'not-a-number',
}];
const legacySaved = {
  version: 1,
  savedAt: '2025-12-01T00:00:00.000Z',
  records: [{
    fields: [
      {source:'name', target:'name', value:'Primary transform runs', type:'string'},
      {source:'revision', target:'revision', value:0, type:'number'},
      {source:'note', target:'note', value:'', type:'string'},
      {source:'flags.active', target:'flags.active', value:false, type:'boolean'},
      {source:'owner', target:'owner', value:null},
      {source:'createdAt', target:'createdAt', value:new Date(0).toISOString(), type:'date'},
      {source:'tags[1]', target:'tags[1]', value:'', type:'string'},
      {source:'category', target:'category', value:'uncategorized', default:true},
      {source:'dropped', target:'dropped', default:true, value:'N/A'},
      {source:'bad', target:'bad', error:'"not-a-number" is not a finite number', type:'number'},
    ],
    output: {
      name:'Primary transform runs',
      revision: 0,
      note: '',
      flags: {active: false},
      owner: null,
      createdAt: new Date(0).toISOString(),
      tags: ['zero', ''],
      category: 'uncategorized',
      dropped: 'N/A',
    },
  }],
};

export function createApp(){
  const app=express();
  app.use(express.json({limit:'1mb'}));
  app.get('/api/bootstrap',(_req,res)=>res.json({family:"migration-mapping",count:rows.length}));
  app.get('/api/mappings',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/mappings/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/mappings/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/mappings/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  /** 服务端批量执行：与前端预览共用 shared 引擎，路径解析错误返回 400 */
  app.post('/api/convert/batch',(req,res)=>{
    const body = req.body ?? {};
    if(!Array.isArray(body.records)) return res.status(400).json({error:'records_must_be_array'});
    if(!Array.isArray(body.rules)) return res.status(400).json({error:'rules_must_be_array'});
    const jsonModel = body.options?.jsonModel !== false;
    try {
      const result = convertBatch(body.records as unknown[], body.rules as FieldRule[], {jsonModel});
      lastBatch = result;
      res.json(result);
    } catch (error) {
      res.status(400).json({error:'invalid_rule', details: error instanceof Error ? error.message : String(error)});
    }
  });

  app.get('/api/convert/last',(_req,res)=>{
    if(!lastBatch) return res.status(404).json({error:'no_batch_yet'});
    res.json(lastBatch);
  });

  /** 旧保存结果：读取时按确定规则迁移来源状态，output/value 原样保留 */
  app.get('/api/saved-results/:id',(req,res)=>{
    if(req.params.id!=='legacy-alpha') return res.status(404).json({error:'not_found'});
    const migrated = migrateSavedResult(legacySaved, {sources: legacySources});
    res.json(stampVersion(migrated));
  });

  /** 供 UI 展示的状态/策略元数据：两端同源，禁止前端自造真假判断 */
  app.get('/api/convert/enums',(_req,res)=>{
    res.json({
      sourceStatuses: Object.values(SourceStatus),
      nullStrategies: Object.values(NullStrategy),
    });
  });

  return app;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
