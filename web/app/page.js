import Link from "next/link";
import InstallCommand from "./components/InstallCommand";
import "./landing.css";

export const metadata = {
  title: "Cobalt — Verifiable Off-Chain Compute",
  description:
    "Cobalt runs application logic inside AWS Nitro Enclaves and verifies the output on Monad. Hardware-enforced correctness, operator-trusted liveness.",
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
          <span className="eyebrow">Verifiable off-chain compute</span>
          <h1>
            Your code runs where <span className="accent">no one can see it</span>. The chain
            believes it anyway.
          </h1>
          <p className="sub">
            One command deploys your app into an AWS Nitro Enclave. Monad verifies which code
            ran.
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
          <h2>One command. Real hardware.</h2>
          <div className="terminal">
            <div className="terminal-bar">
              <span className="dot"></span>
              <span className="dot"></span>
              <span className="dot"></span>
            </div>
            <div className="terminal-body">
              <span className="prompt">$ </span>
              <span className="cmd">cobalt deploy examples/ping --secrets env.json</span>
              {"\n"}
              <span className="dim">    launching Nitro Enclave on EC2...</span>
              {"\n"}
              <span className="out">==&gt; attestation ready: eth_address 0x91c9...c92f8</span>
              {"\n"}
              <span className="out">    pcr0 b423123987...5d5d6fdf</span>
              {"\n"}
              <span className="ok">✓ registered on Monad testnet (chain 10143)</span>
              {"\n"}
              <span className="ok">✓ isValidSigner: true</span>
              {"\n"}
              <span className="dim">    app live — awaiting signed results</span>
            </div>
          </div>
          <p className="terminal-note">Real AWS attestation, not a simulation.</p>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="steps">
        <div className="wrap">
          <span className="eyebrow">How it works</span>
          <h2>From code to a result the chain will accept</h2>
          <div className="steps-grid">
            <div className="step">
              <div className="num">01</div>
              <h3>Enclave attests</h3>
              <p>Hardware signs the exact code measurement running inside.</p>
            </div>
            <div className="step">
              <div className="num">02</div>
              <h3>Contract verifies</h3>
              <p>A hinted P-384 construction makes the check fit on-chain.</p>
            </div>
            <div className="step">
              <div className="num">03</div>
              <h3>Signer registered</h3>
              <p>That key is now authorized for that code image, and no other.</p>
            </div>
            <div className="step">
              <div className="num">04</div>
              <h3>Results accepted</h3>
              <p>The chain knows precisely what produced them.</p>
            </div>
          </div>
          <p className="steps-note">
            Sealed-bid auctions, private order flow, confidential AI — anything where someone
            currently has to be trusted not to peek.
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
            The registry rejects it.
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
          <h2>Running right now.</h2>
          <p className="sub">
            Real enclave, real attestation, real Solidity registry, verified on Monad testnet.
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
            COBALT · Trusted for liveness, not <Link href="/trust">correctness</Link>.
          </span>
        </div>
      </footer>
    </div>
  );
}
