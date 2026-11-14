import Link from "next/link";
import { formatCents } from "@/lib/format";
import styles from "./PriceButton.module.css";

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

function spoken(px: bigint): string {
  return `${formatCents(px).replace("¢", "")} cents`;
}

/** The side's word above its ask price. The cents shorthand is used here and nowhere else. */
export function PriceButton({ side, px, href, onClick, subject }: PriceButtonProps) {
  const className = `${styles.button} ${side === "YES" ? styles.yes : styles.no}`;
  const content = (
    <>
      <span className={styles.side}>{side}</span>
      <span className={styles.price}>{px === null ? "–" : formatCents(px)}</span>
    </>
  );
  const about = subject ? `, ${subject}` : "";

  if (px === null) {
    return (
      <button type="button" className={className} disabled aria-label={`${side}${about}: no offer`}>
        {content}
      </button>
    );
  }
  const label = `Buy ${side} at ${spoken(px)}${about}`;
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
