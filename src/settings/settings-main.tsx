import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Settings from "./Settings";
import "../index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("EraseMark settings failed to start.");
}

createRoot(root).render(
  <StrictMode>
    <Settings />
  </StrictMode>,
);
