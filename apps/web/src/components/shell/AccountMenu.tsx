"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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
  /** For the reference page: render the menu open. */
  defaultOpen?: boolean;
}

/** A menu button: short address, copy, get test funds, how it works, log out. */
export function AccountMenu({ address, embedded, onGetTestFunds, faucet, onLogout, defaultOpen = false }: AccountMenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []);
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) button.current?.focus();
  };

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

  function onButtonKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => {
        const all = items();
        (event.key === "ArrowDown" ? all[0] : all[all.length - 1])?.focus();
      });
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      all[(index + 1) % all.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      all[(index - 1 + all.length) % all.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      all[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      all[all.length - 1]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
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
    <div className={styles.root} ref={root}>
      <button
        ref={button}
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account ${shortAddress(address)}`}
        onClick={(event) => {
          // Opened from the keyboard (Enter or Space), focus moves into the menu, as with the arrow keys.
          const fromKeyboard = event.detail === 0;
          if (!open && fromKeyboard) requestAnimationFrame(() => items()[0]?.focus());
          setOpen((value) => !value);
        }}
        onKeyDown={onButtonKeyDown}
      >
        <span className={styles.address}>{shortAddress(address)}</span>
        <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div ref={menu} id={menuId} className={styles.menu} role="menu" aria-label="Account" onKeyDown={onMenuKeyDown}>
          <div className={styles.identity}>
            <p className={styles.caption}>{embedded ? "Wallet created at login" : "Connected wallet"}</p>
            <p className={styles.full}>{address}</p>
          </div>
          <button type="button" role="menuitem" className={styles.item} onClick={copy}>
            <span>Copy address</span>
            <span className={styles.aside} role="status">
              {copied ? "Copied" : ""}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            aria-disabled={working || undefined}
            onClick={working ? undefined : onGetTestFunds}
          >
            <span>Get test funds</span>
            <span className={styles.aside}>{working ? "Sending" : ""}</span>
          </button>
          {(faucet.kind === "done" || faucet.kind === "error") && (
            <p className={`${styles.result} ${faucet.kind === "error" ? styles.resultError : ""}`} role={faucet.kind === "error" ? "alert" : "status"}>
              {faucet.text}
            </p>
          )}
          <Link href="/system" role="menuitem" className={styles.item} onClick={() => setOpen(false)}>
            How it works
          </Link>
          <button
            type="button"
            role="menuitem"
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
