import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";
import { NetworkStrip } from "@/components/shell/NetworkStrip";
import { loadConfig } from "@/lib/config.server";
import { Providers } from "@/lib/privy/providers";
import { SESSION_HINT_SCRIPT } from "@/lib/privy/session-hint";
import "./globals.css";

const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--plex-sans", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Outcome Tokens", template: "%s · Outcome Tokens" },
  description: "Unofficial devnet and sandbox demo. Test tokens with no value.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// The configuration depends on the environment and on a deployment file that may appear while the
// server is running, so nothing here is rendered ahead of time.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = loadConfig().public;
  return (
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SESSION_HINT_SCRIPT }} />
      </head>
      <body>
        <NetworkStrip />
        <Providers config={config}>{children}</Providers>
      </body>
    </html>
  );
}
