"use client";

import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import styles from "./RowList.module.css";

export interface Column {
  id: string;
  /** Column header, also shown beside the value when a row stacks. */
  header: string;
  align?: "left" | "right";
  /**
   * A CSS grid track: `7rem`, `minmax(12rem, 1fr)`. The primary column takes the remaining width;
   * give it a minimum if the list should scroll sideways before its main text is squeezed.
   */
  width?: string;
  /** The row's main text. Exactly one column should be primary. */
  primary?: boolean;
  /** Buttons at the far right; the header is read by screen readers only. */
  actions?: boolean;
}

const ColumnsContext = createContext<readonly Column[]>([]);

export interface RowListProps {
  /** Accessible name of the list: "Markets", "Your orders". */
  label: string;
  columns: readonly Column[];
  /** Accepted from pages of the previous design; it no longer changes anything. A list stacks by its own width. */
  dense?: boolean;
  children: ReactNode;
}

/**
 * Every list. Its own white surface: a line of small column labels, then rows with the main text
 * left and numbers in fixed columns. Where the list itself is 40rem wide or less (a phone, or the
 * main column beside an aside) each row stacks and every value carries its label.
 */
export function RowList({ label, columns, children }: RowListProps) {
  const template = columns.map((column) => column.width ?? (column.primary ? "minmax(0, 1fr)" : "max-content")).join(" ");
  return (
    <div className={styles.list} role="table" aria-label={label} style={{ "--columns": template } as CSSProperties}>
      <div role="rowgroup">
        <div className={styles.header} role="row">
          {columns.map((column) => (
            <span key={column.id} role="columnheader" className={`${styles.heading} ${column.align === "right" ? styles.right : ""}`}>
              {column.actions ? <span className="sr-only">{column.header}</span> : column.header}
            </span>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        <ColumnsContext.Provider value={columns}>{children}</ColumnsContext.Provider>
      </div>
    </div>
  );
}

export interface RowProps {
  /** One node per column, in column order. */
  cells: readonly ReactNode[];
  /** Content spanning the full width under the row, such as the details of an order. */
  detail?: ReactNode;
}

export function Row({ cells, detail }: RowProps) {
  const columns = useContext(ColumnsContext);
  return (
    <>
      <div className={styles.row} role="row">
        {columns.map((column, index) => (
          <div
            key={column.id}
            role="cell"
            className={[styles.cell, column.primary ? styles.primary : "", column.actions ? styles.actions : "", column.align === "right" ? styles.right : ""].filter(Boolean).join(" ")}
          >
            {!column.primary && !column.actions && <span className={styles.cellLabel}>{column.header}</span>}
            {cells[index]}
          </div>
        ))}
      </div>
      {/* A row of its own with one cell across every column, so that it sits under all the headers. */}
      {detail && (
        <div className={styles.detailRow} role="row">
          <div role="cell" aria-colspan={columns.length}>
            {detail}
          </div>
        </div>
      )}
    </>
  );
}
