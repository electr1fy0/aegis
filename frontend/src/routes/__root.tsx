import type { ReactNode } from "react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { AppFrame } from "../components/app-frame";
import "../styles.css";
import "../components/app-frame.css";
import "../experience.css";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Aegis — Operations" },
      { name: "description", content: "Synthetic event coordination workspace" },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <AppFrame>
        <Outlet />
      </AppFrame>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="style-nova" suppressHydrationWarning>
      <head>
        <script id="aegis-theme-init" dangerouslySetInnerHTML={{ __html: `(function(){var p="system";try{p=localStorage.getItem("aegis.theme")||"system"}catch(e){}var d=p==="dark"||(p!=="light"&&p!=="dark"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",!!d);document.documentElement.style.colorScheme=d?"dark":"light"})()` }} />
        <HeadContent />
      </head>
      <body>
        <div id="app">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
