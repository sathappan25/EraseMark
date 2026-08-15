import type { ThemeSetting } from "../types";

export function applyTheme(theme: ThemeSetting): void {
  const root = document.documentElement;
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  root.classList.toggle("dark", dark);
}

export function watchSystemTheme(theme: ThemeSetting): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (theme === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
