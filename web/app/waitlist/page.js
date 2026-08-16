import WaitlistForm from "./WaitlistForm";
import "./waitlist.css";

export const metadata = {
  title: "Cobalt — Join the Waitlist",
  description: "Sign up to get notified when Cobalt opens up.",
};

/**
 * Waitlist sign-up page. Standalone route, not yet linked from the shared nav (left for a
 * follow-up). Markup/copy live here; the interactive submit logic lives in the client
 * component (WaitlistForm) since it needs fetch + local state for a nicer inline UX than a
 * full-page Formspree redirect.
 */
export default function WaitlistPage() {
  return (
    <div className="waitlist-page">
      <section className="waitlist-hero">
        <div className="wrap">
          <span className="eyebrow">Early access</span>
          <h1>Join the waitlist</h1>
          <p className="sub">Get notified when Cobalt opens up.</p>
          <WaitlistForm />
        </div>
      </section>
    </div>
  );
}
