"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import { ApiError, api, sectionFromPath, sections } from "./api";
import { Panel } from "./panels";
import { BRAND } from "../../lib/brand";

const titles: Record<string, string> = Object.fromEntries(sections);

export function Studio() {
  const pathname = usePathname();
  const section = sectionFromPath(pathname);
  const [ready, setReady] = useState<"loading" | "in" | "out">("loading");
  const [userId, setUserId] = useState("");
  const [toast, setToast] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(()=>{
    const target=new URL(window.location.href).searchParams.get("user_id");
    let saved="";try{saved=window.sessionStorage.getItem("lingzhi:selected-user")??"";}catch{}
    if(target||saved)setUserId((target||saved).slice(0,100));
  },[pathname]);
  function selectUser(id:string){
    setUserId(id);try{window.sessionStorage.setItem("lingzhi:selected-user",id);}catch{}
    if(section==="chat"||section==="memory"){const url=new URL(window.location.href);if(id)url.searchParams.set("user_id",id);else url.searchParams.delete("user_id");window.history.replaceState(window.history.state,"",url);}
  }

  useEffect(() => {
    api("/api/session").then(() => setReady("in")).catch(() => setReady("out"));
  }, []);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2400);
  }

  if (ready === "loading") return <main className="login"><p className="muted">正在确认会话…</p></main>;
  if (ready === "out") return <Login onDone={() => setReady("in")} />;

  return (
    <div className={section === "chat" ? "shell shell-chat" : "shell"}>
      <aside className="side">
        <div className="brand"><span className="mark">{BRAND.mark}</span><div><b>{BRAND.name}</b><small>{BRAND.subtitle}</small></div></div>
        <nav className="nav">
          {sections.map(([id, label]) => (
            <Link key={id} href={id === "home" ? "/" : `/${id}${["memory","chat"].includes(id)&&userId?`?user_id=${encodeURIComponent(userId)}`:""}`} className={section === id ? "active" : ""}>{label}</Link>
          ))}
        </nav>
        <div className="side-foot"><span>Asia/Shanghai</span><button className="btn ghost" onClick={async () => { await api("/api/session", { method: "DELETE" }); setReady("out"); }}>退出</button></div>
      </aside>
      <main className={section === "chat" ? "main main-chat" : "main"}>
        <header className="top">
          <div>
            <div className="eyebrow">固定角色 · 私有记忆 · 共享生活</div>
            <h1>{titles[section]}</h1>
          </div>
        </header>
        <Panel section={section} userId={userId} setUserId={selectUser} notify={notify} tick={tick} reload={() => setTick((value) => value + 1)} />
      </main>
      <div className={toast ? "toast show" : "toast"}>{toast}</div>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/api/session", { method: "POST", body: JSON.stringify({ token }) });
      onDone();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "无法登录");
    }
  }
  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <div className="eyebrow">管理员会话</div>
        <h1>进入{BRAND.name}</h1>
        <p className="muted">令牌只写入 HttpOnly Cookie，页面脚本读不到它。</p>
        <div className="field"><label>管理员令牌</label><input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoFocus /></div>
        {error ? <p className="notice">{error}</p> : null}
        <button className="btn" type="submit">继续</button>
      </form>
    </main>
  );
}
