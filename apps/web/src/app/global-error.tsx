"use client";

import { useEffect } from "react";
import { ProblemView } from "@/components/shell/Problem";
import { Button } from "@/components/ui/Button";
import strip from "@/components/shell/NetworkStrip.module.css";
import styles from "@/components/shell/Problem.module.css";
import { plexMono, plexSans } from "./fonts";
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
    <html lang="en" className={`${plexSans.variable} ${plexMono.variable}`}>
      <head>
        <title>Something went wrong · Outcome Tokens</title>
      </head>
      <body>
        <div className={styles.frame}>
          <div className={`${strip.strip} ${strip.fixed}`} role="note" aria-label="Test network notice">
            <p className={strip.text}>
              <span>Devnet and sandbox demo.</span> <span>Test tokens with no value.</span>
            </p>
          </div>
          <header className={styles.bar}>
            <div className={styles.barInner}>
              {/* A full page load on purpose: the app is started afresh. */}
              <a href="/" className={styles.wordmark}>
                Outcome Tokens
              </a>
            </div>
          </header>
          <main className={styles.main}>
            <ProblemView kind="Something went wrong" title="The app could not start" action={<Button onClick={reset}>Try again</Button>}>
              The app hit an error before it could draw anything; nothing was signed or sent, and what you hold on Solana is unchanged.
            </ProblemView>
          </main>
        </div>
      </body>
    </html>
  );
}
