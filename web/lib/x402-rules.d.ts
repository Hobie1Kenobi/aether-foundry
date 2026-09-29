export const NETWORK: "xrpl:1";
export const MAINNET: "xrpl:0";
export const PAY_TO: string;
export const MAX_TIMEOUT_SECONDS: number;

export type Sku = {
  id: string;
  title: string;
  description: string;
  drops: string;
  xrp: string;
  sourceTag: number;
  path: string;
};

export function listSkus(): Sku[];
export function getSku(id: string): Sku | null;
export function newInvoiceId(skuId: string): string;
export function encodeHeader(obj: unknown): string;
export function decodeHeader(value: string): unknown;
export function sha256Hex(text: string): string;

export function buildPaymentRequired(args: {
  sku: Sku;
  resourceUrl: string;
  invoiceId: string;
  error?: string;
}): {
  x402Version: number;
  error: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: Array<{
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: {
      sourceTag: number;
      invoiceId: string;
      paymentFlow: string;
      assetTransferMethod: string;
    };
  }>;
  extensions: Record<string, never>;
};

export function howToPay(
  sku: Sku,
  invoiceId: string,
  env?: Record<string, string | undefined>
): Record<string, unknown>;

export type ProofFailure = {
  ok: false;
  code: string;
  error: string;
  txHash?: string;
  invoiceId?: string | null;
};

export type ProofSuccess = {
  ok: true;
  hash: string;
  payer: string;
  invoiceId: string;
  ledgerIndex: number | null;
  amountDrops: string;
};

export function verifyPaymentProof(args: {
  header: string;
  sku: Sku;
  lookupTx: (hash: string) => Promise<
    | { found: true; tx: Record<string, unknown> }
    | { found: false; code?: string; error?: string }
  >;
  hashSignedTx?: (blob: string) => string;
}): Promise<ProofSuccess | ProofFailure>;

export function buildMachineSpec(
  prompt: string,
  anchors?: {
    w0?: string;
    w1?: string;
    w3?: string;
    amm?: string;
    aethHex?: string;
  }
): {
  sku: "machine-spec";
  network: "xrpl:1";
  slug: string;
  title: string;
  prompt: string;
  prompt_truncated: boolean;
  grid_refused: boolean;
  primitives: string[];
  files: {
    "README.md": string;
    "PRIMITIVES.md": string;
    "ECONOMICS.md": string;
  };
};
