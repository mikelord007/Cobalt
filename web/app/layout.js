import Script from "next/script";
import "./globals.css";
import SiteNav from "./components/SiteNav";

export const metadata = {
  title: "Cobalt — Verifiable Off-Chain Compute",
  description:
    "Cobalt runs application logic inside AWS Nitro Enclaves and verifies the output on Monad. Hardware-enforced correctness, operator-trusted liveness.",
};

// Light is the default theme (see globals.css :root). This runs before hydration/paint so a
// returning visitor who chose dark mode doesn't see a light-mode flash first. Keep the storage
// key ("cobalt-theme") in sync with SiteNav.js, which owns the toggle itself.
const THEME_INIT_SCRIPT = `
(function () {
  try {
    if (window.localStorage.getItem("cobalt-theme") === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  } catch (e) {}
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <Script id="theme-init" strategy="beforeInteractive">
          {THEME_INIT_SCRIPT}
        </Script>
      </head>
      <body>
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
