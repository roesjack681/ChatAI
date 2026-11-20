"use client";

import { type FormEvent, useEffect, useRef, useState } from "react";

import { api } from "./api";
import {UserMemoryView} from "./memory";
import { IMAGE_ACCEPT, MAX_CHAT_IMAGES, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGE_BYTES, type ChatImage, type ChatImageInput } from "@shared/images";

interface Conversation {
  id: string;
  display_name: string;
  preview: string | null;
  message_count: number;
}

interface Message { role: string; content: string; images?: ChatImage[] }
interface DraftImage extends ChatImageInput { id: string; size: number }
interface Trace { decision: string; provider: string; memory_count: number; duration_ms: number; trace_id: string }
interface Props {
  userId: string;
  setUserId: (id: string) => void;
  notify: (message: string) => void;
  tick: number;
  reload: () => void;
}

export function Chat({ userId, setUserId, notify, tick, reload }: Props) {
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [history, setHistory] = useState<{ id: string; messages: Message[] } | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [listError, setListError] = useState("");
  const [draft, setDraft] = useState("");
  const [outgoing, setOutgoing] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const [outgoingImages, setOutgoingImages] = useState<DraftImage[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [imagePreview, setImagePreview] = useState<{ url: string; name: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [name, setName] = useState("");
  const [search, setSearch] = useState("");
  const [showConversations, setShowConversations] = useState(false);
  const [showMemory,setShowMemory]=useState(false);
  const [confirm, setConfirm] = useState<{ id: string; name: string; remove: boolean } | null>(null);
  const sending = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imageDialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const memoryDialogRef=useRef<HTMLDialogElement>(null);
  const readingRef = useRef(false);
  const dragDepth = useRef(0);
  const currentUser = useRef(userId);
  currentUser.current = userId;
  useEffect(()=>{const dialog=memoryDialogRef.current;if(showMemory&&!dialog?.open)dialog?.showModal();else if(!showMemory&&dialog?.open)dialog.close();},[showMemory]);
  const selected = conversations?.find((item) => item.id === userId);
  const messages = history?.id === userId ? history.messages : [];
  const loading = Boolean(selected && history?.id !== userId && !historyError);

  useEffect(() => {
    let live = true;
    api<{ conversations: Conversation[] }>("/api/chat/conversations").then((result) => {
      if (live) { setConversations(result.conversations); setListError(""); }
    }).catch((error: Error) => { if (live) setListError(error.message); });
    return () => { live = false; };
  }, [tick]);

  useEffect(() => {
    if (conversations && !conversations.some((item) => item.id === userId)) {
      setUserId(conversations[0]?.id ?? "");
    }
  }, [conversations, userId, setUserId]);

  useEffect(() => {
    setDraft(""); setDraftImages([]); setTrace(null); setHistoryError(""); setImagePreview(null);
  }, [userId]);

  useEffect(() => {
    let live = true;
    if (!selected) return;
    api<{ messages: Message[] }>(`/api/chat/history?user_id=${encodeURIComponent(userId)}`).then((result) => {
      if (live) { setHistory({ id: userId, messages: result.messages }); setHistoryError(""); }
    }).catch((error: Error) => { if (live) setHistoryError(error.message); });
    return () => { live = false; };
  }, [userId, Boolean(selected), tick]);

  useEffect(() => {
    const pane = messagesRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [history, outgoing, outgoingImages, userId]);

  useEffect(() => {
    if (confirm) dialogRef.current?.showModal();
    else dialogRef.current?.close();
  }, [confirm]);

  useEffect(() => {
    if (imagePreview) imageDialogRef.current?.showModal();
    else imageDialogRef.current?.close();
  }, [imagePreview]);

  useEffect(() => {
    if (!pending && !busy && selected) inputRef.current?.focus();
  }, [pending, busy, userId, Boolean(selected)]);

  async function addImages(files: File[]) {
    if (!files.length || !selected || pending || busy || readingRef.current || loading) return;
    if (draftImages.length + files.length > MAX_CHAT_IMAGES) { notify(`每条消息最多 ${MAX_CHAT_IMAGES} 张图片`); return; }
    if (files.some((file) => !IMAGE_ACCEPT.split(",").includes(file.type))) { notify("请选择 JPEG、PNG、WebP 或 GIF 图片"); return; }
    if (files.some((file) => file.size > MAX_IMAGE_BYTES)) { notify("单张图片不能超过 5 MB"); return; }
    if ([...draftImages, ...files].reduce((total, image) => total + image.size, 0) > MAX_MESSAGE_IMAGE_BYTES) { notify("图片总大小不能超过 12 MB"); return; }
    readingRef.current = true; setReadingImages(true);
    const owner = userId;
    try {
      const added = await Promise.all(files.map((file) => new Promise<DraftImage>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name || "粘贴的图片", size: file.size, data_url: String(reader.result) });
        reader.onerror = () => reject(new Error(`无法读取图片：${file.name}`));
        reader.onabort = () => reject(new Error("读取图片已取消"));
        reader.readAsDataURL(file);
      })));
      if (currentUser.current === owner) setDraftImages((items) => [...items, ...added]);
    } catch (error) { notify(error instanceof Error ? error.message : "无法读取图片"); }
    finally { readingRef.current = false; setReadingImages(false); }
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const message = draft.trim();
    if ((!message && !draftImages.length) || !selected || sending.current || busy || loading || historyError || readingRef.current) return;
    const attached = draftImages;
    sending.current = true;
    setDraft(""); setDraftImages([]); setOutgoing(message); setOutgoingImages(attached); setPending(true);
    try {
      const result = await api<Trace & { reply: string; images: ChatImage[] }>("/api/chat", {
        method: "POST", body: JSON.stringify({ user_id: userId, display_name: selected.display_name, message, images: attached.map(({ name, data_url }) => ({ name, data_url })) }),
      });
      setTrace(result);
      setHistory({ id: userId, messages: [...messages, { role: "user", content: message, images: result.images }, { role: "assistant", content: result.reply }] });
      reload();
    } catch (error) {
      setDraft(message);
      setDraftImages(attached);
      notify(error instanceof Error ? error.message : "发送失败，请重试");
      reload();
    } finally {
      sending.current = false;
      setOutgoing(""); setOutgoingImages([]); setPending(false);
      inputRef.current?.focus();
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || pending) return;
    setBusy(true);
    try {
      const result = await api<{ conversation: Conversation }>("/api/chat/conversations", {
        method: "POST", body: JSON.stringify({ name: name.trim() || `聊天 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}` }),
      });
      setConversations((items) => [{ ...result.conversation, preview: null, message_count: 0 }, ...(items ?? [])]);
      setHistory({ id: result.conversation.id, messages: [] });
      setUserId(result.conversation.id);
      setShowConversations(false);
      setName(""); setSearch("");
      reload();
    } catch (error) { notify(error instanceof Error ? error.message : "创建失败"); }
    finally { setBusy(false); }
  }

  async function erase() {
    if (!confirm || busy || pending) return;
    setBusy(true);
    try {
      await api(`/api/chat/${confirm.remove ? "conversations" : "history"}?user_id=${encodeURIComponent(confirm.id)}`, { method: "DELETE" });
      if (confirm.remove) {
        const remaining = (conversations ?? []).filter((item) => item.id !== confirm.id);
        setConversations(remaining);
        if (userId === confirm.id) setUserId(remaining[0]?.id ?? "");
      } else {
        setHistory({ id: confirm.id, messages: [] });
        setConversations((items) => items?.map((item) => item.id === confirm.id ? { ...item, preview: null, message_count: 0 } : item) ?? null);
      }
      setTrace(null); setConfirm(null);
      notify(confirm.remove ? "聊天已删除" : "消息已清空");
      reload();
    } catch (error) { notify(error instanceof Error ? error.message : "删除失败，请重试"); }
    finally { setBusy(false); }
  }

  const filtered = conversations?.filter((item) => item.display_name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return (
    <div className={showConversations ? "chat show-conversations" : "chat"}>
      <aside className="card chat-sidebar" aria-label="聊天记录">
        <div className="chat-list-heading"><h2>聊天记录 <span className="pill">{conversations?.length ?? 0}</span></h2><button className="btn ghost chat-list-toggle" onClick={() => setShowConversations(false)}>返回聊天</button></div>
        <input className="chat-search" aria-label="搜索聊天" placeholder="搜索聊天" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="conversation-list">
          {listError ? <p role="alert" className="notice">{listError}<button className="btn ghost" onClick={reload}>重试</button></p> : null}
          {!conversations && !listError ? <p className="empty">正在读取聊天…</p> : null}
          {filtered?.map((item) => (
            <div className={`conversation${item.id === userId ? " active" : ""}`} key={item.id}>
              <button className="conversation-select" disabled={pending || busy || readingImages} aria-current={item.id === userId ? "true" : undefined} onClick={() => { setUserId(item.id); setShowConversations(false); }}>
                <b>{item.display_name}</b><span className="muted">{item.preview || "还没有消息"}</span>
              </button>
              <button className="chat-delete" disabled={pending || busy || readingImages} title={`删除聊天：${item.display_name}`} aria-label={`删除聊天：${item.display_name}`} onClick={() => setConfirm({ id: item.id, name: item.display_name, remove: true })}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
              </button>
            </div>
          ))}
          {conversations && !filtered?.length ? <p className="empty">{search ? "没有匹配的聊天" : "还没有聊天，创建一个吧。"}</p> : null}
        </div>
        <form className="new-conversation" onSubmit={create}>
          <input aria-label="聊天名称" placeholder="聊天名称（选填）" value={name} maxLength={80} disabled={busy || pending || readingImages} onChange={(event) => setName(event.target.value)} />
          <button className="btn" disabled={busy || pending || readingImages} type="submit">＋ 新建聊天</button>
        </form>
      </aside>
      <section className={dragging ? "card chat-main image-drop-active" : "card chat-main"} aria-label="聊天内容"
        onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current += 1; setDragging(true); } }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = selected && !pending && !busy ? "copy" : "none"; } }}
        onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void addImages(Array.from(event.dataTransfer.files)); }}>
        <header className="chat-heading">
          <div><h2>{selected?.display_name || "和知夏聊聊"}</h2><span className="muted">{selected ? `${messages.length} 条消息` : "选择左侧聊天，或新建聊天"}</span></div>
          <div className="actions"><button className="btn ghost chat-list-toggle" onClick={() => setShowConversations(true)}>聊天记录</button>{selected?<button className="btn ghost" onClick={()=>setShowMemory(true)}>记忆与画像</button>:null}{selected ? <button className="btn ghost" disabled={pending || busy || !messages.length} onClick={() => setConfirm({ id: userId, name: selected.display_name, remove: false })}>清空消息</button> : null}</div>
        </header>
        <div className="messages" ref={messagesRef} aria-label="消息列表" aria-busy={pending || loading}>
          {historyError ? <p className="notice" role="alert">{historyError} <button className="btn ghost" onClick={reload}>重新加载</button></p> : null}
          {loading ? <p className="empty">正在读取消息…</p> : null}
          {!loading && !historyError && !messages.length && !outgoing && !outgoingImages.length ? <div className="chat-empty"><span className="mark">知</span><h2>{selected ? "说点什么吧" : "从一段新聊天开始"}</h2><p className="muted">{selected ? "可以发文字，也可以发图片。" : "在左侧创建聊天，就可以开始了。"}</p></div> : null}
          {messages.map((message, index) => <div key={`${userId}-${index}`} className={message.role === "user" ? "bubble me" : "bubble"}>
            {message.images?.length ? <div className="bubble-images">{message.images.map((image) => <button className="bubble-image" key={image.id} onClick={() => setImagePreview({ url: image.url, name: image.name })} aria-label={`查看图片：${image.name}`}><img src={image.url} alt={image.name} width={image.width} height={image.height} onLoad={() => { const pane = messagesRef.current; if (pane && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 350) pane.scrollTop = pane.scrollHeight; }} /></button>)}</div> : null}
            {message.content ? <div>{message.content}</div> : null}
          </div>)}
          {outgoing || outgoingImages.length ? <><div className="bubble me">{outgoingImages.length ? <div className="bubble-images">{outgoingImages.map((image) => <img className="outgoing-image" key={image.id} src={image.data_url} alt={image.name} />)}</div> : null}{outgoing}</div><div className="muted typing" role="status">知夏正在回复…</div></> : null}
        </div>
        <form className="composer" onSubmit={send}>
          {draftImages.length ? <div className="draft-images" aria-label="待发送图片">{draftImages.map((image) => <div className="draft-image" key={image.id}><button className="draft-image-open" type="button" aria-label={`预览图片：${image.name}`} onClick={() => setImagePreview({ url: image.data_url, name: image.name })}><img src={image.data_url} alt={image.name} /></button><button className="draft-image-remove" type="button" aria-label={`移除图片：${image.name}`} onClick={() => setDraftImages((items) => items.filter((item) => item.id !== image.id))}>×</button><span title={image.name}>{image.name}</span></div>)}</div> : null}
          <textarea ref={inputRef} aria-label="输入消息" maxLength={4000} disabled={!selected || busy || pending || loading || Boolean(historyError)} value={draft} placeholder={selected ? "发消息给知夏，也可以粘贴图片…" : "请先新建或选择聊天"} onChange={(event) => setDraft(event.target.value)} onPaste={(event) => { const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/")); if (images.length) { event.preventDefault(); void addImages(images); } }} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
          }} />
          <button className="btn" disabled={!selected || (!draft.trim() && !draftImages.length) || pending || busy || readingImages || loading || Boolean(historyError)} type="submit">{pending ? "回复中…" : "发送"}</button>
          <div className="composer-toolbar"><input ref={fileRef} type="file" hidden multiple accept={IMAGE_ACCEPT} aria-label="选择聊天图片" onChange={(event) => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} /><button className="btn ghost image-picker" type="button" disabled={!selected || busy || pending || readingImages || loading || Boolean(historyError)} onClick={() => fileRef.current?.click()}>{readingImages ? "读取中…" : "＋ 图片"}</button><span className="muted">支持粘贴 / 拖入 · 最多 4 张，每张 5 MB</span><span className="composer-hint muted">Enter 发送 · Shift + Enter 换行</span></div>
        </form>
        {trace ? <details className="chat-trace"><summary>本轮详情</summary><div className="trace-values"><span>决策：{trace.decision}</span><span>提供方：{trace.provider}</span><span>记忆：{trace.memory_count}</span><span>耗时：{trace.duration_ms} ms</span></div></details> : null}
      </section>
      <dialog className="memory-dialog" ref={memoryDialogRef} aria-label="当前聊天的记忆与画像" onCancel={()=>setShowMemory(false)}><div className="row"><h2>当前聊天的记忆与画像</h2><button className="btn ghost" onClick={()=>setShowMemory(false)}>关闭</button></div>{showMemory&&selected?<UserMemoryView key={userId} userId={userId} refreshKey={tick} compact notify={notify}/>:null}</dialog>
      <dialog className="chat-confirm" ref={dialogRef} aria-labelledby="chat-confirm-title" onCancel={(event) => { if (busy) event.preventDefault(); else setConfirm(null); }}>
        <h2 id="chat-confirm-title">{confirm?.remove ? "删除这段聊天？" : "清空聊天消息？"}</h2>
        <p className="conversation-name">{confirm?.name}</p>
        <p className="muted">{confirm?.remove ? "消息会被删除，聊天也会从左侧列表移除。" : "删除当前聊天的全部消息，保留左侧聊天入口。"}已形成的长期记忆保留。此操作无法撤销。</p>
        <div className="actions"><button className="btn ghost" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className="btn" disabled={busy} onClick={() => void erase()}>{busy ? "处理中…" : confirm?.remove ? "确认删除" : "确认清空"}</button></div>
      </dialog>
      <dialog className="image-viewer" ref={imageDialogRef} aria-label="图片预览" onCancel={() => setImagePreview(null)} onClick={(event) => { if (event.target === event.currentTarget) setImagePreview(null); }}>
        <button className="btn image-viewer-close" onClick={() => setImagePreview(null)} aria-label="关闭图片预览">关闭 ×</button>
        {imagePreview ? <img src={imagePreview.url} alt={imagePreview.name} /> : null}
      </dialog>
    </div>
  );
}
