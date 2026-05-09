import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { ThemeProvider, I18nProvider, TooltipProvider, Toaster } from "@/components/ui";
import { AuthProvider } from "./lib/auth";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <TooltipProvider delayDuration={200}>
          <AuthProvider>
            <App />
            <Toaster />
          </AuthProvider>
        </TooltipProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
