import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

// Variable Fraunces with the optical-size axis — at poster scale the high-contrast thin strokes
// (weight 300, controlled in CSS) are the signature move in design.md.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ward — the trust layer for agent commerce",
  description:
    "Paste a token. Ward hires specialist agents on CROO, firewalls every deliverable, and returns a go / caution / no-go verdict with real on-chain evidence.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
