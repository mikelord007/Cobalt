import "./globals.css";
import SiteNav from "./components/SiteNav";

export const metadata = {
  title: "Cobalt — Verifiable Off-Chain Compute",
  description:
    "Cobalt runs application logic inside AWS Nitro Enclaves and verifies the output on Monad. Hardware-enforced correctness, operator-trusted liveness.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
