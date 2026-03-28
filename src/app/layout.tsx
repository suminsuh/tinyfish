import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Fishing",
  description:
    "Fishing ranks Luma attendees using official organizer API access when available, plus TinyFish enrichment and GPT-based public-signal analysis.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
