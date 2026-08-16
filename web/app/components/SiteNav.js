"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import "../nav.css";

/**
 * Shared top nav rendered on every route. On the landing page it offers the original
 * "Open the registry dashboard" CTA; on the viewer it offers a way back to the landing
 * page. Ported from landing/index.html's <header class="nav">.
 */
export default function SiteNav() {
  const pathname = usePathname();
  const onViewer = pathname === "/viewer";

  return (
    <header className="site-nav">
      <div className="wrap nav-inner">
        <Link className="logo" href="/">
          <span className="dot"></span>COBALT
        </Link>
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
    </header>
  );
}
