import {useEffect, useMemo, useState} from 'react';
import {FlaskConical, Play, Save, Database, Archive} from 'lucide-react';
import {
  BatchSummary,
  ConvertedField,
  convertRecord,
  FieldSpec,
  migrateLegacyRecord,
  Presence,
  PRESENCE_LABEL,
  PresenceIssue,
  prepareSerializable,
} from '../shared/presence';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

/** 与服务端 BATCH_SPECS 同构；启动时从 /api/specs 拉取，保证不是两份定义。 */
const FALLBACK_SPECS: FieldSpec[] = [
  {path:'name', type:'string'},
  {path:'meta.revision', type:'number', default:0},
  {path:'meta.note', type:'string', default:''},
  {path:'meta.archived', type:'boolean', default:false},
  {path:'meta.occurredAt', type:'date', nullPolicy:'default', default:0},
  {path:'meta.reviewer', type:'string', nullPolicy:'keep', missingPolicy:'keep'},
];

/** 构造内存样本：数组空位与显式 undefined 无法用 JSON 文本表达。 */
function buildMemorySample(): unknown {
  const tags: unknown[] = ['a'];
  tags[2] = 'c'; // 索引 1 为空位
  tags[3] = undefined; // 索引 3 为显式 undefined
  return {
    name: '',
    tags,
    meta: {revision: 0, note: '', archived: false, occurredAt: 0, reviewer: null},
  };
}

const PRESET_JSON = JSON.stringify(
  {name:'beta', meta:{revision:5, note:'ok', archived:true, occurredAt:1000}},
  null,
  2,
);

const PILL_CLASS: Record<Presence, string> = {
  [Presence.Present]: 'p-present',
  [Presence.Null]: 'p-null',
  [Presence.Missing]: 'p-missing',
  [Presence.Undefined]: 'p-undefined',
  [Presence.Defaulted]: 'p-defaulted',
  [Presence.Invalid]: 'p-invalid',
};

interface FieldView {
  field: ConvertedField;
  inferred?: boolean;
}

export default function App(){
  const [items,setItems]=useState<Summary[]>([]);
  const [selected,setSelected]=useState('alpha');
  const [row,setRow]=useState<Row|null>(null);
  const [draft,setDraft]=useState('');
  const [status,setStatus]=useState('Ready');
  const [specs,setSpecs]=useState<FieldSpec[]>(FALLBACK_SPECS);
  const [jsonInput,setJsonInput]=useState(PRESET_JSON);
  const [memorySample,setMemorySample]=useState<unknown>(null);
  const [fields,setFields]=useState<FieldView[]>([]);
  const [output,setOutput]=useState<unknown>(null);
  const [issues,setIssues]=useState<PresenceIssue[]>([]);
  const [filter,setFilter]=useState<Presence|null>(null);
  const [batch,setBatch]=useState<BatchSummary|null>(null);
  const [strictSerialize,setStrictSerialize]=useState(false);

  useEffect(()=>{fetch('/api/mappings').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/mappings/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  useEffect(()=>{fetch('/api/specs').then(r=>r.ok?r.json():null).then(value=>{if(value?.specs)setSpecs(value.specs)}).catch(()=>undefined)},[]);

  /** 前端单条预览：与服务端同一个 convertRecord，枚举状态由核心模块给出。 */
  function preview(source: unknown){
    const result = convertRecord(specs, source);
    let scanIssues: PresenceIssue[] = [];
    let serializable: unknown = result.output;
    try {
      const scan = prepareSerializable(result.output, {strict: strictSerialize});
      serializable = scan.value;
      scanIssues = scan.issues;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      return;
    }
    setFields(result.fields.map(field=>({field})));
    setOutput(serializable);
    setIssues([...result.issues, ...scanIssues]);
    setBatch(null);
    setStatus('Previewed（与批量执行同一路径）');
  }

  function previewJson(){
    let parsed: unknown;
    try { parsed = JSON.parse(jsonInput); }
    catch(error){ setStatus('JSON 解析失败：'+(error instanceof Error?error.message:String(error))); return; }
    setMemorySample(null);
    preview(parsed);
  }

  function previewMemory(){
    const sample = buildMemorySample();
    setMemorySample(sample);
    setJsonInput('// 内存样本（含数组空位与显式 undefined，JSON 文本无法表达）\n'+safeInspect(sample));
    preview(sample);
  }

  /** 旧数据迁移预览：无来源状态，按结构推断，不改有效值。 */
  function previewLegacy(){
    const source = memorySample ?? safeParse(jsonInput) ?? {};
    const result = migrateLegacyRecord(specs, source);
    setFields(result.fields.map(field=>({field, inferred:true})));
    setOutput(result.output);
    setIssues(result.issues);
    setBatch(null);
    setStatus('已按确定规则迁移来源状态（有效值未改写）');
  }

  async function runBatch(){
    setStatus('批量执行中…');
    const response = await fetch('/api/batch-convert',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({strictSerialization:strictSerialize}),
    });
    if(response.status===422){
      const value=await response.json();
      setStatus('序列化被拒绝：'+value.detail);
      return;
    }
    const value=await response.json();
    setBatch(value.summary);
    setIssues(value.serializationIssues ?? []);
    const first = value.records?.[0];
    if(first){
      setFields(first.fields.map((f: ConvertedField)=>({field:f})));
      setOutput(value.serialized);
    }
    setStatus(`批量完成 ${value.count} 条；统计口径来自 Presence 枚举`);
  }

  async function migrateOnServer(){
    setStatus('迁移旧数据中…');
    const response = await fetch('/api/migrate-legacy',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    const value=await response.json();
    const first=value.records?.[0];
    if(first){
      setFields(first.fields.map((f: ConvertedField)=>({field:f, inferred:true})));
      setOutput(value.records.map((r:{output:unknown})=>r.output));
      setIssues(first.issues ?? []);
    }
    setBatch(null);
    setStatus(`旧数据 ${value.count} 条已迁移来源状态（有效值原样保留）`);
  }

  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/mappings/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/mappings/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});await response.json();setStatus('Ready')}

  const visibleFields = useMemo(
    ()=>filter ? fields.filter(v=>v.field.presence===filter) : fields,
    [fields,filter],
  );

  return <main className="shell">
    <header className="topbar"><FlaskConical size={20}/><strong>Payload Migration Workbench</strong><small>统一存在性语义 · Presence enum</small></header>
    <section className="workspace">
      <aside className="pane">
        <h2>Saved records</h2>
        <div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div>
        <textarea aria-label="Content" className="draft" value={draft} onChange={event=>setDraft(event.target.value)}/>
        <div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button></div>
        <span>{status}</span>
        <hr/>
        <h2>Field specs</h2>
        <pre className="specs">{specs.map(s=>`${s.path} : ${s.type}${'default' in s?` = ${safeInspect(s.default)}`:''}${s.nullPolicy==='default'?' [null→default]':''}${s.missingPolicy==='keep'?' [missing keep]':''}`).join('\n')}</pre>
        <label className="check"><input type="checkbox" checked={strictSerialize} onChange={e=>setStrictSerialize(e.target.checked)}/>严格序列化（undefined / 空位报错）</label>
      </aside>

      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={previewJson}><Play size={15}/>单条预览</button>
          <button onClick={previewMemory}>空位/undefined 样本</button>
          <button onClick={runBatch}><Database size={15}/>服务端批量</button>
          <button onClick={previewLegacy}>本地迁移旧数据</button>
          <button onClick={migrateOnServer}><Archive size={15}/>服务端迁移</button>
        </div>
        <textarea aria-label="Payload JSON" value={jsonInput} onChange={event=>{setJsonInput(event.target.value);setMemorySample(null)}}/>
        <div className="toolbar chips">
          <span>筛选：</span>
          <button className={filter===null?'chip active':'chip'} onClick={()=>setFilter(null)}>全部</button>
          {Object.values(Presence).map(p=>
            <button key={p} className={`chip ${PILL_CLASS[p]} ${filter===p?'active':''}`} onClick={()=>setFilter(p)}>
              {PRESENCE_LABEL[p]} <b>{fields.filter(v=>v.field.presence===p).length}</b>
            </button>)}
        </div>
        <div className="fieldlist">
          {visibleFields.map(({field,inferred})=>
            <div className="fieldrow" key={field.path}>
              <span className={`pill ${PILL_CLASS[field.presence]}`}>{PRESENCE_LABEL[field.presence]}{inferred?' · 迁移推断':''}</span>
              <code>{field.path}</code>
              <span className="val">raw={safeInspect(field.raw)} → {safeInspect(field.value)}</span>
            </div>)}
          {visibleFields.length===0 && <small>无匹配字段</small>}
        </div>
        {issues.length>0 && <div className="issues"><strong>诊断</strong>
          <ul>{issues.map((i,idx)=><li key={idx}><code>{i.code}</code> {i.message}</li>)}</ul></div>}
      </section>

      <aside className="pane">
        <h2>Inspection</h2>
        <span className="pill">{selected}</span>
        {batch && <BatchSummaryView summary={batch}/>}
        <pre>{safeInspect(output)}</pre>
      </aside>
    </section>
  </main>;
}

function BatchSummaryView({summary}:{summary:BatchSummary}){
  return <div className="summary">
    <h3>批量摘要（{summary.total} 条）</h3>
    <table>
      <thead><tr><th>字段</th>{Object.values(Presence).map(p=><th key={p}>{PRESENCE_LABEL[p]}</th>)}<th>有效</th></tr></thead>
      <tbody>{summary.fields.map(f=><tr key={f.path}>
        <td><code>{f.path}</code></td>
        {Object.values(Presence).map(p=><td key={p} className={f.counts[p]>0?PILL_CLASS[p]:''}>{f.counts[p]}</td>)}
        <td><b>{f.filled}</b>/{f.total}</td>
      </tr>)}</tbody>
    </table>
    <small>有效 = {PRESENCE_LABEL[Presence.Present]} + {PRESENCE_LABEL[Presence.Defaulted]}；空字符串/0/false 计入有效，诊断 {summary.issues} 条</small>
  </div>;
}

// 展示用检查器：显式标注 undefined 与空位，不用真值判断吞值。
function safeInspect(value: unknown, depth=0): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (depth > 4) return Array.isArray(value) ? '[…]' : '{…}';
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i=0;i<value.length;i++) parts.push(i in value ? safeInspect(value[i],depth+1) : '<hole>');
    return '['+parts.join(', ')+']';
  }
  if (value instanceof Date) return value.toISOString();
  const pairs = Object.keys(value).map(k=>`${k}: ${safeInspect((value as Record<string,unknown>)[k],depth+1)}`);
  return '{'+pairs.join(', ')+'}';
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}
