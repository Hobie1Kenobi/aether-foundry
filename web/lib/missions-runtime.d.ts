export function ledgerDir(): string | null;
export function loadMissionStatus(now?: string): Promise<Record<string, unknown>>;
export function loadMissionRoute(
  route: string,
  id?: string,
  now?: string
): Promise<{ status: number; body: Record<string, unknown> }>;
