import Link from "next/link";
import InstallCommand from "./components/InstallCommand";
import "./landing.css";

export const metadata = {
  title: "Cobalt — TEE infrastructure for Monad",
  description:
    "Deploy your app into an AWS Nitro Enclave with one command. Monad verifies exactly which code ran. Live on Monad testnet.",
  openGraph: {
    title: "Cobalt — TEEs on Monad, in one command",
    description: "Your code runs where no one can see it. Monad verifies which code ran.",
  },
};

/**
 * Landing / marketing page. Five sections: hero, the command (real terminal proof),
 * how it works, tamper-evidence (the page's centerpiece), and a short live/CTA close.
 * The full trust-model essay that used to live here now lives at /trust; this page only
 * makes the claims it can back up in one sentence each.
 */
export default function LandingPage() {
  return (
    <div className="landing-page">
      {/* HERO */}
      <section className="hero">
        <div className="wrap">
          <span className="eyebrow">TEE infrastructure for Monad</span>
          <h1>
            TEEs on Monad. <span className="accent">One command.</span>
          </h1>
          <p className="sub">
            Your code runs where no one can see it — and Monad verifies exactly which code ran.
          </p>
          <p className="cta-note" style={{ color: "var(--accent)" }}>
            Monad had no TEE infrastructure. Now it does.
          </p>
          <InstallCommand />
          <div className="cta-row">
            <span className="cta-note">live on Monad testnet · chain 10143</span>
          </div>
        </div>
      </section>

      {/* THE COMMAND */}
      <section className="terminal-section">
        <div className="wrap">
          <span className="eyebrow">Not a mockup</span>
          <h2>One command. Real hardware. Real Monad.</h2>
          <p className="terminal-note">
            Run this and get a real result back, live from Monad testnet right now — a read
            against the already-deployed registry, verified by a Solidity contract on-chain.
          </p>
          <InstallCommand
            label="$ try it"
            lines={[
              "npm install -g cobalt-tee",
              "git clone https://github.com/mikelord007/Cobalt.git",
              "cd Cobalt",
              "cobalt status examples/ping",
            ]}
          />
          <p className="terminal-note try-it-lead">
            No key, no AWS account. Deploying your own app into an enclave needs your own AWS
            setup — see the README for the full walkthrough.
          </p>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="steps">
        <div className="wrap">
          <span className="eyebrow">How it works</span>
          <h2>From your code to a result Monad will accept</h2>
          <div className="steps-grid">
            <div className="step">
              <div className="num">01</div>
              <h3>Enclave attests</h3>
              <p>AWS hardware signs the exact code measurement running inside.</p>
            </div>
            <div className="step">
              <div className="num">02</div>
              <h3>Monad verifies</h3>
              <p>A hinted P-384 construction makes the check fit under Monad's 30M gas cap.</p>
            </div>
            <div className="step">
              <div className="num">03</div>
              <h3>Signer registered</h3>
              <p>That key is authorized for that code image on Monad, and no other.</p>
            </div>
            <div className="step">
              <div className="num">04</div>
              <h3>Results accepted</h3>
              <p>Any Monad contract can now trust what the enclave signs.</p>
            </div>
          </div>
          <p className="steps-note">
            Sealed-bid auctions, private order flow, confidential AI agents — anything on Monad
            where someone currently has to be trusted not to peek.
          </p>
        </div>
      </section>

      {/* TAMPER-EVIDENCE */}
      <section className="pullquote-section">
        <div className="wrap">
          <span className="eyebrow">Tamper-evidence</span>
          <div className="pullquote">
            <p>The code cannot lie about what it is.</p>
          </div>
          <p className="pullquote-sub">
            Change one line. Rebuild.
            <br />
            The measurement changes.
            <br />
            Monad rejects it.
          </p>
          <div className="reject-example">
            <span className="x">✗</span>
            <span className="label">registerImage(pcr0)</span>
            <span className="hash">0x7f2a19...e04c</span>
            <span className="label">— measurement not recognized, reverted</span>
          </div>
        </div>
      </section>

      {/* LIVE + CTA */}
      <section className="closing">
        <div className="wrap">
          <h2>Running on Monad right now.</h2>
          <p className="sub">
            Real enclave, real AWS attestation, real Solidity registry — deployed and verified on
            Monad testnet.
          </p>
          <div className="cta-row">
            <Link className="btn btn-primary" href="/viewer">
              Open the registry dashboard <span className="btn-arrow">→</span>
            </Link>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap footer-inner">
          <span>
            COBALT — TEE infrastructure for Monad · Trusted for liveness, not{" "}
            <Link href="/trust">correctness</Link>.
          </span>
        </div>
      </footer>
    </div>
  );
}
