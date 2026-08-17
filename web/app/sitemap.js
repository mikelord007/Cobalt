// Next's file-convention route: generates /sitemap.xml. Hand-written, not derived from the
// filesystem -- there are only four real routes total, so a generator would be more machinery
// than the four-line list it replaces.
export default function sitemap() {
  const base = "https://cobalt-alpha-five.vercel.app";
  return [
    { url: `${base}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/trust`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/viewer`, changeFrequency: "daily", priority: 0.5 },
    { url: `${base}/waitlist`, changeFrequency: "monthly", priority: 0.4 },
  ];
}
