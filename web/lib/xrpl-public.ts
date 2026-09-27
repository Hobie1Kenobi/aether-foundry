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

/**
 * Foundry anchors. The outbound payer refuses every address in this object.
 * Do not add the foreign x402 counterparty here.
 */
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

/**
 * W6 grants flywheel. Read-only desk copy. No trial hash until tesSUCCESS.
 * The desk does not sign.
 */
export const GRANTS_FLYWHEEL = {
  slug: "grants-flywheel",
  label: "W6 Grants Flywheel",
  payer: WALLETS.W6.address,
  defaultDrops: "1000000",
  readme:
    "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/grants-flywheel/README.md",
  runbook:
    "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/grants-flywheel/RUNBOOK.md",
  scanCommand: "npm run grants:scan",
  payCommand: "npm run grants:pay -- --dry-run",
} as const;

export type WalletId = keyof typeof WALLETS;

/** Machine #1-#5 RESULTS hashes (from machines RESULTS.md) — display only */
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
    inbound:
      "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/INBOUND.md",
    inboundSection:
      "https://github.com/Hobie1Kenobi/aether-foundry/blob/main/machines/walk-in-window/INBOUND.md#one-click-buy",
    runbook:
      "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/walk-in-window/RUNBOOK.md",
    buyCommand: "npm run buy:walk-in",
    /**
     * v2 standing storefront at listing time.
     * The desk fetches live W2 sell offers; these IDs go stale after a sale and remint.
     */
    storefrontV2: {
      label: "v2 standing",
      nftokenId:
        "000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1C81EFBC70141DD5D",
      offerId:
        "08F7769F074C8C80C4DD6A691D2CEE3A3996458D845DA3C15F62BBAF699421B0",
      priceDrops: "10000000",
    },
    hashes: {
      strangerAccept:
        "7CF0B34F1A2536C55746958B0BF18FB4BE500DD7BBA9FFDA67E16F8C5F23A52F",
      pathPay:
        "BAF7B71ADCC203985D5686B201CE2E1FA94677D73A59428C02C902747E8C1158",
      trustSet:
        "A784D97D6EF6B9E69C754676C7A3D2CFEB6E15B43C852E15B7D60EFBC9FAAFCB",
      checkCash:
        "FC9D24150810549E5FD2E62B0DCAC2BC922445DF34CA71F765F6F9DD9CE4E0EC",
      mintV2:
        "DC7609E1331198731F7C0B2E58378C39F4F11511F40337DB3A4C865F00368E10",
      createOfferV2:
        "2C013A0988DA6610B088D72B8E6F0378CFF52E9D7CB2ED2B181D3546318DDDBC",
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
  "lp-badge": {
    number: 5,
    name: "lp-badge",
    label: "Machine #5 — LP Badge",
    readme:
      "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/lp-badge/README.md",
    nftokenId:
      "000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1B3732AC80141DD5C",
    honorSystem: true,
    lpThreshold: 100000,
    hashes: {
      mint: "A8185AFA42F082A85792D3AF534A852B7060726D44A29420C14DD4A673E36E5C",
      createOffer:
        "D7E6B0E9A5E3F087FB51C6F977590A88A6EE768DE4454F4FFC7D861D9835D4C7",
      accept: "A2956F443B10810E1273A4334DA815599570B186266390D77BEEEDB4648823D1",
    },
  },
} as const;

/**
 * LP Badge v1 door. XRPL Testnet credential gate, not the v0 NFT.
 * Addresses and hashes are filled after the trial. Read-only.
 */
export const LP_BADGE_BOUND = {
  network: "XRPL Testnet",
  amendment: "Credentials",
  amendmentId:
    "1CB67D082CF7D9102412D34258CEDB400E659352D3B207348889297A6D90F5EF",
  hooksOnXrplTestnet: false,
  honorSystem: false,
  credentialType: "aether-lp-ok",
  lpThreshold: "1000",
  amm: WALLETS.AMM.address,
  v0NftokenId:
    "000803E8D25E64BC6D436EA502CE71902FE64120C571FCF1B3732AC80141DD5C",
  readme:
    "https://raw.githubusercontent.com/Hobie1Kenobi/aether-foundry/main/machines/lp-badge-bound/README.md",
  issuer: "rPXJrQEJN2K9grJJBqQHQ2V5nazcZQo5Cn",
  holder: "rLDbAi71mciJwCDKyTn6dohD3ypDsMLRwm",
  door: "r3UBPs7Lakfic2Mjq2QcgSqwfn6iYVGtFQ",
  stranger: "rUpVvDQWBQVvrdazFZfb6E7DPmoafN2jNj",
  credentialId:
    "CF1E832E647C8B753B29D848651494AC64D6E5B7E3D3820F65EE7EFCCC2FB935",
  hashes: {
    strangerFail:
      "27AE8639E52729C1085D9D36C8E36145450502F580E4D0894804DCC01B1C6C92",
    holderBareFail:
      "311CBEA7D2008ADE45093067A4536CE771DCD55439D930BD128F953C684DE944",
    holderPass:
      "D21E08CC086310E2FA15B1F0E717FEF406F8BD3EF29ED5137AE9ACC64875FED2",
    holderRevokedFail:
      "919C1C7721EB178EBD4BC95DE35817D0F5410E3F5EA7FB6C08EE4CCA4437EE48",
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

/**
 * Xahau Testnet W7. Not an XRPL Testnet account.
 * Kept out of WALLETS so the desk does not account_info it on rippletest.
 */
export const XAHAU_W7 = {
  network: "Xahau Testnet",
  networkId: 21338,
  ws: "wss://xahau-test.net",
  rpc: "https://xahau-test.net",
  address: "r9YjdAzgL4hHvqDUeb4sTf4yF2MDQ5kq7h",
  hookHash: "B9B6A6D5DDCF4212CC046217500AB3D90D54C7E63684F98E7991F4EBA9BC6C09",
  setHookHash: "7DBFE10ECFFDB2ACE8D83CA570ECF64F64712DBDE962B9C6756F83E655273447",
  trialHash: "E6142FB0B82375A01D7E07A3AF0046B6030F4CC34BCB9C3B0A2148E3ED9EEBD6",
  destinations: [
    { role: "MARKET 40%", address: "rUV6zDW72xLRWtECfAivjfQ67EXUE5cq38" },
    { role: "ATELIER 25%", address: "rU98zDxthCRjoQLURzhrPJoo2t851gvExk" },
    { role: "R&D 20%", address: "rB5jFnmc7BdBAJdquSMwhkTKjJaJGfnB8m" },
    { role: "GRANTS 10%", address: "rHjzEwwBAB7BRwfjFMVGsmGduEahSCPkBh" },
    { role: "SINK remainder", address: "rLwvjUEuSBe8PByEnpwWxUryG4KRCXqt6K" },
  ],
} as const;
