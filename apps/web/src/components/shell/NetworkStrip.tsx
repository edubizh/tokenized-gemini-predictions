import styles from "./NetworkStrip.module.css";

/** Fixed at the top of every page. It cannot be dismissed. */
export function NetworkStrip({ fixed = true }: { fixed?: boolean }) {
  return (
    <div className={`${styles.strip} ${fixed ? styles.fixed : ""}`} role="note" aria-label="Test network notice">
      <p className={styles.text}>
        <span>Devnet and sandbox demo.</span> <span>Test tokens with no value.</span>
      </p>
    </div>
  );
}
