import { Moon, Sun, SunMoon } from "lucide-react";
import { useEffect, useState } from "react";

type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "solar-theme";
const preferences: ThemePreference[] = ["system", "light", "dark"];

function resolvedTheme(preference: ThemePreference) {
  return preference === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "solar-dark"
      : "solar-light"
    : `solar-${preference}`;
}

function applyTheme(preference: ThemePreference) {
  document.documentElement.dataset.theme = resolvedTheme(preference);
}

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });

  useEffect(() => {
    applyTheme(preference);
    localStorage.setItem(STORAGE_KEY, preference);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => preference === "system" && applyTheme(preference);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [preference]);

  const next = () => setPreference((current) => preferences[(preferences.indexOf(current) + 1) % preferences.length]!);
  const Icon = preference === "light" ? Sun : preference === "dark" ? Moon : SunMoon;

  return <button className="btn btn-ghost btn-sm btn-circle" onClick={next} title={`Theme: ${preference}. Change theme.`}><Icon size={18} /></button>;
}
