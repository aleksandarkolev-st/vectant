import "./globals.css";
import "./editor-overrides.css";
import { Geist, Geist_Mono, Inter } from "next/font/google";
import NextAuthSessionProvider from "./SessionProvider";
import { ReduxProvider } from "./ReduxProvider";
import { Toaster } from "../components/ui/sonner";
import GlobalErrorHandler from "../components/GlobalErrorHandler";
import StoreHydrator from "../components/StoreHydrator";
import ThemeProvider from "../components/ThemeProvider";
import { ThemePickerProvider } from "../components/ThemePicker";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Synthi UI Font - Inter as fallback for SF Pro
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata = {
  title: "Synthi IDE",
  description: "The intelligent cloud IDE powered by Synthi",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${inter.variable} antialiased`}
        style={{ fontFamily: '"SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, var(--font-inter), var(--font-geist-sans), system-ui, sans-serif' }}
      >
        <Toaster />
        <GlobalErrorHandler />
        <ReduxProvider>
          <StoreHydrator />
          <ThemeProvider>
            <ThemePickerProvider>
              <NextAuthSessionProvider>
                {children}
              </NextAuthSessionProvider>
            </ThemePickerProvider>
          </ThemeProvider>
        </ReduxProvider>
        
        
      </body>
    </html>
  );
}
