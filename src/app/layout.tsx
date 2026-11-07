import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Minimal root layout so this branch runs on its own. The core track ships the real one (header,
// nav, status bar); the Troy pages cover the whole window, so they work under either. See docs/troy.md.

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Nomen",
  description: "From a website to researched, high-quality UGC video ads on the brand's own accounts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
