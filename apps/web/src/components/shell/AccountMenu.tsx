"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { shortAddress } from "@/lib/format";
import styles from "./AccountMenu.module.css";

export type FaucetStatus =
  | { kind: "idle" }
  | { kind: "working" }
  /** A plain sentence: what was sent, or why nothing was. */
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

export interface AccountMenuProps {
  address: string;
  /** True for the wallet created at an email login. */
  embedded: boolean;
  onGetTestFunds(): void;
  faucet: FaucetStatus;
  onLogout(): void;
  /** For the reference page: render the panel open. */
  defaultOpen?: boolean;
}

/**
 * The wallet control: a button with the short address that shows a panel under it with the full
 * address, copy, test funds, how it works and log out. A disclosure, not a menu: the panel is
 * ordinary content, reached with Tab and read in order. Escape closes it and returns to the button;
 * so does a press, or focus, anywhere else.
 */
export function AccountMenu({ address, embedded, onGetTestFunds, faucet, onLogout, defaultOpen = false }: AccountMenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    setOpen(false);
    button.current?.focus();
  }

  /** Focus that moves on to something outside closes the panel. */
  function onBlur(event: FocusEvent) {
    if (event.relatedTarget && !root.current?.contains(event.relatedTarget)) setOpen(false);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const working = faucet.kind === "working";

  return (
    <div className={styles.root} ref={root} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={button}
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Account ${shortAddress(address)}`}
        data-testid="account"
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.address}>{shortAddress(address)}</span>
        <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div id={panelId} className={styles.panel} data-testid="account-panel">
          <div className={styles.identity}>
            <p className={styles.caption}>{embedded ? "Wallet created at login" : "Connected wallet"}</p>
            <p className={styles.full}>{address}</p>
          </div>
          <button type="button" className={styles.item} onClick={copy}>
            <span>Copy address</span>
            <span className={styles.aside} aria-hidden="true">
              {copied ? "Copied" : ""}
            </span>
          </button>
          <p className="sr-only" role="status">
            {copied ? "Address copied" : ""}
          </p>
          <button type="button" className={styles.item} aria-disabled={working || undefined} onClick={working ? undefined : onGetTestFunds}>
            <span>Get test funds</span>
            <span className={styles.aside}>{working ? "Sending" : ""}</span>
          </button>
          {(faucet.kind === "done" || faucet.kind === "error") && (
            <p className={`${styles.result} ${faucet.kind === "error" ? styles.resultError : ""}`} role={faucet.kind === "error" ? "alert" : "status"}>
              {faucet.text}
            </p>
          )}
          <Link href="/system" className={styles.item} onClick={() => setOpen(false)}>
            How it works
          </Link>
          <button
            type="button"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
