"use client";

import { useEffect } from "react";
import { NetworkMark } from "@/components/shell/Navbar";
import { DISCLAIMER } from "@/components/shell/network";
import { ProblemView } from "@/components/shell/Problem";
import { Button } from "@/components/ui/Button";
import footer from "@/components/shell/Footer.module.css";
import nav from "@/components/shell/Navbar.module.css";
import shell from "@/components/shell/Shell.module.css";
import { redditSans } from "./fonts";
import "./globals.css";

/**
 * The last fallback: shown when the root layout itself threw, so it brings its own document and
 * frame and depends on nothing the layout provides.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset(): void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en" className={redditSans.variable}>
      <head>
        <title>Something went wrong · Outcome Tokens</title>
      </head>
      <body>
        <header className={nav.bar}>
          <div className={nav.inner}>
            {/* A full page load on purpose: the app is started afresh. */}
            <a href="/" className={nav.brand}>
              Outcome Tokens
            </a>
            <NetworkMark cluster="devnet" />
          </div>
        </header>
        <main className={shell.main}>
          <ProblemView kind="Something went wrong" title="The app could not start" action={<Button onClick={reset}>Try again</Button>}>
            The app hit an error before it could draw anything; nothing was signed or sent, and what you hold on Solana is unchanged.
          </ProblemView>
        </main>
        <footer className={footer.footer}>
          <div className={footer.inner}>
            <p>{DISCLAIMER}</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
