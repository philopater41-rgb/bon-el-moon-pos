import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { OfflineShellRegistration } from "./offline-shell";

const outfit = localFont({
  src: "./fonts/outfit-latin.woff2",
  variable: "--font-outfit",
  weight: "100 900",
});

const inter = localFont({
  src: "./fonts/inter-latin.woff2",
  variable: "--font-inter",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "BON el MOON | Cloud POS & ERP",
  description: "Advanced Offline-First POS & Inventory ERP System for BON el MOON Cafe",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${outfit.variable} ${inter.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#090d16" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body className="min-h-full flex flex-col bg-[#090d16] text-[#f3f4f6]" suppressHydrationWarning>
        <OfflineShellRegistration />
        {children}
      </body>
    </html>
  );
}
