import { Reddit_Sans } from "next/font/google";

// The one typeface, downloaded at build time and served from this app. It is a variable font, so
// one file covers every weight. Shared by the root layout and the global error page.
export const redditSans = Reddit_Sans({ subsets: ["latin"], variable: "--font-reddit-sans", display: "swap" });
