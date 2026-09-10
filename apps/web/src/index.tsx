import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "./style.css";
import { WebApplication } from "./router";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebApplication hosted={import.meta.env.MODE === "hosted"} />
  </React.StrictMode>,
);
