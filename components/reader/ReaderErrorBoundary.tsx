"use client";

import Link from "next/link";
import { Component, type ReactNode } from "react";
import Notice from "@/components/Notice";

export default class ReaderErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    if (process.env.NODE_ENV === "development") console.error("[Gloss] 阅读页出错", error);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <main className="reader-status reader-error-fallback">
          <Notice tone="block" message="阅读页出错了，这份文档暂时打不开。" />
          <Link href="/" className="reader-back">← 回到书架</Link>
        </main>
      );
    }
    return this.props.children;
  }
}
