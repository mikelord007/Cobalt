import Link from "next/link";
import "./landing.css";

export const metadata = {
  title: "Cobalt — Verifiable Off-Chain Compute",
  description:
    "Cobalt runs application logic inside AWS Nitro Enclaves and verifies the output on Monad. Hardware-enforced correctness, operator-trusted liveness.",
};

/**
 * Landing / marketing page. Ported from landing/index.html. The original file's own
 * <header class="nav"> now lives in the shared root layout (app/components/SiteNav.js)
 * so it's consistent across both routes; everything else below is unchanged copy and
 * structure. The old relative "../viewer/index.html" links are now <Link href="/viewer">.
 */
export default function LandingPage() {
  return (
    <div className="landing-page">
      {/* HERO */}
      <section className="hero">
        <div className="wrap">
          <span className="eyebrow">Verifiable off-chain compute</span>
          <h1>
            Your code runs where <span className="accent">no one can see it</span> — and the
            chain believes it anyway.
          </h1>
          <p className="sub">
            Cobalt deploys application logic into AWS Nitro Enclaves and cryptographically
            verifies the enclave&apos;s output on Monad. Not even root on the host machine can
            see inside the enclave or forge what it signs.
          </p>
          <div className="cta-row">
            <Link className="btn btn-primary" href="/viewer">
              Open the registry dashboard <span className="btn-arrow">→</span>
            </Link>
            <span className="cta-note">live on Monad testnet · chain 10143</span>
          </div>
          <div className="hero-meta">
            <div className="item">
              <span className="chip">CLI</span>
              <strong>cobalt deploy &lt;app-dir&gt;</strong>
            </div>
            <div className="item">Multi-tenant registry — one contract, any number of apps</div>
            <div className="item">Real AWS hardware attestation, not a simulation</div>
          </div>
        </div>
      </section>

      {/* TRUST MODEL */}
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
          <p className="trust-note">
            This is a stated design boundary, not a gap we&apos;re hoping you won&apos;t
            notice — a system that is honest about what it doesn&apos;t solve is one
            that&apos;s actually understood.
          </p>
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
              <p>
                The Nitro Enclave boots your app&apos;s logic and produces a hardware-signed
                attestation document naming the exact code measurement (PCR0) running inside
                it.
              </p>
            </div>
            <div className="step">
              <div className="num">02</div>
              <h3>Contract verifies on-chain</h3>
              <p>
                A &quot;hinted&quot; cryptographic construction lets the registry perform a
                P-384 / X.509 attestation check — normally too expensive to verify on-chain —
                in just a few transactions.
              </p>
            </div>
            <div className="step">
              <div className="num">03</div>
              <h3>Signer becomes trusted</h3>
              <p>
                Once the attestation verifies, the enclave&apos;s signing key is registered
                on-chain as authorized to sign results for that exact code image — and no
                other.
              </p>
            </div>
            <div className="step">
              <div className="num">04</div>
              <h3>App logic runs, verified</h3>
              <p>
                The enclave executes your application and signs its output. The chain accepts
                the result because it already knows precisely what code produced it.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* PULLQUOTE */}
      <section className="pullquote-section">
        <div className="wrap">
          <span className="eyebrow">Tamper-evidence</span>
          <div className="pullquote">
            <p>The code cannot lie about what it is.</p>
          </div>
          <p className="pullquote-sub">
            Rebuild the enclave&apos;s code with the logic tampered in any way — one changed
            line, one swapped dependency — and the resulting cryptographic measurement
            changes. The on-chain registry rejects the new image outright. There is no version
            of the running code that can misrepresent itself to the chain.
          </p>
          <div className="reject-example">
            <span className="x">✗</span>
            <span className="label">registerImage(pcr0)</span>
            <span className="hash">0x7f2a19...e04c</span>
            <span className="label">— measurement not recognized, reverted</span>
          </div>
        </div>
      </section>

      {/* TERMINAL */}
      <section className="terminal-section">
        <div className="wrap">
          <span className="eyebrow">Not a mockup</span>
          <h2>One command, a real enclave, a real on-chain result</h2>
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

          <div className="strip">
            <div className="cell">
              <span className="big">10143</span>
              <span className="lbl">Monad testnet chain ID</span>
            </div>
            <div className="cell">
              <span className="big">1</span>
              <span className="lbl">command to deploy an app</span>
            </div>
            <div className="cell">
              <span className="big">N</span>
              <span className="lbl">apps per registry, no redeploy</span>
            </div>
          </div>
        </div>
      </section>

      {/* EXAMPLE */}
      <section className="example">
        <div className="wrap">
          <div className="example-grid">
            <div>
              <span className="eyebrow">Why this matters</span>
              <h2>The sealed-bid auction problem</h2>
              <p className="lede">
                A Vickrey auction is impossible to run trustlessly on-chain by conventional
                means: whoever can see every bid before the auction closes can insert a fake
                losing bid just under the real winner&apos;s, inflating the price the winner
                pays. Someone always has to be trusted not to peek.
              </p>
            </div>
            <div className="example-card">
              <span className="k">With a TEE</span>
              <p>
                Bids are decrypted and compared only inside the enclave. No operator,
                auctioneer, or validator ever sees them — including the one running the
                hardware. The chain trusts the winning result because it can verify exactly
                which code computed it, not because it trusts a person to have looked away.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CLOSING */}
      <section className="closing">
        <div className="wrap">
          <span className="eyebrow">This is running right now</span>
          <h2>Real hardware. Real chain. Live today.</h2>
          <p className="sub">
            This isn&apos;t a concept deck — it&apos;s genuinely deployed on Monad testnet:
            real AWS Nitro Enclave attestation, a real EC2-hosted enclave, a real Solidity
            registry contract, and a real signed round-trip verified on-chain.
          </p>
          <div className="cta-row">
            <Link className="btn btn-primary" href="/viewer">
              View live deployments <span className="btn-arrow">→</span>
            </Link>
            <Link className="btn btn-secondary" href="/viewer">
              Open the registry dashboard
            </Link>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap footer-inner">
          <span>COBALT — verifiable off-chain compute on Monad</span>
          <span>
            <Link href="/viewer">registry dashboard</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
