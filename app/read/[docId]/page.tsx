"use client";

import { useParams } from "next/navigation";
import Reader from "@/components/reader/Reader";

/** 阅读器。文档只存在浏览器 localStorage 里，所以整页在客户端渲染 */
export default function ReadPage() {
  const { docId } = useParams<{ docId: string }>();
  return <Reader docId={docId} />;
}
