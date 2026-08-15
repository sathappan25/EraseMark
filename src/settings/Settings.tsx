import { useEffect, useState } from "react";
import Button from "../components/Button";
import Logo from "../components/Logo";
import { DEFAULT_SETTINGS, type AppSettings, type OutputFormat, type ThemeSetting } from "../types";
import { loadSettings, saveSettings } from "../utils/storage";
import { applyTheme } from "../utils/theme";

const BRUSH_SIZES = [10, 20, 30, 50, 100] as const;
const RADII = [3, 5] as const;

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadSettings().then((value) => {
      setSettings(value);
      applyTheme(value.theme);
    });
  }, []);

  const update = async (patch: Partial<AppSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
    if (patch.theme) applyTheme(patch.theme);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Logo size={40} />
          <div>
            <h1 className="text-xl font-semibold">EraseMark Settings</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">Saved on this device only.</p>
          </div>
        </div>

        <section className="rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
          <h2 className="text-sm font-semibold">Theme</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["system", "light", "dark"] as ThemeSetting[]).map((theme) => (
              <Button
                key={theme}
                variant={settings.theme === theme ? "primary" : "secondary"}
                onClick={() => void update({ theme })}
                className="capitalize"
              >
                {theme}
              </Button>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
          <h2 className="text-sm font-semibold">Default brush size</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {BRUSH_SIZES.map((size) => (
              <Button
                key={size}
                variant={settings.defaultBrushSize === size ? "primary" : "secondary"}
                onClick={() => void update({ defaultBrushSize: size })}
              >
                {size}
              </Button>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
          <h2 className="text-sm font-semibold">Default inpainting radius</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {RADII.map((radius) => (
              <Button
                key={radius}
                variant={settings.defaultInpaintRadius === radius ? "primary" : "secondary"}
                onClick={() => void update({ defaultInpaintRadius: radius })}
              >
                {radius}
              </Button>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
          <h2 className="text-sm font-semibold">Default output</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {(["png", "jpeg"] as OutputFormat[]).map((format) => (
              <Button
                key={format}
                variant={settings.defaultOutput === format ? "primary" : "secondary"}
                onClick={() => void update({ defaultOutput: format })}
                className="uppercase"
              >
                {format}
              </Button>
            ))}
          </div>
        </section>

        <section className="mt-4 rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
          <h2 className="text-sm font-semibold">Inpainting algorithm</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant={settings.inpaintAlgorithm === "TELEA" ? "primary" : "secondary"}
              onClick={() => void update({ inpaintAlgorithm: "TELEA" })}
            >
              Telea
            </Button>
            <Button
              variant={settings.inpaintAlgorithm === "NS" ? "primary" : "secondary"}
              onClick={() => void update({ inpaintAlgorithm: "NS" })}
            >
              Navier-Stokes
            </Button>
          </div>
        </section>

        <section className="mt-4 rounded-2xl bg-white p-5 shadow-card dark:bg-slate-900">
          <h2 className="text-sm font-semibold">Privacy</h2>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            Images are processed locally in your browser whenever possible. Images are not uploaded to a
            server by this extension.
          </p>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            EraseMark does not include analytics or tracking. Use it only on images you own or are
            authorized to edit. It is not intended to bypass stock-photo licensing, paywalls, attribution
            requirements, DRM, or access controls.
          </p>
        </section>

        {saved ? <p className="mt-4 text-sm text-brand-600">Settings saved.</p> : null}
      </div>
    </div>
  );
}
