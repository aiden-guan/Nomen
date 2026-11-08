import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import { StatusBar } from "@/components/StatusBar";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Nomen",
  description: "From a website to researched, high-quality UGC video ads on the brand's own accounts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="font-sans antialiased">
        <header className="sticky top-0 z-20 border-b border-white/5 bg-zinc-950/70 backdrop-blur-xl">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/nomen-logo.png" alt="" width={40} height={28} className="h-7 w-auto" />
              Nomen
            </Link>
            <nav className="flex items-center gap-1 text-sm text-zinc-400">
              <Link href="/" className="rounded-lg px-3 py-1.5 hover:bg-white/5 hover:text-white">
                Brands
              </Link>
              <Link href="/settings" className="rounded-lg px-3 py-1.5 hover:bg-white/5 hover:text-white">
                Settings
              </Link>
            </nav>
            <div className="ml-auto">
              <StatusBar />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-4 pb-24 pt-8 sm:px-6">{children}</main>
      </body>
    </html>
  );
}
