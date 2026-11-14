import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

type Variant = "primary" | "secondary" | "quiet";
type Size = "default" | "row";

interface CommonProps {
  variant?: Variant;
  /** 40px by default; 32px inside rows. */
  size?: Size;
  /** Stretches to the width of its container. */
  block?: boolean;
  children: ReactNode;
}

export interface ButtonProps extends CommonProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** A short status that replaces the label while work is in progress ("Signing", "Sending"). */
  busy?: string | false;
}

function classes(variant: Variant, size: Size, block: boolean | undefined, extra?: string): string {
  return [styles.button, styles[variant], size === "row" ? styles.row : "", block ? styles.block : "", extra ?? ""].filter(Boolean).join(" ");
}

/** A busy button keeps the width of its label and shows the status in its place. */
export function Button({ variant = "secondary", size = "default", block, busy = false, disabled, children, className, type = "button", onClick, ...rest }: ButtonProps) {
  const isBusy = typeof busy === "string";
  return (
    <button
      {...rest}
      type={type}
      className={classes(variant, size, block, className)}
      disabled={disabled}
      aria-busy={isBusy || undefined}
      aria-disabled={isBusy || undefined}
      data-busy={isBusy || undefined}
      onClick={isBusy ? (event) => event.preventDefault() : onClick}
    >
      <span className={styles.label} aria-hidden={isBusy || undefined}>
        {children}
      </span>
      {isBusy && (
        <span className={styles.status} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          {busy}
        </span>
      )}
    </button>
  );
}

export interface ButtonLinkProps extends CommonProps {
  href: string;
  className?: string;
}

/** A link that looks like a button, for navigation. */
export function ButtonLink({ variant = "secondary", size = "default", block, href, children, className }: ButtonLinkProps) {
  return (
    <Link href={href} className={classes(variant, size, block, className)}>
      <span className={styles.label}>{children}</span>
    </Link>
  );
}
