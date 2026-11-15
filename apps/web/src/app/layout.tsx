import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { loadConfig } from "@/lib/config.server";
import { Providers } from "@/lib/privy/providers";
import { HealthProvider } from "@/lib/relayer/hooks";
import { redditSans } from "./fonts";
import { COLORS } from "./theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Outcome Tokens", template: "%s · Outcome Tokens" },
  description: "Unofficial devnet and sandbox demo. Test tokens with no value.",
};

// The browser's own chrome takes the colour of the page.
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: COLORS.peach };

// The configuration depends on the environment and on a deployment file that may appear while the
// server is running, so nothing here is rendered ahead of time.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  const config = loadConfig().public;
  return (
    <html lang="en" className={redditSans.variable}>
      <body>
        <Providers config={config}>
          {/* One poll of the relayer's health for the whole app: the footer, the clock and every page use it. */}
          <HealthProvider>{children}</HealthProvider>
        </Providers>
      </body>
    </html>
  );
}
