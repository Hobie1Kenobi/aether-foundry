/**
 * Public XRPL Testnet constants for the Foundry desk.
 * Addresses from corp/wallets.md — NO seeds, NO private keys.
 * Network: XRPL Testnet ONLY (NOT mainnet).
 */

export const NETWORK_LABEL =
  process.env.NEXT_PUBLIC_NETWORK_LABEL ?? "XRPL Testnet";

const DEFAULT_XRPL_WS = "wss://s.altnet.rippletest.net:51233";
const DEFAULT_XRPL_HTTP = "https://s.altnet.rippletest.net:51234";

export const XRPL_WS = process.env.NEXT_PUBLIC_XRPL_WS ?? DEFAULT_XRPL_WS;

function isMainnetUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host === "ripple.com" || host.endsWith(".ripple.com")) return true;
    if (host === "xrplcluster.com" || host.endsWith(".xrplcluster.com"))
      return true;
    if (host === "xrpl.ws" || host.endsWith(".xrpl.ws")) return true;
    if (host === "xrpl.link" || host.endsWith(".xrpl.link")) return true;
    return false;
  } catch {
    return false;
  }
}

function wsToHttp(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    if (url.protocol === "wss:") url.protocol = "https:";
    else if (url.protocol === "ws:") url.protocol = "http:";
    if (url.port === "51233") url.port = "51234";
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_XRPL_HTTP;
  }
}

function resolveXrplHttp(): string {
  const explicit = process.env.NEXT_PUBLIC_XRPL_HTTP?.trim();
  const candidate =
    explicit && explicit.length > 0 ? explicit : wsToHttp(XRPL_WS);
  if (!candidate || isMainnetUrl(candidate)) return DEFAULT_XRPL_HTTP;
  return candidate.replace(/\/$/, "");
}

/** HTTPS JSON-RPC. Prefers NEXT_PUBLIC_XRPL_HTTP, else maps XRPL_WS :51233 → :51234. */
export const XRPL_HTTP = resolveXrplHttp();

/** AETH currency hex (ASCII "AETH" padded) */
export const AETH_HEX = "4145544800000000000000000000000000000000";

/** NFT taxon for Foundry artifacts */
export const NFT_TAXON = 20260927;

export const WALLETS = {
  W0: {
    id: "W0",
    role: "TREASURY",
    address: "rJ9WRLiHuB6STbRCUqRKVsqKDbrGAbEbVs",
  },
  W1: {
    id: "W1",
    role: "MARKET",
    address: "rsi9kh9Pdkrn16sABjg8yGqZLVuT1qphzS",
  },
  W2: {
    id: "W2",
    role: "ATELIER",
    address: "rLBKyi1NKoXmMXUHPH4ZFZLUKyXfUywKEw",
  },
  W3: {
    id: "W3",
    role: "CHANNELS",
    address: "rB6tyDtACcaihvoHKocuA5snG8H7Hn43Fw",
  },
  W4: {
    id: "W4",
    role: "ESCROW",
    address: "ra9X6T4Fk9qfD8ncKczHaG5GdkYcLcD5pN",
  },
  W5: {
    id: "W5",
    role: "R&D",
    address: "rGpUbsnEjtUijR2WaUGn5W1yDWQ2S9RgKQ",
  },
  W6: {
    id: "W6",
    role: "GRANTS",
    address: "rfnqxYQWKsVGFuWLjky41puXHJkT2v8yTf",
  },
  AMM: {
    id: "AMM",
    role: "AETH/XRP pool",
    address: "r4nTCaJ83W7HX3dHMrLrWTWCkFBeRSrS4w",
  },
  BUYER: {
    id: "BUYER",
    role: "work-ticket client",
    address: "rEbUaXDXZnzR8wJjGqULKn1YLXNd5CARth",
  },
  STRANGER: {
    id: "STRANGER",
    role: "walk-in purchaser",
    address: "rh4c6qMMyafccZrPFCPCN742BNMXfjKYss",
  },
} as const;

export type WalletId = keyof typeof WALLETS;

/** Machine #1-#4 RESULTS hashes (from machines RESULTS.md) — display only */
export const MACHINES = {
  "work-ticket-escrow": {
    number: 1,
    name: "work-ticket-escrow",
    label: "Machine #1 — Work Ticket Escrow",
    readme:
      "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/work-ticket-escrow/README.md",
    hashes: {
      escrowFinish:
        "0F87A94FCCAC7F8E34FB4BEB0E371BD13197A3B1BC16D4FF65437F24E1D003F4",
      escrowCancel:
        "48B66E863CA6989D08F15C052942E674579E5EECDD49AB83EA43C1BDA81FEC4E",
      tokenEscrowFinish:
        "612BD199AB78E7923E4C84226CDB1658ED299E31ACDA3B4BAA193B04543ECFF7",
      tokenEscrowCancel:
        "A37A107E0FA093BA9525F8EEF68E6C51A24B0CCA60B228F7CDD7641BD8D78163",
      nftAccept:
        "07A8CE674CDA95CCBA63B0820806F882FF9F4ED95B99C1574E68B0EA7BF7F187",
    },
  },
  "drip-pass": {
    number: 2,
    name: "drip-pass",
    label: "Machine #2 — Drip Pass",
    readme:
      "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/drip-pass/README.md",
    channelId:
      "DCE8401B0DFFE4031FBB15935D0EC33F72B010C8B89E2F60E6E6AC8B0572E9F5",
    hashes: {
      channelCreate:
        "399C4E825443C3B721F32A18F7B71E53AD2E15784BBCFED010DA4EEBEA378798",
      claim1:
        "09F69401A8A90E5196B3E6C81B8CDA19C8C879F40D1D1163760DFA0FE97F3066",
      claim2:
        "F8EAD6D84E539FC7524BA01163754A43C8E2153E21CC362E0EBD1F7AD413C6D3",
      claim3:
        "E37699492E8F959E45C68E3056B76833D5C146521DDC7A5C3CA35B761ECA7B05",
      channelClose:
        "6DFB44BB86E309F995579E92E2294D8F318A142E83F185FA22AB308A638E7737",
      nftAccept:
        "F4587DDABFD9D1A0290007B28F95FB6FBB98CEC344BF48E5857062BBDDF41C1B",
    },
  },
  "walk-in-window": {
    number: 3,
    name: "walk-in-window",
    label: "Machine #3 — Walk-In Window",
    readme:
      "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/README.md",
    hashes: {
      strangerAccept:
        "7CF0B34F1A2536C55746958B0BF18FB4BE500DD7BBA9FFDA67E16F8C5F23A52F",
      pathPay:
        "BAF7B71ADCC203985D5686B201CE2E1FA94677D73A59428C02C902747E8C1158",
      trustSet:
        "A784D97D6EF6B9E69C754676C7A3D2CFEB6E15B43C852E15B7D60EFBC9FAAFCB",
      checkCash:
        "FC9D24150810549E5FD2E62B0DCAC2BC922445DF34CA71F765F6F9DD9CE4E0EC",
    },
  },
  "oracle-mid-ticket": {
    number: 4,
    name: "oracle-mid-ticket",
    label: "Machine #4 — Oracle Mid-Ticket",
    readme:
      "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/oracle-mid-ticket/README.md",
    nftokenId:
      "000803E8D25E64BC6D436EA502CE71902FE64120C571FCF19A5519C90141DD5B",
    hashes: {
      mint: "BDB214A12685448014153F0A4E7612DFED48964ACEFEEE29F6DAA078E3D55705",
      sell: "298085ADCE0D6C8ED3DB33B25110E6B323C03C34C49DB669F05306268B2BA376",
      accept: "F22A3A9BF15D18ED39E34F49FB8D4FE64CFE8AF52954C066C4EA46B236AF6E33",
      escrowCreate:
        "A45A05F1C01095C27B70902A28EAD49C1D9D8A7100C63BFCEE2053AE0CA6522C",
      escrowFinish:
        "A2D8E84C265DCCDD3E2E7A422B8F60D3439739E7A257154ED857AA7AB380E3A6",
      domainAccountSet:
        "15D20D72A5BECEE3A84998503F8D357B68D321563959497D2FF629A6D0685F76",
    },
  },
} as const;

export const EXPLORER_TX = (hash: string) =>
  `https://testnet.xrpl.org/transactions/${hash}`;

export const EXPLORER_ACCOUNT = (address: string) =>
  `https://testnet.xrpl.org/accounts/${address}`;

export const AETH_IOU = {
  currency: AETH_HEX,
  issuer: WALLETS.W0.address,
} as const;
