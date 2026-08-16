import "../landing.css";

export const metadata = {
  title: "Cobalt — Trust Model",
  description:
    "The full trust model behind Cobalt: what AWS Nitro Enclave attestation and on-chain verification guarantee, and what still rests on trusting the operator.",
};

/**
 * Standalone trust-model page. Content is the "Hardware-enforced correctness.
 * Operator-trusted liveness." section moved verbatim off the landing page (see
 * app/page.js), reusing the same .trust / .trust-grid / .trust-col rules from
 * landing.css so it stays visually consistent with the rest of the site.
 */
export default function TrustPage() {
  return (
    <div className="landing-page">
      <section className="trust">
        <div className="wrap">
          <span className="eyebrow">The trust model, stated plainly</span>
          <h2>Hardware-enforced correctness. Operator-trusted liveness.</h2>
          <div className="trust-grid">
            <div className="trust-col">
              <span className="tag">✓ Cryptographically guaranteed</span>
              <h3>Which code produced a result</h3>
              <p>
                An AWS Nitro Enclave hardware-signs an attestation naming exactly the code
                image running inside it. A Solidity contract stack on Monad verifies that
                signature on-chain before trusting anything the enclave says. This cannot be
                faked by whoever operates the servers — not with root, not with physical
                access to the host.
              </p>
            </div>
            <div className="trust-col dim">
              <span className="tag">Still requires trust</span>
              <h3>Whether the service is up, and answering honestly</h3>
              <p>
                Attestation proves what code would produce a result if the enclave runs it —
                it doesn&apos;t force the operator to keep the lights on, or to route real
                requests to it instead of silently withholding them. Availability and honest
                operation of the service still rest on trusting whoever runs it. Cobalt does
                not pretend otherwise.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
