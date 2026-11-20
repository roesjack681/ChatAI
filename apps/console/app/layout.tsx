import type { Metadata } from "next";
import { BRAND } from "../lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: `${BRAND.name}`,
  description: `${BRAND.name}，固定角色、隔离记忆、共享生活世界的长期陪聊工作台`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
