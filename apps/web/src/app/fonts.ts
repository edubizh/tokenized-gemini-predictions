import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

// Shared by the root layout and the global error page, which replaces that layout.
export const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--plex-sans", display: "swap" });
export const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--plex-mono", display: "swap" });
