import { ClerkProvider } from "@clerk/nextjs";
import { Inter, Source_Serif_4 } from "next/font/google";

// Tabular figures for numerics — used wherever digits appear in the UI.
// "cv11" enables the single-storey 4 which is more legible at small sizes.
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  fallback: ["system-ui", "-apple-system", "Segoe UI", "Helvetica Neue", "sans-serif"],
});

// Serif for headlines and the brand wordmark (replaces Georgia, more refined).
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-serif",
  weight: ["400", "500", "600"],
  fallback: ["Georgia", "Cambria", "Times New Roman", "serif"],
});

export const metadata = {
  title: "BIG Capital",
  description:
    "Student-run investment fund running paper-traded portfolios across six equity strategies.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${inter.variable} ${sourceSerif.variable}`}
      >
        <body
          style={{
            margin: 0,
            fontFamily: "var(--font-sans), system-ui, sans-serif",
          }}
        >
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
