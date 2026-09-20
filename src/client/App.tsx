import {useEffect, useMemo, useState} from 'react';
import {FlaskConical, Play, Save, DatabaseZap, Layers, History} from 'lucide-react';
import {
  convertBatch,
  SourceStatus,
  SOURCE_STATUSES,
  NullStrategy,
  type BatchResult,
  type FieldResult,
  type FieldRule,
  type Outcome,
} from '../shared/index.js';

type Summary={id:string;name:string;revision:number;updatedAt:string};
type Row=Summary&{content:string};

const STATUS_LABELS: Record<SourceStatus,string> = {
  [SourceStatus.Present]: 'present（含 \'\' / 0 / false）',
  [SourceStatus.Missing]: 'missing（缺键/越界/空位）',
  [SourceStatus.Undefined]: 'undefined（不可序列化）',
  [SourceStatus.Null]: 'null',
};
const OUTCOMES: Outcome[] = ['kept','coerced','defaulted','failed','omitted'];

/** 内存态示例：显式 undefined 与数组空位无法写进 JSON 文本框，只能在代码里构造 */
const demoRecords: unknown[] = [{
  id:'r-1',
  empty:'',
  zero:0,
  flag:false,
  nested:{deep:{value:42}, nullNode:null},
  // eslint-disable-next-line no-sparse-arrays
  arr:['first',,'third'],
  explicitU:undefined,
  zeroDate:0,
  falseString:'false',
  zeroDateString:new Date(0).toISOString(),
  emptyAsNumber:'',
}];

const demoRules: FieldRule[] = [
  {source:'empty', type:'string', hasDefault:true, defaultValue:'N/A'},
  {source:'zero', type:'number', hasDefault:true, defaultValue:99},
  {source:'flag', type:'boolean', hasDefault:true, defaultValue:true},
  {source:'nested.deep.missing.leaf', type:'string', hasDefault:true, defaultValue:'deep-default'},
  {source:'arr[1]', type:'string', hasDefault:true, defaultValue:'hole-default', nullStrategy:NullStrategy.Default},
  {source:'explicitU', type:'string', hasDefault:true, defaultValue:'u-default'},
  {source:'nested.nullNode', target:'nested.keptNull', type:'any', nullStrategy:NullStrategy.Keep},
  {source:'nested.nullNode', target:'nested.defaultedNull', type:'string', hasDefault:true, defaultValue:'x', nullStrategy:NullStrategy.Default},
  {source:'zeroDate', type:'date'},
  {source:'falseString', type:'boolean'},
  {source:'zeroDateString', type:'date'},
  {source:'emptyAsNumber', type:'number'},
  {source:'unset', type:'number'},
  {source:'zero', target:'zeroAsBool', type:'boolean'},
];

function StatusBadge({status}:{status:SourceStatus}){
  return <span className={`badge status-${status}`} title={STATUS_LABELS[status]}>{status}</span>;
}
function OutcomeBadge({outcome}:{outcome:Outcome}){
  return <span className={`badge outcome-${outcome}`}>{outcome}</span>;
}

function FieldsTable({fields, filter, onFilter}:{
  fields:FieldResult[]; filter:SourceStatus|Outcome|'all'; onFilter:(f:SourceStatus|Outcome|'all')=>void;
}){
  const visible = filter==='all' ? fields : fields.filter(f=>f.status===filter || f.outcome===filter);
  return (
    <div>
      <div className="filters">
        <button className={filter==='all'?'chip active':'chip'} onClick={()=>onFilter('all')}>全部 {fields.length}</button>
        {SOURCE_STATUSES.map(s=>{
          const n = fields.filter(f=>f.status===s).length;
          return <button key={s} className={filter===s?`chip active status-${s}`:`chip status-${s}`} onClick={()=>onFilter(s)}>{s} {n}</button>;
        })}
        {OUTCOMES.map(o=>{
          const n = fields.filter(f=>f.outcome===o).length;
          return <button key={o} className={filter===o?`chip active outcome-${o}`:`chip outcome-${o}`} onClick={()=>onFilter(o)}>{o} {n}</button>;
        })}
      </div>
      <table className="fields">
        <thead><tr><th>来源路径</th><th>来源状态</th><th>结果</th><th>输出值</th><th>说明</th></tr></thead>
        <tbody>
        {visible.map((f,i)=>(
          <tr key={f.source+i}>
            <td className="path">{f.source}</td>
            <td><StatusBadge status={f.status}/></td>
            <td><OutcomeBadge outcome={f.outcome}/></td>
            <td className="value"><code>{'value' in f ? JSON.stringify(f.value) : '—'}</code></td>
            <td className="error">{f.error ?? (f.defaultApplied ? `默认值 ${JSON.stringify(f.defaultValue)}` : '')}</td>
          </tr>
        ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryPanel({result}:{result:BatchResult}){
  const {summary} = result;
  return (
    <div className="summary">
      <h3>批量摘要（与服务端同一枚举）</h3>
      <div className="stat-grid">
        <div><strong>{summary.totalRecords}</strong><span>记录</span></div>
        <div><strong>{summary.totalFields}</strong><span>字段总数</span></div>
        <div className="ok"><strong>{summary.presentFields}</strong><span>有效 present（含空串/0/false）</span></div>
        <div className="warn"><strong>{summary.missingFields}</strong><span>缺失 missing+undefined</span></div>
        <div className="warn"><strong>{summary.defaultedFields}</strong><span>应用默认值</span></div>
        <div className="bad"><strong>{summary.failedFields}</strong><span>转换失败</span></div>
      </div>
      <div className="count-rows">
        <p>byStatus（唯一判定来源，禁止真假判断）</p>
        {SOURCE_STATUSES.map(s=>(
          <div key={s} className="count-row"><StatusBadge status={s}/><span>{summary.byStatus[s]}</span></div>
        ))}
        <p>byOutcome</p>
        {OUTCOMES.map(o=>(
          <div key={o} className="count-row"><OutcomeBadge outcome={o}/><span>{summary.byOutcome[o]}</span></div>
        ))}
      </div>
    </div>
  );
}

function ConvertWorkbench(){
  const [rulesText,setRulesText]=useState(JSON.stringify(demoRules,null,2));
  const [recordsText,setRecordsText]=useState('// 点击“载入示例对象（含 undefined/空位）”或在此粘贴 JSON 数组');
  const [jsonModel,setJsonModel]=useState(true);
  const [inMemoryRecords,setInMemoryRecords]=useState<unknown[]|null>(null);
  const [localResult,setLocalResult]=useState<BatchResult|null>(null);
  const [serverResult,setServerResult]=useState<BatchResult|null>(null);
  const [legacyResult,setLegacyResult]=useState<BatchResult|null>(null);
  const [filter,setFilter]=useState<SourceStatus|Outcome|'all'>('all');
  const [status,setStatus]=useState('就绪');

  function loadDemo(){
    setInMemoryRecords(demoRecords);
    setRecordsText('// 内存示例：含显式 undefined、数组空位\n'+JSON.stringify(JSON.parse(JSON.stringify(demoRecords)),null,2)+'\n// 注意：上面是 JSON 往返后的样子（undefined 键被丢弃、空位变 null）');
  }

  function parseRecords():unknown[]{
    if(inMemoryRecords) return inMemoryRecords;
    const cleaned = recordsText.replace(/^\s*\/\/.*$/gm,'');
    const parsed = JSON.parse(cleaned);
    if(!Array.isArray(parsed)) throw new Error('记录必须是数组');
    return parsed;
  }

  function preview(){
    try {
      const rules = JSON.parse(rulesText) as FieldRule[];
      // 单条预览 = 批量引擎的 1 条记录子集，摘要/状态/计数全部同源，不存在两套判断
      setLocalResult(convertBatch([parseRecords()[0]], rules, {jsonModel}));
      setStatus('已生成单条预览');
    } catch(error){setStatus(`预览失败：${(error as Error).message}`);}
  }

  async function runBatch(){
    try {
      const rules = JSON.parse(rulesText) as FieldRule[];
      setStatus('批量执行中…');
      const response = await fetch('/api/convert/batch',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({records:parseRecords(),rules,options:{jsonModel}}),
      });
      const value = await response.json();
      if(!response.ok){setStatus(`批量失败：${value.error} ${value.details??''}`);return;}
      setServerResult(value);
      setStatus(`批量完成：${value.summary.totalRecords} 条记录`);
    } catch(error){setStatus(`批量失败：${(error as Error).message}`);}
  }

  async function loadLegacy(){
    setStatus('加载旧保存数据…');
    const response = await fetch('/api/saved-results/legacy-alpha');
    const value = await response.json();
    setLegacyResult(value as BatchResult);
    setStatus('旧数据已迁移：值原样保留，仅补齐来源状态');
  }

  const shown = serverResult ?? localResult;
  const fields = useMemo(()=>shown?.records.flatMap(r=>r.fields.map(f=>({...f,source:`#${r.recordIndex} ${f.source}`})))??[], [shown]);

  return (
    <div className="convert-layout">
      <section className="pane">
        <h2><Layers size={16}/> 规则（FieldRule[]）</h2>
        <textarea aria-label="rules" spellCheck={false} value={rulesText} onChange={e=>setRulesText(e.target.value)} rows={12}/>
        <h2><DatabaseZap size={16}/> 记录</h2>
        <textarea aria-label="records" spellCheck={false} value={recordsText} onChange={e=>{setRecordsText(e.target.value);setInMemoryRecords(null);}} rows={10}/>
        <div className="toolbar">
          <button onClick={loadDemo}>载入示例对象（含 undefined/空位）</button>
          <button className="primary" onClick={preview}><Play size={15}/>单条预览（前端）</button>
          <button className="primary" onClick={runBatch}>服务端批量执行</button>
          <button onClick={loadLegacy}><History size={15}/>加载旧保存数据</button>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={jsonModel} onChange={e=>setJsonModel(e.target.checked)}/>
          JSON 数据模型（规范化 undefined/空位，预览与服务端一致；关闭用于内存诊断）
        </label>
        <span className="statusline">{status}</span>
      </section>
      <section className="pane">
        <h2>字段结果与筛选（统一 SourceStatus 枚举）</h2>
        {shown
          ? <FieldsTable fields={fields} filter={filter} onFilter={setFilter}/>
          : <p className="hint">执行预览或批量后显示。注意 ''、0、false 都是 present。</p>}
        {shown && <>
          <h2>输出对象</h2>
          <pre className="output">{JSON.stringify(shown.records[0]?.output,null,2)}</pre>
        </>}
        {legacyResult && <>
          <h2>迁移后的旧数据（值未改动）</h2>
          <FieldsTable fields={legacyResult.records[0].fields} filter={filter} onFilter={setFilter}/>
          <pre className="output">{JSON.stringify(legacyResult.records[0].output,null,2)}</pre>
        </>}
      </section>
      <aside className="pane">
        <h2>摘要</h2>
        {shown ? <SummaryPanel result={shown}/> : <p className="hint">尚无结果</p>}
        {legacyResult && <><h2>旧数据摘要（迁移补盖）</h2><SummaryPanel result={legacyResult}/></>}
      </aside>
    </div>
  );
}

function RecordsEditor(){
  const [items,setItems]=useState<Summary[]>([]);const [selected,setSelected]=useState('alpha');const [row,setRow]=useState<Row|null>(null);const [draft,setDraft]=useState('');const [analysis,setAnalysis]=useState<unknown>(null);const [status,setStatus]=useState('Ready');
  useEffect(()=>{fetch('/api/mappings').then(r=>r.json()).then(setItems)},[]);
  useEffect(()=>{setStatus('Loading');fetch('/api/mappings/'+selected).then(r=>r.json()).then((value:Row)=>{setRow(value);setDraft(value.content);setStatus('Loaded')})},[selected]);
  async function save(){if(!row)return;setStatus('Saving');const response=await fetch('/api/mappings/'+row.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft,revision:row.revision})});const value=await response.json();if(!response.ok){setStatus('Revision conflict');return}setRow(value);setStatus('Saved')}
  async function analyze(){if(!row)return;setStatus('Analyzing');const response=await fetch('/api/mappings/'+row.id+'/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content:draft})});setAnalysis(await response.json());setStatus('Ready')}
  return <section className="workspace"><aside className="pane"><h2>Items</h2><div className="list">{items.map(item=><button className={item.id===selected?'active':''} onClick={()=>setSelected(item.id)} key={item.id}>{item.name}<br/><small>Revision {item.revision}</small></button>)}</div></aside><section className="pane"><div className="toolbar"><button className="primary" onClick={save}><Save size={15}/>Save</button><button onClick={analyze}><Play size={15}/>Analyze</button><span>{status}</span></div><textarea aria-label="Content" value={draft} onChange={event=>setDraft(event.target.value)}/></section><aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(analysis??row,null,2)}</pre></aside></section>;
}

export default function App(){
  const [tab,setTab]=useState<'convert'|'records'>('convert');
  return <main className="shell">
    <header className="topbar"><FlaskConical size={20}/><strong>Migration Mapping Studio</strong>
      <nav className="tabs">
        <button className={tab==='convert'?'active':''} onClick={()=>setTab('convert')}>Payload 转换工作台</button>
        <button className={tab==='records'?'active':''} onClick={()=>setTab('records')}>记录编辑</button>
      </nav>
      <small>Local workspace</small>
    </header>
    {tab==='convert'?<ConvertWorkbench/>:<RecordsEditor/>}
  </main>;
}
