"use client";

import { useEffect } from "react";
import { startReaderThemeSync } from "@/lib/reader-theme";

export default function ThemeController() {
  useEffect(startReaderThemeSync, []);
  return null;
}
