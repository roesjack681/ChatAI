"use client";

import { FormEvent, useEffect, useState } from "react";

import { api, type Section } from "./api";
import { Chat } from "./chat";
import {MemoryPanel} from "./memory";
import { ROLE_FIELD_LABELS } from "../../../../packages/character/src/fields";

interface Props {
  section: Section;
  userId: string;
  setUserId: (id: string) => void;
  notify: (message: string) => void;
  tick: number;
  reload: () => void;
}

export function Panel(props: Props) {
  switch (props.section) {
    case "chat": return <Chat {...props} />;
    case "character": return <Character {...props} />;
    case "world": return <World {...props} />;
    case "stories": return <Stories {...props} />;
    case "npcs": return <Npcs {...props} />;
    case "memory": return <MemoryPanel {...props} />;
    case "proactive": return <Proactive {...props} />;
    case "operations": return <Operations {...props} />;
    case "traces": return <Traces />;
    case "prompts": return <Prompts {...props} />;
    case "evaluate": return <Evaluate {...props} />;
    case "channels": return <Channels {...props} />;
    case "settings": return <Settings />;
    default: return <Home {...props} />;
  }
}

function useData<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    loader().then((value) => { if (live) { setData(value); setError(""); } }).catch((caught: Error) => { if (live) setError(caught.message); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error };
}

function Home({ notify }: Props) {
  const { data, error } = useData(() => Promise.all([api<any>("/api/dashboard"), api<any>("/api/world")]), []);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取总览…</p>;
  const [dashboard, world] = data;
  return (
    <div className="grid">
      <section className="grid stats">
        <Stat label="用户" value={dashboard.users} />
        <Stat label="今日消息" value={dashboard.messages_today} />
        <Stat label="追踪" value={dashboard.traces} />
        <Stat label="Token" value={Number(dashboard.token_usage).toLocaleString()} />
      </section>
      <section className="grid two">
        <article className="card">
          <h2>今日生活</h2>
          <EventList events={world.events} />
        </article>
        <article className="card">
          <h2>{dashboard.character.name}</h2>
          <p>{dashboard.character.occupation} · {dashboard.character.city}</p>
          <p className="muted">{dashboard.character.personality}</p>
          <div className="row"><span>模型</span><b>{dashboard.provider}</b></div>
          <div className="row"><span>日期</span><b>{dashboard.today}</b></div>
          <p className="notice">模型没有写世界账本的工具。主动消息默认关闭。</p>
        </article>
      </section>
    </div>
  );
}

function Character({ notify, tick, reload }: Props) {
  const { data, error } = useData(() => Promise.all([
    api<any>("/api/character"),
    api<any>("/api/character/versions"),
    api<any>("/api/character/growth/evidence"),
  ]), [tick]);
  const [mood, setMood] = useState("");
  const [profile, setProfile] = useState<Record<string, any>>({});
  const [growth, setGrowth] = useState({ attribute: "", proposed_value: "", evidence_date: "", summary: "" });
  useEffect(() => {
    if (data) {
      setMood(data[0].mood);
      const { growth: _growth, version: _version, ...editable } = data[0].character;
      setProfile(editable);
    }
  }, [data]);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取角色…</p>;
  const [character, versions, evidence] = data;
  return (
    <section className="grid">
      <section className="grid two">
        <article className="card">
          <h2>{profile.name}的档案草稿</h2>
          <p className="muted">这里维护同一位角色的身份、生活与成长背景，发布版本后才会进入对话。</p>
          {Object.entries(profile).filter(([,value])=>!Array.isArray(value)).map(([key, value]) => (
            <div className="field" key={key}><label>{ROLE_FIELD_LABELS[key] ?? key}</label>{String(value).length>45 ? <textarea rows={3} value={String(value)} onChange={(event)=>setProfile({...profile,[key]:event.target.value})}/> : <input type={key==="age"?"number":"text"} value={String(value)} onChange={(event) => setProfile({ ...profile, [key]: key === "age" ? Number(event.target.value) : event.target.value })} />}</div>
          ))}
          <RoleBackgroundEditor field="life_experiences" items={profile.life_experiences ?? []} onChange={(items)=>setProfile({...profile,life_experiences:items})}/>
          <RoleBackgroundEditor field="relationship_network" items={profile.relationship_network ?? []} roleName={profile.name} onChange={(items)=>setProfile({...profile,relationship_network:items})}/>
          <button className="btn" onClick={async () => { await api("/api/character/drafts", { method: "POST", body: JSON.stringify({ name: `档案修订 ${new Date().toLocaleDateString()}`, profile }) }); notify("角色草稿已保存，发布前不会生效"); reload(); }}>保存草稿</button>
        </article>
        <article className="card">
          <h2>全局情绪</h2>
          <div className="field"><label>当前状态</label><input value={mood} onChange={(event) => setMood(event.target.value)} /></div>
          <button className="btn" onClick={async () => { await api("/api/settings/mood", { method: "POST", body: JSON.stringify({ mood }) }); notify("情绪已保存"); }}>保存</button>
          <h2>成长证据</h2>
          {Object.entries(growth).map(([key, value]) => <div className="field" key={key}><label>{key}</label><input type={key === "evidence_date" ? "date" : "text"} value={value} onChange={(event) => setGrowth({ ...growth, [key]: event.target.value })} /></div>)}
          <div className="actions">
            <button className="btn ghost" onClick={async () => { await api("/api/character/growth/evidence", { method: "POST", body: JSON.stringify(growth) }); notify("证据已记录"); reload(); }}>记录证据</button>
            <button className="btn" onClick={async () => { await api("/api/character/growth/apply", { method: "POST", body: JSON.stringify(growth) }); notify("成长草稿已生成，仍需发布"); reload(); }}>生成成长草稿</button>
          </div>
          <p className="muted">核心人格不可由成长自动改写；同一成长至少需要两个不同日期的证据。</p>
        </article>
      </section>
      <section className="grid two">
        <article className="card"><h2>版本</h2>{versions.versions.map((item: any) => <div className="row" key={item.id}><span>#{item.id} {item.name} · {item.status}</span>{item.status !== "published" ? <button className="btn ghost" onClick={async () => { await api("/api/character/publish", { method: "POST", body: JSON.stringify({ id: item.id }) }); notify("角色版本已发布"); reload(); }}>发布</button> : <b>当前</b>}</div>)}</article>
        <article className="card"><h2>证据记录</h2><Mini rows={evidence.items.map((item: any) => `${item.evidence_date} ${item.attribute} → ${item.proposed_value} [${item.status}]`)} /><p className="muted">当前发布版本 #{character.character.version}</p></article>
      </section>
    </section>
  );
}

function RoleBackgroundEditor({field,items,roleName,onChange}:{field:"life_experiences"|"relationship_network";items:any[];roleName?:string;onChange:(items:any[])=>void}) {
  const experience=field==="life_experiences";
  const labels:Record<string,string>=experience ? {age_start:"开始年龄",age_end:"结束年龄",period:"人生阶段",title:"经历标题",event:"发生过什么",impact:"对性格和习惯的影响",people:"相关人物（顿号分隔）",keywords:"关联话题（顿号分隔）"} : {from:"人物一",to:"人物二",relation:"关系",closeness:"亲近程度",interaction:"相处细节",boundary:"关系边界"};
  function update(index:number,key:string,value:unknown){onChange(items.map((item,i)=>i===index?{...item,[key]:value}:item));}
  return <section className="role-background"><h3>{ROLE_FIELD_LABELS[field]} · {items.length} 条</h3><p className="muted">{experience?"固定的成长背景与实时生活事件分别保存，不会被当作和用户的共同经历。":"这些是当前角色生活中的家人朋友，用来保持叙述一致。"}</p>{items.map((item,index)=><details key={item.id ?? index}><summary>{experience?`${item.age_start}–${item.age_end}岁 · ${item.title}`:`${item.from} ↔ ${item.to} · ${item.relation}`}</summary>{Object.entries(labels).map(([key,label])=><div className="field" key={key}><label>{label}</label>{["event","impact","interaction","boundary"].includes(key)?<textarea rows={3} value={item[key]??""} onChange={(event)=>update(index,key,event.target.value)}/>:<input type={key.startsWith("age_")?"number":"text"} value={Array.isArray(item[key])?item[key].join("、"):item[key]??""} onChange={(event)=>update(index,key,key.startsWith("age_")?Number(event.target.value):["people","keywords"].includes(key)?event.target.value.split(/[、，,]/u).map((word)=>word.trim()).filter(Boolean):event.target.value)}/>}</div>)}<button className="btn danger" onClick={()=>onChange(items.filter((_,i)=>i!==index))}>删除这条{experience?"经历":"关系"}</button></details>)}<button className="btn ghost" onClick={()=>onChange([...items,experience?{id:`experience-${Date.now()}`,age_start:0,age_end:0,period:"",title:"新经历",event:"",impact:"",people:[],keywords:[]}:{from:roleName??"",to:"",relation:"",closeness:"",interaction:"",boundary:""}])}>添加{experience?"经历":"关系"}</button></section>;
}

function WorldBranches({nodes,depth=0}:{nodes:Array<{id:string;label:string;value?:string;children?:any[]}>;depth?:number}) {
  return <ul className="world-branches">{nodes.map((node)=><li key={node.id}>{node.children?.length ? <details open={depth===0}><summary>{node.label}</summary>{node.value ? <p className="muted">{node.value}</p> : null}<WorldBranches nodes={node.children} depth={depth+1}/></details> : <div><b>{node.label}</b>{node.value ? <span className="muted"> · {node.value}</span> : null}</div>}</li>)}</ul>;
}

function World({ notify, tick, reload }: Props) {
  const { data, error } = useData(() => Promise.all([api<any>("/api/world"), api<any>("/api/schedules"), api<any>("/api/world/lore"),api<any>("/api/world/tree")]), [tick]);
  const [days, setDays] = useState(7);
  const [result, setResult] = useState("");
  const [schedule, setSchedule] = useState({ weekday: "", start_time: "09:00", end_time: "10:00", title: "", details: "", category: "routine", probability: "1" });
  const [fact, setFact] = useState({ subject: "", predicate: "", object: "", scope: "global" });
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取生活账本…</p>;
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api("/api/world/events", { method: "POST", body: JSON.stringify(Object.fromEntries(form.entries())) });
    notify("已写入账本");
    reload();
  }
  const [world, schedules, lore, hierarchy] = data;
  return (
    <section className="grid">
    <article className="card"><h2>世界树</h2><p className="muted">角色档案、地点、学校与社团、固定人物、目标和生活模板的实时结构。{hierarchy.summary.npcs} 位人物 · {hierarchy.summary.active_goals} 条活跃目标 · {hierarchy.summary.facts} 条已确认设定。</p><WorldBranches nodes={hierarchy.tree} /></article>
    <section className="grid two">
      <article className="card">
        <h2>{world.date}</h2>
        <EventList events={world.events} />
        <form onSubmit={add}>
          <div className="field"><label>标题</label><input name="title" required /></div>
          <div className="field"><label>说明</label><textarea name="details" /></div>
          <div className="actions">
            <input name="date" type="date" defaultValue={world.date} />
            <input name="start_time" type="time" />
            <input name="end_time" type="time" />
            <select name="status" defaultValue="planned"><option value="planned">计划中</option><option value="ongoing">进行中</option><option value="completed">已完成</option><option value="postponed">延期</option><option value="cancelled">取消</option></select>
          </div>
          <button className="btn" type="submit">写入</button>
        </form>
      </article>
      <article className="card">
        <h2>沙盒骨架</h2>
        <p className="muted">最多 30 天。沙盒事件不进入正式世界。</p>
        <div className="field"><label>天数</label><input type="number" min={1} max={30} value={days} onChange={(event) => setDays(Number(event.target.value))} /></div>
        <button className="btn ghost" onClick={async () => { const response = await api<any>("/api/sandbox/simulate", { method: "POST", body: JSON.stringify({ days }) }); setResult(`生成 ${response.days.length} 天，${response.events_created} 条事件`); }}>生成</button>
        <p>{result}</p>
      </article>
    </section>
    <section className="grid two">
      <article className="card"><h2>日程模板</h2>{schedules.items.map((item: any) => <div className="row" key={item.id}><span>{item.weekday == null ? "每天" : `周${Number(item.weekday) + 1}`} {item.start_time}–{item.end_time || ""} {item.title}</span><b>{item.enabled ? `${Math.round(item.probability * 100)}%` : "停用"}</b></div>)}</article>
      <article className="card"><h2>新增日程模板</h2>
        <div className="field"><label>星期（留空=每天，0=周一）</label><input type="number" min={0} max={6} value={schedule.weekday} onChange={(event) => setSchedule({ ...schedule, weekday: event.target.value })} /></div>
        <div className="actions"><input type="time" value={schedule.start_time} onChange={(event) => setSchedule({ ...schedule, start_time: event.target.value })} /><input type="time" value={schedule.end_time} onChange={(event) => setSchedule({ ...schedule, end_time: event.target.value })} /></div>
        <div className="field"><label>标题</label><input value={schedule.title} onChange={(event) => setSchedule({ ...schedule, title: event.target.value })} /></div>
        <div className="field"><label>说明</label><textarea value={schedule.details} onChange={(event) => setSchedule({ ...schedule, details: event.target.value })} /></div>
        <div className="field"><label>出现概率（0–1）</label><input type="number" min={0} max={1} step={0.05} value={schedule.probability} onChange={(event) => setSchedule({ ...schedule, probability: event.target.value })} /></div>
        <button className="btn" onClick={async () => { await api("/api/schedules", { method: "POST", body: JSON.stringify({ ...schedule, weekday: schedule.weekday === "" ? null : Number(schedule.weekday), probability: Number(schedule.probability) }) }); notify("日程模板已保存"); setSchedule({ ...schedule, title: "", details: "" }); reload(); }}>保存模板</button>
      </article>
    </section>
    <section className="grid two">
      <article className="card"><h2>共享世界设定</h2><p className="muted">新事实先进入待审核；冲突事实不会直接覆盖当前设定。</p>
        {lore.items.slice(0, 30).map((item: any) => <div className="row" key={item.id}><span>[{item.scope}] {item.subject} · {item.predicate} = {item.object}</span>{item.status === "proposed" ? <span className="actions"><button className="btn ghost" onClick={async () => { await api("/api/world/lore/review", { method: "POST", body: JSON.stringify({ id: item.id, accept: true }) }); notify("世界事实已确认"); reload(); }}>确认</button><button className="btn danger" onClick={async () => { await api("/api/world/lore/review", { method: "POST", body: JSON.stringify({ id: item.id, accept: false }) }); notify("提案已拒绝"); reload(); }}>拒绝</button></span> : <b>{item.status}</b>}</div>)}
      </article>
      <article className="card"><h2>提出世界事实</h2>
        <div className="field"><label>范围</label><select value={fact.scope} onChange={(event) => setFact({ ...fact, scope: event.target.value })}><option value="global">global</option><option value="character">character</option><option value="location">location</option><option value="organization">organization</option><option value="npc">npc</option></select></div>
        <div className="field"><label>主体</label><input value={fact.subject} onChange={(event) => setFact({ ...fact, subject: event.target.value })} /></div>
        <div className="field"><label>属性</label><input value={fact.predicate} onChange={(event) => setFact({ ...fact, predicate: event.target.value })} /></div>
        <div className="field"><label>值</label><textarea value={fact.object} onChange={(event) => setFact({ ...fact, object: event.target.value })} /></div>
        <button className="btn" onClick={async () => { const result = await api<any>("/api/world/lore", { method: "POST", body: JSON.stringify(fact) }); notify(result.conflict_with ? "发现冲突，已进入审核" : "世界事实提案已保存"); setFact({ ...fact, subject: "", predicate: "", object: "" }); reload(); }}>保存提案</button>
      </article>
    </section>
    </section>
  );
}

function Stories({ notify, tick, reload }: Props) {
  const { data, error } = useData(() => api<any>("/api/stories"), [tick]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取目标…</p>;
  return (
    <section className="grid two">
      <article className="card">
        {data.goals.map((goal: any) => (
          <div key={goal.id}>
            <div className="row"><b>{goal.title}</b><span className="pill">{goal.status} · {goal.progress}%</span></div>
            <div className="bar"><i style={{ width: `${goal.progress}%` }} /></div>
            <p className="muted">{goal.description}</p>
            <p>阶段：{goal.stage} · 下一步：{goal.next_action || "尚未安排"}</p>
            {goal.obstacle ? <p className="muted">当前障碍：{goal.obstacle}</p> : null}
            {goal.milestones?.length ? <details><summary>计划步骤</summary><ol>{goal.milestones.map((text:string,index:number)=><li key={index}>{text}</li>)}</ol></details> : null}
            {goal.events?.length ? <details><summary>故事记录</summary>{goal.events.map((item:any)=><p className="muted" key={item.id}>{item.event_date} · {item.summary}</p>)}</details> : null}
          </div>
        ))}
      </article>
      <form className="card" onSubmit={async (event) => { event.preventDefault(); await api("/api/goals", { method: "POST", body: JSON.stringify({ title, description }) }); setTitle(""); setDescription(""); notify("目标已添加"); reload(); }}>
        <h2>新目标</h2>
        <div className="field"><label>名称</label><input value={title} onChange={(event) => setTitle(event.target.value)} required /></div>
        <div className="field"><label>说明</label><textarea value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        <button className="btn" type="submit">添加</button>
      </form>
    </section>
  );
}

function Npcs({ notify, tick, reload }: Props) {
  const { data, error } = useData(() => api<any>("/api/npcs"), [tick]);
  const [form, setForm] = useState({ name: "", profile: "", relationship: "friend" });
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取人物…</p>;
  return (
    <section className="grid two">
      <article className="card">
        <table><thead><tr><th>姓名</th><th>关系</th><th>档案</th></tr></thead><tbody>
          {data.npcs.map((npc: any) => <tr key={npc.id}><td>{npc.name}</td><td>{npc.relationship}</td><td>{npc.profile}</td></tr>)}
        </tbody></table>
      </article>
      <form className="card" onSubmit={async (event) => { event.preventDefault(); await api("/api/npcs", { method: "POST", body: JSON.stringify(form) }); notify("人物已保存"); reload(); }}>
        <h2>人物</h2>
        <div className="field"><label>姓名</label><input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required /></div>
        <div className="field"><label>档案</label><textarea value={form.profile} onChange={(event) => setForm({ ...form, profile: event.target.value })} /></div>
        <div className="field"><label>关系</label><input value={form.relationship} onChange={(event) => setForm({ ...form, relationship: event.target.value })} /></div>
        <button className="btn" type="submit">保存</button>
      </form>
    </section>
  );
}

function Proactive({ notify }: Props) {
  const { data, error } = useData(() => api<any>("/api/users"), []);
  const [userId, setUserId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [start, setStart] = useState("22:00");
  const [end, setEnd] = useState("08:00");
  const [preview, setPreview] = useState("");
  useEffect(() => { if (data?.users?.[0] && !userId) setUserId(data.users[0].id); }, [data, userId]);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取授权…</p>;
  return (
    <section className="card">
      <p className="notice warn">新用户默认关闭主动消息。渠道不支持时，系统不会把投递记成成功。</p>
      <div className="field"><label>用户</label><select value={userId} onChange={(event) => setUserId(event.target.value)}>{data.users.map((user: any) => <option key={user.id} value={user.id}>{user.display_name}</option>)}</select></div>
      <label><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> 已明确授权</label>
      <div className="actions"><input type="time" value={start} onChange={(event) => setStart(event.target.value)} /><input type="time" value={end} onChange={(event) => setEnd(event.target.value)} /></div>
      <div className="actions">
        <button className="btn" onClick={async () => { await api("/api/proactive/settings", { method: "POST", body: JSON.stringify({ user_id: userId, enabled, quiet_start: start, quiet_end: end }) }); notify("授权已保存"); }}>保存</button>
        <button className="btn ghost" onClick={async () => { const result = await api<any>("/api/proactive/preview", { method: "POST", body: JSON.stringify({ user_id: userId }) }); setPreview(`${result.allowed ? "允许" : "禁止"}：${result.reason}`); }}>预览</button>
      </div>
      <p>{preview}</p>
    </section>
  );
}

function Operations({ notify, tick, reload }: Props) {
  const { data, error } = useData(() => Promise.all([api<any>("/api/jobs"), api<any>("/api/outbox"), api<any>("/api/commitments"), api<any>("/api/memory/candidates"), api<any>("/api/external-events"), api<any>("/api/operations/health")]), [tick]);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取队列…</p>;
  const [jobs, outbox, commitments, candidates, external, health] = data;
  return (
    <div className="grid">
      <section className="grid stats">
        <Stat label="模型" value={health.model.provider} />
        <Stat label="Worker" value={health.workers.length ? health.workers[0].effective_status : "未启动"} />
        <Stat label="待处理任务" value={health.jobs.pending ?? 0} />
        <Stat label="待投递" value={health.outbox.pending ?? 0} />
      </section>
      {health.workers.map((worker: any) => <section className="card" key={worker.worker_id}><div className="row"><span>{worker.worker_id} · 最近心跳 {worker.last_seen_at}（{worker.age_seconds}s 前）</span><b>{worker.effective_status}</b></div><p className="muted">最近任务：{worker.last_job_kind || "无"} #{worker.last_job_id || "-"}{worker.last_error ? ` · ${worker.last_error}` : ""}</p></section>)}
      <div className="actions"><button className="btn" onClick={async () => { const result = await api<any>("/api/jobs/run-once", { method: "POST", body: "{}" }); notify(result.result ? "已执行一项任务" : "没有到期任务"); reload(); }}>执行下一项</button></div>
      <section className="grid two">
        <article className="card"><h2>任务</h2><Mini rows={(jobs.jobs ?? []).slice(0, 12).map((job: any) => `${job.id} ${job.kind} ${job.status}`)} /></article>
        <article className="card"><h2>Outbox</h2><Mini rows={(outbox.items ?? []).slice(0, 12).map((item: any) => `${item.user_id} ${item.channel} ${item.status}`)} /></article>
      </section>
      <section className="grid two">
        <article className="card"><h2>承诺</h2><Mini rows={(commitments.items ?? []).slice(0, 12).map((item: any) => `#${item.id} ${item.title} ${item.status}`)} /></article>
        <article className="card"><h2>记忆候选</h2>
            {(candidates.items ?? []).slice(0, 8).map((item: any) => <div className="row" key={item.id}><span>{item.text}</span>{item.status === "pending" ? <span className="actions"><button className="btn ghost" onClick={async () => { await api("/api/memory/candidates/review", { method: "POST", body: JSON.stringify({ id: item.id, accept: true }) }); notify("已接受"); reload(); }}>接受</button><button className="btn danger" onClick={async () => { await api("/api/memory/candidates/review", { method: "POST", body: JSON.stringify({ id: item.id, accept: false }) }); notify("已拒绝"); reload(); }}>拒绝</button></span> : <b>{item.status}</b>}</div>)}
        </article>
      </section>
      <section className="card"><h2>外部应用事件审核</h2><p className="muted">外部事件不会自动进入共享世界；只能拒绝、转为所属用户的私有记忆候选或私有日程。</p>
        {(external.items ?? []).slice(0, 20).map((item: any) => <div className="row" key={item.id}><span>#{item.id} {item.source} · {item.event_type} · {item.status}</span>{item.status === "received" ? <span className="actions">{[["private_memory", "私有记忆"], ["private_world", "私有日程"], ["reject", "拒绝"]].map(([decision, label]) => <button key={decision} className={decision === "reject" ? "btn danger" : "btn ghost"} onClick={async () => { await api("/api/external-events/review", { method: "POST", body: JSON.stringify({ id: item.id, decision }) }); notify(`已处理为${label}`); reload(); }}>{label}</button>)}</span> : <b>{item.status}</b>}</div>)}
      </section>
    </div>
  );
}

function Traces() {
  const { data, error } = useData(() => api<any>("/api/traces"), []);
  const [detail, setDetail] = useState<any>(null);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取追踪…</p>;
  return (
    <section className="card">
      <table><thead><tr><th>时间</th><th>用户</th><th>模型</th><th>决策</th><th>耗时</th><th></th></tr></thead><tbody>
        {data.traces.map((trace: any) => <tr key={trace.id}><td>{trace.created_at}</td><td>{trace.user_id}</td><td>{trace.provider}</td><td>{trace.decision}</td><td>{trace.duration_ms} ms</td><td><button className="btn ghost" onClick={async () => setDetail((await api<any>(`/api/traces/detail?id=${encodeURIComponent(trace.id)}`)).trace)}>详情</button></td></tr>)}
      </tbody></table>
      {detail ? <div className="grid two"><pre className="json">{detail.prompt}</pre><pre className="json">{detail.response}</pre></div> : null}
    </section>
  );
}

function Prompts({ notify, tick, reload }: Props) {
  const { data, error } = useData(() => api<any>("/api/prompts"), [tick]);
  const [modules, setModules] = useState<Record<string, string>>({});
  const [name, setName] = useState("行为约束修订");
  useEffect(() => { if (data?.active?.moduleText) setModules(data.active.moduleText); }, [data]);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取 Prompt…</p>;
  return (
    <section className="card">
      <p className="muted">当前发布 #{data.active.version} {data.active.name}。对话编译用的是这里的模块，不是另一份闲置草稿。</p>
      <div className="field"><label>草稿名称</label><input value={name} onChange={(event) => setName(event.target.value)} /></div>
      {Object.entries(modules).map(([key, value]) => (
        <div className="field" key={key}><label>{key}</label><textarea value={value} onChange={(event) => setModules({ ...modules, [key]: event.target.value })} /></div>
      ))}
      <div className="actions">
        <button className="btn ghost" onClick={async () => { const created = await api<any>("/api/prompts", { method: "POST", body: JSON.stringify({ name, modules }) }); notify(`草稿 #${created.version} 已保存`); reload(); }}>保存草稿</button>
        <button className="btn" onClick={async () => { const created = await api<any>("/api/prompts", { method: "POST", body: JSON.stringify({ name, modules }) }); await api("/api/prompts/publish", { method: "POST", body: JSON.stringify({ version: created.version }) }); notify("已发布"); reload(); }}>保存并发布</button>
      </div>
    </section>
  );
}

function Evaluate({ notify }: Props) {
  const [message, setMessage] = useState("你昨天不是说今天去拍照吗？后来怎么样了？");
  const [candidate, setCandidate] = useState("你是林知夏。用自然简洁的口语回应，不使用旁白。没有被确认的经历就坦诚说明。");
  const [result, setResult] = useState<any>(null);
  const [report, setReport] = useState("");
  return (
    <section className="grid two">
      <article className="card">
        <h2>同一输入对照</h2>
        <div className="field"><label>测试话术</label><textarea value={message} onChange={(event) => setMessage(event.target.value)} /></div>
        <div className="field"><label>候选约束</label><textarea value={candidate} onChange={(event) => setCandidate(event.target.value)} /></div>
        <div className="actions">
          <button className="btn" onClick={async () => { try { setResult(await api("/api/evaluate/compare", { method: "POST", body: JSON.stringify({ message, candidate }) })); } catch (caught) { notify(caught instanceof Error ? caught.message : "对照失败"); } }}>运行对照</button>
          <button className="btn ghost" onClick={async () => { const response = await api<any>("/api/evaluate/long-run", { method: "POST", body: JSON.stringify({ days: 7 }) }); setReport(`${response.passed ? "通过" : "失败"}\n${Object.entries(response.checks).map(([key, value]) => `${value ? "通过" : "失败"} ${key}`).join("\n")}`); }}>7 天三用户回归</button>
        </div>
      </article>
      <article className="card">
        <h2>输出</h2>
        <p className="muted">当前版本</p><pre className="json">{result ? result.active : "等待运行"}</pre>
        <p className="muted">候选</p><pre className="json">{result ? result.candidate : "等待运行"}</pre>
        <pre className="json">{report || "长周期回归尚未运行"}</pre>
      </article>
    </section>
  );
}

function Channels({ tick }: Props) {
  const { data, error } = useData(() => Promise.all([api<any>("/api/channels"), api<any>("/api/settings")]), [tick]);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取渠道…</p>;
  const [channels, settings] = data;
  return (
    <section className="card">
      {channels.channels.map((channel: any) => <div className="row" key={channel.channel}><span>{channel.channel}</span><b>{channel.enabled ? "已启用" : "已关闭"} · {channel.mode}</b></div>)}
      <div className="row"><span>模型</span><b>{settings.provider} / {settings.model}</b></div>
      <p className="notice warn">QQ 只做协议转换，调用集成接口。它不打开数据库，也不能把不支持的主动推送记成成功。</p>
    </section>
  );
}

function Settings() {
  const { data, error } = useData(() => api<any>("/api/settings"), []);
  if (error) return <p className="notice">{error}</p>;
  if (!data) return <p className="muted">正在读取配置…</p>;
  return (
    <section className="card">
      <div className="row"><span>时区</span><b>{data.timezone}</b></div>
      <div className="row"><span>模型</span><b>{data.model}</b></div>
      <div className="row"><span>提供方</span><b>{data.provider}</b></div>
      <div className="row"><span>主动消息</span><b>{data.proactive_requires_opt_in ? "必须授权" : "默认开启"}</b></div>
      <div className="row"><span>全局沉浸模式</span><b>{data.immersive_mode ? "已开启" : "已关闭"}</b></div>
      <div className="row"><span>数据库</span><b>SQLite · schema {String(data.schema_version)}</b></div>
      <div className="row"><span>健康检查</span><a href="/api/health">/api/health</a></div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <article className="card stat"><div className="label">{label}</div><div className="value">{value}</div></article>;
}

function EventList({ events }: { events: Array<{ id: number; start_time?: string; end_time?: string; title: string; status: string; details?: string }> }) {
  if (!events?.length) return <p className="empty">这一天还没有事件。</p>;
  return events.map((event) => (
    <div className="event" key={event.id}><time>{event.start_time || "待定"}{event.end_time ? `–${event.end_time}` : ""}</time><div><b>{event.title}</b> <span className="pill">{event.status}</span><div className="muted">{event.details}</div></div></div>
  ));
}

function Mini({ rows }: { rows: string[] }) {
  if (!rows.length) return <p className="empty">空的。</p>;
  return rows.map((row) => <div className="row" key={row}><span>{row}</span></div>);
}
