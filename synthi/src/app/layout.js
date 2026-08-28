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
import { ThemeCreatorProvider } from "../components/ThemeCreator";
import { NewProjectPickerProvider } from "../components/NewProjectPicker";

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

function resolveMetadataBase() {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.SYNTHI_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    "https://beta.vectant.dev";

  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`);
  } catch {
    return new URL("https://beta.vectant.dev");
  }
}

export const metadata = {
  metadataBase: resolveMetadataBase(),
  title: "Vectant ADE",
  description: "The intelligent cloud IDE powered by Vectant ADE",
  icons: {
    icon: [
      { url: "/vectant-dark-theme.png", type: "image/png", sizes: "1043x239" },
      { url: "/vectant/the_V.png", type: "image/png" },
    ],
    shortcut: "/vectant-dark-theme.png",
    apple: "/vectant-dark-theme.png",
  },
  openGraph: {
    title: "Vectant ADE",
    description: "The intelligent cloud IDE powered by Vectant ADE",
    images: [
      {
        url: "/vectant-dark-theme.png",
        width: 1043,
        height: 239,
        alt: "Vectant ADE",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Vectant ADE",
    description: "The intelligent cloud IDE powered by Vectant ADE",
    images: ["/vectant-dark-theme.png"],
  },
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
            <ThemeCreatorProvider>
              <ThemePickerProvider>
                <NewProjectPickerProvider>
                  <NextAuthSessionProvider>
                    {children}
                  </NextAuthSessionProvider>
                </NewProjectPickerProvider>
              </ThemePickerProvider>
            </ThemeCreatorProvider>
          </ThemeProvider>
        </ReduxProvider>
        
        
      </body>
    </html>
  );
}
