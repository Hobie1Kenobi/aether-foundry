export const TESTNET_ORIGIN: string;
export const TESTNET_HOST: string;
export const NETWORK: "xrpl:1";
export const NETWORK_ID: 1;
export const LABELED: string[];

export function publicFacilitator(env?: Record<string, string | undefined>): {
  mode: "self-verify" | "dual" | "refused";
  host: string | null;
  url: string | null;
  network: "xrpl:1";
  networkId: 1;
  advertised: string;
  settles: false;
  verifyOnly: true;
  remoteVerify: boolean;
  code?: string;
  error?: string;
};

export function facilitatorEnv(env?: Record<string, string | undefined>): {
  XRPL_FACILITATOR_URL: string | undefined;
  XRPL_NETWORK: string | undefined;
};

export function verifyDeskPayment(args: {
  header: string;
  sku: import("./x402-rules").Sku;
  lookupTx: (hash: string) => Promise<
    | { found: true; tx: Record<string, unknown> }
    | { found: false; code?: string; error?: string }
  >;
  hashSignedTx?: (blob: string) => string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}): Promise<
  | (import("./x402-rules").ProofSuccess & { via?: string })
  | (import("./x402-rules").ProofFailure & {
      via?: string;
      facilitatorVerified?: boolean;
    })
>;
