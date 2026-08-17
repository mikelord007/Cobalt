import ViewerDashboard from "./ViewerDashboard";

export const metadata = {
  title: "Cobalt Enclave Registry Viewer",
  description:
    "Live, read-only view of Cobalt's on-chain enclave registry on Monad testnet: registered apps, allowed images, and signer state.",
  openGraph: {
    title: "Cobalt Enclave Registry Viewer",
    description: "Live, read-only view of Cobalt's on-chain enclave registry on Monad testnet.",
  },
  // Twitter Cards don't inherit from openGraph -- without its own `twitter` block, a route falls
  // all the way back to the root layout's generic title/description instead of its own.
  twitter: {
    title: "Cobalt Enclave Registry Viewer",
    description: "Live, read-only view of Cobalt's on-chain enclave registry on Monad testnet.",
  },
  alternates: { canonical: "/viewer" },
};

export default function ViewerPage() {
  return <ViewerDashboard />;
}
