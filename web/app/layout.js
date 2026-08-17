import Script from "next/script";
import "./globals.css";
import SiteNav from "./components/SiteNav";

export const metadata = {
  // Anchors every route's relative OG/Twitter image URLs (including app/opengraph-image.png)
  // into absolute ones. Set on the ROOT layout, not a single page, since it's what every route's
  // metadata resolution falls back to -- without it here, /viewer, /trust and /waitlist would
  // each resolve their preview image against "http://localhost:3000" in production, not just "/".
  // Deploy target is Vercel, at the URL the README's "Live" section and the on-page dashboard
  // link both already use.
  metadataBase: new URL("https://cobalt-alpha-five.vercel.app"),
  title: "Cobalt — TEE infrastructure for Monad",
  description:
    "Deploy your app into an AWS Nitro Enclave with one command. Monad verifies exactly which code ran. Live on Monad testnet.",
  openGraph: {
    title: "Cobalt — TEEs on Monad, in one command",
    description: "Your code runs where no one can see it. Monad verifies which code ran.",
    // Next's opengraph-image.png file convention (app/opengraph-image.png) auto-generates the
    // og:image tag on its own -- no `images` entry needed here for that. type/siteName are set
    // explicitly since Next doesn't default them, and a link unfurled without og:type falls back
    // to generic "website" styling in some clients.
    type: "website",
    siteName: "Cobalt",
  },
  // Twitter Cards are a SEPARATE tag namespace from Open Graph -- Next does not derive
  // twitter:* tags from the openGraph block, so this has to be declared explicitly or a tweet
  // linking the site renders no card at all. `card: "summary_large_image"` matches the
  // 1200x630 art in app/twitter-image.png (a copy of opengraph-image.png -- same 1.91:1 aspect
  // ratio Twitter expects for this card type), which Next auto-attaches via that file's
  // convention the same way it does for og:image.
  twitter: {
    card: "summary_large_image",
    title: "Cobalt — TEEs on Monad, in one command",
    description: "Your code runs where no one can see it. Monad verifies which code ran.",
  },
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
