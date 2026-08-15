import { useEffect } from "react";
import Editor from "./editor/Editor";
import Popup from "./popup/Popup";
import Settings from "./settings/Settings";
import { loadSettings } from "./utils/storage";
import { applyTheme, watchSystemTheme } from "./utils/theme";

export default function App() {
  useEffect(() => {
    let stopWatching = () => {};
    void loadSettings().then((settings) => {
      applyTheme(settings.theme);
      stopWatching = watchSystemTheme(settings.theme);
    });
    return () => stopWatching();
  }, []);

  const page = document.body.dataset.page;
  if (page === "popup") return <Popup />;
  if (page === "options") return <Settings />;
  return <Editor />;
}
