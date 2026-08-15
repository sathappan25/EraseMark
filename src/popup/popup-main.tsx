import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Popup from "./Popup";
import "../index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("EraseMark popup failed to start.");
}

createRoot(root).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
