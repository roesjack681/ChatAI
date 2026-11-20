"use client";

import {useEffect,useState} from "react";
import {api} from "./api";

interface MemoryUser {id:string;display_name:string}
interface MemoryItem {id:number;text:string;display_text?:string;kind:string;status:string;created_at:string;access_count?:number}
interface Evidence {key:string;kind:string;id:number;text:string;created_at:string}
interface Overview {
  user:MemoryUser;groups:Array<{label:string;items:MemoryItem[]}>;memories:MemoryItem[];
  candidates:Array<{id:number;text:string;confidence:number;reason:string}>;
  portrait:{status:"empty"|"ready"|"stale"|"invalidated";summary:string|null;summary_evidence_keys:string[];traits:Array<{label:string;value:string;basis:"explicit"|"observed";evidence_keys:string[]}>;sources:Evidence[];updated_at:string|null};
  stats:{active:number;history:number;pending:number;messages:number;unprocessed:number;failed_extractions:number;portrait_pending:boolean;portrait_sources:number};
  relationship:{stage:string;interactions:number;closeness:number;trust:number};
  relationship_events:Array<{id:number;reason:string;closeness_delta:number;trust_delta:number}>;
}
interface Props {userId:string;setUserId:(id:string)=>void;notify:(message:string)=>void;tick:number;reload:()=>void}
const time=(value:string|null)=>value?new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"";
const userLabel=(user:MemoryUser)=>user.display_name===user.id?"聊天":user.display_name;
const stages:Record<string,string>={new:"刚认识",acquaintance:"已认识",familiar:"熟悉",close:"亲近"};
const reasons:Record<string,string>={ordinary_interaction:"普通交流",positive_connection:"积极互动",negative_interaction:"不愉快的互动",personal_disclosure:"分享心事",boundary_stated:"表达交流边界"};

export function MemoryPanel({userId,setUserId,notify,tick,reload}:Props){
  const [users,setUsers]=useState<MemoryUser[]|null>(null);const [error,setError]=useState("");
  useEffect(()=>{let live=true;api<{users:MemoryUser[]}>("/api/users").then(value=>{if(live){setUsers(value.users);setError("");}}).catch((caught:Error)=>{if(live)setError(caught.message);});return()=>{live=false;};},[tick]);
  useEffect(()=>{if(users?.length&&!userId)setUserId(users[0].id);},[users,userId,setUserId]);
  const selected=users?.find(item=>item.id===userId);
  return <section className="grid"><article className="card"><div className="row"><h2>用户记忆与特征总结</h2><button className="btn ghost" onClick={reload}>刷新</button></div><div className="field"><label htmlFor="memory-user">查看用户</label><select id="memory-user" value={userId} onChange={event=>setUserId(event.target.value)}><option value="">请选择用户</option>{userId&&!selected?<option value={userId}>{users?"此用户已不存在":"正在读取用户…"}</option>:null}{users?.map(user=><option key={user.id} value={user.id}>{userLabel(user)} · {user.id.slice(-8)}</option>)}</select></div><p className="muted">每段聊天的用户独立保存记忆。也可以从聊天顶部的“记忆与画像”查看当前聊天。</p>{error?<p className="notice" role="alert">{error}</p>:null}{users&&!users.length?<p className="empty">还没有用户，先创建一段聊天。</p>:null}</article>{selected?<UserMemoryView key={userId} userId={userId} refreshKey={tick} notify={notify}/>:users?.length?<p className="notice">请选择要查看的用户。</p>:null}</section>;
}

export function UserMemoryView({userId,refreshKey=0,notify,compact=false}:{userId:string;refreshKey?:number;notify:(text:string)=>void;compact?:boolean}){
  const [view,setView]=useState<{id:string;data:Overview}|null>(null);const [error,setError]=useState("");const [revision,setRevision]=useState(0);
  const [generating,setGenerating]=useState(false);const [acting,setActing]=useState(false);const [text,setText]=useState("");
  useEffect(()=>{
    let live=true,sequence=0;
    async function load(){const request=++sequence;try{const data=await api<Overview>(`/api/memory/overview?user_id=${encodeURIComponent(userId)}`);if(data.user.id!==userId)throw new Error("用户数据不匹配");if(live&&request===sequence){setView({id:userId,data});setError("");}}catch(caught){if(live&&request===sequence)setError(caught instanceof Error?caught.message:"读取失败");}}
    if(userId)void load();const timer=window.setInterval(()=>{if(document.visibilityState==="visible"&&userId)void load();},15000);
    return()=>{live=false;window.clearInterval(timer);};
  },[userId,refreshKey,revision]);
  const data=view?.id===userId?view.data:null;
  async function mutate(path:string,body:unknown){setActing(true);try{await api(path,{method:"POST",body:JSON.stringify(body)});setRevision(value=>value+1);setError("");return true;}catch(caught){setError(caught instanceof Error?caught.message:"操作失败");return false;}finally{setActing(false);}}
  async function summarize(){setGenerating(true);try{const updated=await api<Overview>("/api/memory/portrait",{method:"POST",body:JSON.stringify({user_id:userId})});setView({id:userId,data:updated});setRevision(value=>value+1);setError("");notify("特征总结已更新，可以展开查看依据");}catch(caught){setError(caught instanceof Error?caught.message:"生成失败");}finally{setGenerating(false);}}
  const evidence=(keys:string[])=>{const sources=data?.portrait.sources.filter(source=>keys.includes(source.key))??[];return sources.length?<details className="memory-evidence"><summary>查看 {sources.length} 条依据</summary>{sources.map(source=><blockquote key={source.key}><small>{source.kind==="memory"?"已确认记忆":"用户原话"} · {time(source.created_at)}</small><p>{source.text}</p></blockquote>)}</details>:null;};
  if(!data)return <div className="card">{error?<p className="notice" role="alert">{error}<button className="btn ghost" onClick={()=>setRevision(value=>value+1)}>重试</button></p>:<p className="muted">正在读取该用户的记忆…</p>}</div>;
  const {portrait,stats,relationship}=data;
  return <div className={`memory-view${compact?" memory-compact":""}`}>
    {error?<p className="notice" role="alert">{error}</p>:null}
    <article className="card"><h2>{userLabel(data.user)} · 记忆与画像</h2><p className="muted memory-owner">用户：{data.user.id}</p><div className="memory-stats"><div><b>{stats.active}</b><span>已确认记忆</span></div><div><b>{stats.pending}</b><span>待确认内容</span></div><div><b>{stats.messages}</b><span>用户消息</span></div><div><b>{relationship.interactions}</b><span>互动次数</span></div></div><p className="muted">{stages[relationship.stage]??relationship.stage} · 亲近 {relationship.closeness} · 信任 {relationship.trust}</p>{stats.unprocessed||stats.failed_extractions?<p className="muted">{stats.unprocessed?`${stats.unprocessed} 条新消息等待后台整理。`:""}{stats.failed_extractions?`${stats.failed_extractions} 条消息整理失败。`:""}特征总结也可直接依据现有原话生成。</p>:null}{stats.portrait_pending?<p className="muted">特征总结已排入后台更新，完成后会自动显示。</p>:null}</article>
    <article className="card"><div className="row"><h2>特征总结</h2><button className="btn" disabled={generating||!stats.portrait_sources} onClick={()=>void summarize()}>{generating?"正在整理…":portrait.summary?"更新总结":"生成总结"}</button></div><p className="muted">明确自述与对话观察分开显示，每条都可查看依据；这份总结不会自动写成长期事实。</p>{portrait.status==="stale"?<p className="notice">有新的对话或记忆，当前显示上次总结，可点击更新。</p>:null}{portrait.status==="invalidated"?<p className="notice">原依据已被删除或更正，旧总结已隐藏，请重新生成。</p>:null}{portrait.summary?<><p className="memory-summary">{portrait.summary}</p>{evidence(portrait.summary_evidence_keys)}<div className="memory-traits">{portrait.traits.map((trait,index)=><div className="memory-trait" key={`${trait.label}-${index}`}><div className="row"><b>{trait.label}</b><span className="memory-tag">{trait.basis==="explicit"?"明确自述 / 已确认":"本段对话观察"}</span></div><p>{trait.value}</p>{evidence(trait.evidence_keys)}</div>)}</div><p className="muted">更新于 {time(portrait.updated_at)} · 北京时间</p></>:<p className="empty">{stats.portrait_sources?"当前还没有有效的特征总结，点击生成即可根据这位用户的记忆与原话整理。":"当前还没有可供总结的内容，先聊几句。"}</p>}</article>
    <article className="card"><h2>已记住的你</h2>{data.groups.length?data.groups.map(group=><section className="memory-group" key={group.label}><h3>{group.label}</h3>{group.items.map(item=><div className="memory-item" key={item.id}><div><p>{item.display_text??item.text}</p><small className="muted">{time(item.created_at)} · 被对话使用 {item.access_count??0} 次</small></div><button className="btn ghost" disabled={acting} onClick={()=>void mutate("/api/memories/delete",{user_id:userId,id:item.id})}>删除</button></div>)}</section>):<p className="empty">当前用户还没有已确认的长期记忆。普通提问和试探不会直接当作个人事实。</p>}{stats.history?<details><summary>历史与已替代记忆 · {stats.history} 条</summary>{data.memories.filter(item=>item.status!=="active").map(item=><div className="memory-item" key={item.id}><p>{item.text}</p><span className="muted">已被替代</span></div>)}</details>:null}</article>
    <article className="card"><h2>待确认内容 · {stats.pending}</h2>{data.candidates.length?data.candidates.map(item=><div className="memory-candidate" key={item.id}><p>{item.text}</p><p className="muted">置信度 {Math.round(item.confidence*100)}% · {item.reason}</p><div className="actions"><button className="btn" disabled={acting} onClick={()=>void mutate("/api/memory/candidates/review",{id:item.id,accept:true})}>确认记忆</button><button className="btn ghost" disabled={acting} onClick={()=>void mutate("/api/memory/candidates/review",{id:item.id,accept:false})}>不记住</button></div></div>):<p className="empty">暂无待确认内容。</p>}</article>
    {!compact?<><article className="card"><h2>最近的关系变化</h2>{data.relationship_events.length?data.relationship_events.map(item=><div className="row" key={item.id}><span>{item.reason.split(",").map(reason=>reasons[reason]??reason).join("、")}</span><small>亲近 {item.closeness_delta>0?"+":""}{item.closeness_delta} · 信任 {item.trust_delta>0?"+":""}{item.trust_delta}</small></div>):<p className="empty">暂无关系变化记录。</p>}</article><form className="card" onSubmit={async event=>{event.preventDefault();if(await mutate("/api/memories",{user_id:userId,text}))setText("");}}><h2>新增记忆</h2><div className="field"><label htmlFor="manual-memory">补充明确的信息</label><textarea id="manual-memory" value={text} maxLength={500} onChange={event=>setText(event.target.value)} required/></div><button className="btn" type="submit" disabled={acting||!text.trim()}>保存到当前用户</button></form></>:null}
  </div>;
}
