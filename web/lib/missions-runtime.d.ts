export function ledgerDir(): string | null;
export function loadMissionStatus(now?: string): Record<string, unknown>;
export function loadMissionRoute(
  route: string,
  id?: string,
  now?: string
): { status: number; body: Record<string, unknown> };
