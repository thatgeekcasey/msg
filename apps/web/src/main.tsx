import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { keepReplacingPush } from "./lib/custom-domain";
import { listenForInstallPrompt } from "./lib/install-prompt";
import "./index.css";

listenForInstallPrompt();
// Before anything reads the address.
keepReplacingPush();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
