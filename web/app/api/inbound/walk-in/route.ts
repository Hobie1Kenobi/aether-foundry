import { MACHINES, WALLETS, XRPL_HTTP } from "@/lib/xrpl-public";
import { fetchWalkInSellOffers } from "@/lib/xrpl-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BUY = "npm run buy:walk-in";

/**
 * Seedless Walk-In status for agents. Testnet HTTP only.
 * The desk does not sign and does not accept the offer.
 */
export async function GET() {
  const machine = MACHINES["walk-in-window"];
  const snapshot = await fetchWalkInSellOffers(WALLETS.W2.address);
  const status =
    snapshot.status === "OPEN"
      ? "open"
      : snapshot.status === "SOLD OUT"
        ? "sold_out"
        : "error";
  const body = {
    network: "XRPL Testnet",
    networkId: 1,
    rpc: XRPL_HTTP,
    seller: WALLETS.W2.address,
    status,
    offers: snapshot.offers.map((offer) => ({
      offerId: offer.offerId,
      nftokenId: offer.nftokenId,
      amount: offer.amountLabel,
      priceXrp: offer.priceXrp,
      owner: offer.owner,
    })),
    signing: "none",
    deskSigns: false,
    npm: BUY,
    howToBuy: [
      `${BUY} -- --dry-run`,
      `${BUY} -- --faucet`,
      `WALKIN_BUYER_SEED=... ${BUY} -- --record`,
    ],
    aeth: `${BUY} -- --faucet --with-aeth`,
    soldOutExitCode: 3,
    docs: {
      inbound: machine.inbound,
      inboundSection: machine.inboundSection,
      runbook: machine.runbook,
    },
    recordedOfferId: machine.storefrontV2.offerId,
    recordedOfferNote:
      "The published OfferID can be stale. Buy offers[0].offerId from this response.",
    error: snapshot.error ?? null,
  };
  return Response.json(body, {
    status: status === "error" ? 502 : 200,
    headers: {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
