// Next's file-convention route: this generates /robots.txt at build/request time -- no manual
// public/robots.txt to keep in sync. Every route here is real, public content (the marketing
// page, the trust-model writeup, the live read-only registry viewer, the waitlist) with nothing
// gated or duplicative, so there's nothing to disallow.
export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://cobalt-alpha-five.vercel.app/sitemap.xml",
  };
}
