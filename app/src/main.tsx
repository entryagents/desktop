import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

declare global {
  interface Window {
    __entryBootOK?: () => void;
  }
}

// Dev/beta diagnostics: log bridge presence + paint errors in the transcript area.
try {
  console.info(
    "[entry-desktop] boot:",
    "bridge=",
    Boolean(window.desktop),
    "tauri=",
    Boolean(window.__TAURI__),
  );
} catch {
  /* console unavailable */
}

try {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  // Remove any boot-error overlay painted by the inline trap once React is up
  // (the trap re-paints if a later uncaught error happens).
  window.__entryBootOK?.();
} catch (e) {
  document.title = "render failed";
  const el = document.createElement("pre");
  el.style.cssText = "color:#ff7b72;padding:20px;white-space:pre-wrap";
  el.textContent = "React render failed:\n" + String(e);
  document.body.appendChild(el);
}
