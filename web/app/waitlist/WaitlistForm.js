"use client";

import { useState } from "react";

// TODO: replace with a real Formspree form ID from https://formspree.io
// (create a free account, create a form, and swap this placeholder for the ID it gives you).
const FORMSPREE_FORM_ID = "YOUR_FORM_ID";
const FORMSPREE_ENDPOINT = `https://formspree.io/f/${FORMSPREE_FORM_ID}`;

const STATUS = {
  IDLE: "idle",
  SUBMITTING: "submitting",
  SUCCESS: "success",
  ERROR: "error",
};

/**
 * Email capture form, submitted to Formspree via fetch (Accept: application/json) instead of
 * a plain <form action> POST, so we can show inline loading/success/error states rather than
 * a full-page redirect to Formspree's own confirmation page. Formspree's AJAX pattern:
 * https://help.formspree.io/hc/en-us/articles/360013580813-Submit-a-form-with-AJAX
 */
export default function WaitlistForm() {
  const [status, setStatus] = useState(STATUS.IDLE);
  const [errorMessage, setErrorMessage] = useState("");

  async function handleSubmit(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    setStatus(STATUS.SUBMITTING);
    setErrorMessage("");

    try {
      const response = await fetch(FORMSPREE_ENDPOINT, {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" },
      });

      if (response.ok) {
        setStatus(STATUS.SUCCESS);
        return;
      }

      let message = "Something went wrong — please try again.";
      try {
        const data = await response.json();
        if (data && Array.isArray(data.errors) && data.errors.length) {
          message = data.errors.map((e) => e.message).join(", ");
        }
      } catch {
        // response body wasn't JSON (e.g. the placeholder form ID 404s) -- fall back
        // to the generic message above rather than letting this throw.
      }
      setStatus(STATUS.ERROR);
      setErrorMessage(message);
    } catch {
      setStatus(STATUS.ERROR);
      setErrorMessage("Network error — please try again.");
    }
  }

  if (status === STATUS.SUCCESS) {
    return (
      <div className="waitlist-success">
        <span className="check">✓</span>
        <span>You&apos;re on the list.</span>
      </div>
    );
  }

  const submitting = status === STATUS.SUBMITTING;

  return (
    <form className="waitlist-form" onSubmit={handleSubmit} noValidate={false}>
      <div className="waitlist-input-row">
        <input
          className="waitlist-input"
          type="email"
          name="email"
          required
          placeholder="you@example.com"
          disabled={submitting}
          aria-label="Email address"
        />
        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Joining…" : "Join waitlist"}
        </button>
      </div>
      {status === STATUS.ERROR && <p className="waitlist-error">✗ {errorMessage}</p>}
    </form>
  );
}
