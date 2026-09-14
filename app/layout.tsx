import type { Metadata } from "next";
import { Cinzel, JetBrains_Mono } from "next/font/google";
import "../styles/tokens.css";
import "../styles/reader.css";

const cinzel = Cinzel({
  subsets: ["latin"],
  variable: "--font-display",
});

// 目前没有元素使用等宽字，关闭 preload 避免无用下载；
// 第一个用到 --font-mono 的 issue 再打开。
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  preload: false,
});

export const metadata: Metadata = {
  title: "Gloss",
  description: "读难懂的中文哲学书时，点一下句子，就地给出大白话改写。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      data-theme="parchment"
      className={`${cinzel.variable} ${jetbrainsMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
