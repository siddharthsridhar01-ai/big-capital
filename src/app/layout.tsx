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
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
