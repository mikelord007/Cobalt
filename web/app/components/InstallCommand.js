"use client";

import { useEffect, useRef, useState } from "react";

const INSTALL_CMD = "npm install -g cobalt-tee";

/**
 * Copy-to-clipboard command widget for the landing page, in the style of CLI tool landing
 * pages (Vite/Astro/Bun, etc). Styled via the .install-widget rules in ../landing.css (same
 * surface/border/mono-font terminal convention as the .terminal block on the page). Isolated
 * into its own client component -- rather than making the whole landing page a client
 * component -- since copy-to-clipboard is the only interactive bit on an otherwise
 * static/server-rendered page.
 *
 * Two usages share this component and its copy mechanism:
 *  - the hero's single-line "npm install -g cobalt-tee" pill (default, no props needed)
 *  - the terminal section's multi-line "try it for real" block, via the `lines` prop: an
 *    array of either plain strings, or `{ text, placeholder: true }` for a line that contains
 *    a value the visitor must substitute (rendered in the accent color so it reads as a
 *    template, not a real credential). A line whose text starts with "#" renders as a
 *    dim/italic shell comment instead of a `$ ` prompt line. All lines are still copied
 *    together as one plain-text block (comments are harmless to paste into a shell).
 */
export default function InstallCommand({ lines, label }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef(null);

  const isBlock = Array.isArray(lines) && lines.length > 0;
  const lineTexts = isBlock ? lines.map((line) => (typeof line === "string" ? line : line.text)) : [INSTALL_CMD];
  const copyText = lineTexts.join("\n");

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    let ok = false;

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(copyText);
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
        textarea.value = copyText;
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

  const copyButton = (
    <button
      type="button"
      className={copied ? "install-copy copied" : "install-copy"}
      onClick={handleCopy}
      aria-label={isBlock ? "Copy commands to clipboard" : "Copy install command to clipboard"}
    >
      {copied ? (
        <>
          <span className="check">✓</span> Copied
        </>
      ) : (
        "Copy"
      )}
    </button>
  );

  if (!isBlock) {
    return (
      <div className="install-widget">
        <span className="install-prompt">$</span>
        <code className="install-cmd">{INSTALL_CMD}</code>
        {copyButton}
      </div>
    );
  }

  return (
    <div className="install-widget install-block">
      <div className="install-block-bar">
        <span className="install-block-label">{label || "try it"}</span>
        {copyButton}
      </div>
      <div className="install-block-body">
        {lines.map((line, i) => {
          const text = typeof line === "string" ? line : line.text;
          const isComment = text.trim().startsWith("#");
          const isPlaceholder = typeof line === "object" && line.placeholder;
          const lineClass = isComment ? "install-line comment" : isPlaceholder ? "install-line placeholder" : "install-line";
          return (
            <div key={i} className={lineClass}>
              {!isComment && <span className="install-prompt">$</span>}
              <code className="install-cmd">{text}</code>
            </div>
          );
        })}
      </div>
    </div>
  );
}
