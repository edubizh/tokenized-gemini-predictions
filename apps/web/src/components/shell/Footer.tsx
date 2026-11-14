import Link from "next/link";
import styles from "./Footer.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <p>Unofficial demo. Not affiliated with any exchange. Test tokens with no value.</p>
        <Link href="/system">How it works</Link>
      </div>
    </footer>
  );
}
