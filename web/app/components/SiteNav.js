"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import "../nav.css";

// Same key the anti-flash inline script in layout.js reads before hydration -- keep in sync.
const THEME_KEY = "cobalt-theme";

/**
 * Shared top nav rendered on every route. On the landing page it offers the original
 * "Open the registry dashboard" CTA; on the viewer it offers a way back to the landing
 * page. Ported from landing/index.html's <header class="nav">. Also hosts the light/dark
 * theme toggle so it's available consistently on every page.
 */
export default function SiteNav() {
  const pathname = usePathname();
  const onViewer = pathname === "/viewer";
  const onWaitlist = pathname === "/waitlist";

  // Light is the default and matches the server-rendered markup (no data-theme attribute).
  // The layout's inline beforeInteractive script may have already flipped <html> to dark
  // (from a stored preference) before this component mounts -- read that back here instead
  // of localStorage directly, so this component's state always matches what's on screen.
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const current =
      document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    setTheme(current);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    if (next === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // localStorage unavailable (privacy mode, etc.) -- toggle still works for this session.
    }
  }

  return (
    <header className="site-nav">
      <div className="wrap nav-inner">
        <Link className="logo" href="/">
          <span className="dot"></span>COBALT
        </Link>
        <div className="nav-actions">
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? "☀" : "☾"}
          </button>
          {!onWaitlist && (
            <Link className="nav-cta nav-cta-waitlist" href="/waitlist">
              Waitlist
            </Link>
          )}
          {onViewer ? (
            <Link className="nav-cta" href="/">
              <span className="long">Back to </span>landing page
            </Link>
          ) : (
            <Link className="nav-cta" href="/viewer">
              <span className="long">Open the </span>registry dashboard
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
