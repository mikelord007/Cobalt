"use client";

import { useEffect, useRef, useState } from "react";

const INSTALL_CMD = "npm install -g cobalt-tee";

/**
 * Small "copy install command" pill for the landing page hero, in the style of CLI tool
 * landing pages (Vite/Astro/Bun, etc). Styled via the .install-widget rules in ../landing.css
 * (same surface/border/mono-font terminal convention as the .terminal block below it on the
 * page). Isolated into its own client component -- rather than making the whole landing page
 * a client component -- since copy-to-clipboard is the only interactive bit on an otherwise
 * static/server-rendered page.
 */
export default function InstallCommand() {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    let ok = false;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(INSTALL_CMD);
        ok = true;
      }
    } catch {
      ok = false;
    }

    if (!ok) {
      // Fallback for contexts where the async Clipboard API isn't available (e.g. non-HTTPS,
      // non-localhost origins): a hidden, off-screen textarea + the legacy execCommand('copy').
      try {
        const textarea = document.createElement("textarea");
        textarea.value = INSTALL_CMD;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-1000px";
        textarea.style.left = "-1000px";
        document.body.appendChild(textarea);
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        ok = document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch {
        ok = false;
      }
    }

    if (!ok) return; // fail silently rather than throwing/crashing the page

    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="install-widget">
      <span className="install-prompt">$</span>
      <code className="install-cmd">{INSTALL_CMD}</code>
      <button
        type="button"
        className={copied ? "install-copy copied" : "install-copy"}
        onClick={handleCopy}
        aria-label="Copy install command to clipboard"
      >
        {copied ? (
          <>
            <span className="check">✓</span> Copied
          </>
        ) : (
          "Copy"
        )}
      </button>
    </div>
  );
}
