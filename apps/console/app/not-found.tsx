import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell">
      <section className="card">
        <h1>页面不存在</h1>
        <p className="muted">这个工作台地址无效，返回首页继续操作。</p>
        <Link className="btn" href="/">返回工作台</Link>
      </section>
    </main>
  );
}
