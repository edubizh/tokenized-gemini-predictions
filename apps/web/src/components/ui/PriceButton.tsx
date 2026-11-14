import Link from "next/link";
import { formatCents } from "@/lib/format";
import styles from "./Button.module.css";

export interface PriceButtonProps {
  side: "YES" | "NO";
  /** Ask price in px. Null when that side has no offer: the button is disabled and shows a dash. */
  px: bigint | null;
  /** Where the button leads (the market page with this side selected). */
  href?: string;
  onClick?(): void;
  /** What is being bought, for the accessible name: "Bitcoin up". */
  subject?: string;
}

const WORD = { YES: "Yes", NO: "No" } as const;

function spoken(px: bigint): string {
  return `${formatCents(px).replace("¢", "")} cents`;
}

/**
 * Yes or No at rest with its ask price in cents, for lists. A preset of Button, not a look of its
 * own: Yes is tinted jade with a jade boundary, No is outlined, and each always carries its word.
 */
export function PriceButton({ side, px, href, onClick, subject }: PriceButtonProps) {
  const className = [styles.button, styles.row, styles.price, side === "YES" ? styles.yes : styles.no].join(" ");
  const content = (
    <span className={styles.label}>
      <span className={styles.side}>{WORD[side]}</span>
      <span>{px === null ? "–" : formatCents(px)}</span>
    </span>
  );
  const about = subject ? `, ${subject}` : "";

  if (px === null) {
    return (
      <button type="button" className={className} disabled aria-label={`${WORD[side]}${about}: no offer`}>
        {content}
      </button>
    );
  }
  const label = `Buy ${WORD[side]} at ${spoken(px)}${about}`;
  if (href) {
    return (
      <Link href={href} className={className} aria-label={label}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} aria-label={label}>
      {content}
    </button>
  );
}
