"use client";

export function Thrower(): never {
  throw new Error("Thrown on purpose by /dev/throw, to show the error page.");
}
