"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { cost, feeCap, takerFee } from "@outcome/relayer/money";
import { Shell } from "@/components/shell/Shell";
import { Button } from "@/components/ui/Button";
import { Receipt, ReceiptLine } from "@/components/ui/Receipt";
import { Skeleton } from "@/components/ui/Skeleton";
import { Stamp } from "@/components/ui/Stamp";
import { formatContracts, formatDollars, formatPrice } from "@/lib/format";
import { useAccount } from "@/lib/privy/account";
import styles from "./Landing.module.css";

const STEPS = [
  {
    title: "Hold",
    where: "On Solana",
    text: "You pick YES or NO, a quantity and the most you will pay. A program on Solana holds your test dollars for that order, with a deadline.",
  },
  {
    title: "Fill",
    where: "At the venue",
    text: "A relayer places the matching order on an exchange sandbox. Tokens are minted to your wallet only if it fills. If it does not, the whole amount is refunded.",
  },
  {
    title: "Redeem",
    where: "On Solana",
    text: "The market lasts fifteen minutes. Once it settles, each winning contract redeems for $1.00 in test dollars. Losing tokens redeem for nothing.",
  },
] as const;

// The example on the right, computed with the same integer math the app uses for real orders.
const EXAMPLE = (() => {
  const units = 500n;
  const limitPx = 5_700n;
  const fillPx = 5_600n;
  const held = cost(units, limitPx) + feeCap(units, limitPx);
  const paid = cost(units, fillPx);
  const fee = takerFee(units, fillPx);
  return { units, limitPx, fillPx, held, paid, fee, refund: held - paid - fee };
})();

/** `/` for a visitor who is not logged in. A logged-in user is sent on to the markets. */
export function Landing() {
  const router = useRouter();
  const account = useAccount();
  const loggedIn = account.ready && account.authenticated;

  useEffect(() => {
    if (loggedIn) router.replace("/markets");
  }, [loggedIn, router]);

  return (
    <Shell>
      {/* Painted instead of the page when this browser was logged in on its last visit. */}
      <div className={styles.resuming} aria-hidden="true">
        <Skeleton width="16rem" height="1.9rem" />
        <Skeleton width="100%" height="56px" />
        <Skeleton width="100%" height="56px" />
        <Skeleton width="100%" height="56px" />
      </div>

      <div className={styles.landing}>
        <section className={styles.intro}>
          <h1 className={styles.title}>A prediction-market position, held as a token on Solana.</h1>
          <p className={styles.lead}>
            Outcome Tokens is a working demo. You buy YES or NO in a fifteen-minute market with test dollars, the order is filled on an exchange sandbox, and the position arrives in your wallet as a token you can redeem when the market settles.
          </p>
          <div className={styles.actions}>
            <Button variant="primary" onClick={account.login} disabled={!account.ready || loggedIn} data-testid="login">
              Log in
            </Button>
            <Link href="/system" className={styles.more}>
              How it works
            </Link>
          </div>
          <p className={styles.small}>Log in with an email address or a Solana wallet. No real funds are involved at any point.</p>
        </section>

        <aside className={styles.example} aria-label="Example order">
          <Receipt title="Example order" mark={<Stamp value="FILLED" />} edge="top" note="An illustration with test dollars. Every real order gets a receipt like this, with a link to each transaction.">
            <ReceiptLine label="Bitcoin up in 15 minutes">YES</ReceiptLine>
            <ReceiptLine label="Quantity">{formatContracts(EXAMPLE.units)} contracts</ReceiptLine>
            <ReceiptLine label="Limit price">{formatPrice(EXAMPLE.limitPx)}</ReceiptLine>
            <ReceiptLine label="Held on Solana">{formatDollars(EXAMPLE.held)}</ReceiptLine>
            <ReceiptLine label="Filled at">{formatPrice(EXAMPLE.fillPx)}</ReceiptLine>
            <ReceiptLine label="Cost">{formatDollars(EXAMPLE.paid)}</ReceiptLine>
            <ReceiptLine label="Venue fee">{formatDollars(EXAMPLE.fee)}</ReceiptLine>
            <ReceiptLine label="Refunded">{formatDollars(EXAMPLE.refund)}</ReceiptLine>
            <ReceiptLine label="Tokens minted" total>
              {formatContracts(EXAMPLE.units)} YES
            </ReceiptLine>
          </Receipt>
        </aside>

        <section className={styles.mechanism} aria-labelledby="mechanism-title">
          <h2 id="mechanism-title">The mechanism, in three steps</h2>
          <ol className={styles.steps}>
            {STEPS.map((step, index) => (
              <li key={step.title} className={styles.step}>
                <span className={styles.number} aria-hidden="true">
                  {index + 1}
                </span>
                <h3 className={styles.stepTitle}>{step.title}</h3>
                <p className={styles.stepText}>{step.text}</p>
                <span className={styles.where}>{step.where}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className={styles.honest} aria-labelledby="honest-title">
          <h2 id="honest-title">Test money only</h2>
          <div className={styles.statements}>
            <p>
              Everything runs on Solana devnet and an exchange sandbox. The dollars are test dollars and the tokens have no value. Nothing here can be bought, sold or withdrawn for real money.
            </p>
            <p>
              The bridge is custodial. The program limits what can happen to any one order: its price, quantity, fee and deadline. That a fill happened, and how a market resolved, is reported by a relayer you have to trust.
            </p>
          </div>
        </section>
      </div>
    </Shell>
  );
}
