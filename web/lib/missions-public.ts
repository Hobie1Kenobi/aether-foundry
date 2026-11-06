import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadMissionRoute, loadMissionStatus } = require("./missions-runtime.js") as {
  loadMissionRoute: (route: string, id?: string, now?: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  loadMissionStatus: (now?: string) => Promise<Record<string, unknown>>;
};

export type MissionStatus = {
  ok?: boolean;
  spending_enabled: boolean;
  spending_enabled_source?: string;
  signing_enabled: boolean;
  authorized_per_mission_drops: string;
  authorized_daily_drops: string;
  authorized_per_mission_xrp?: string;
  authorized_daily_xrp?: string;
  timezone: string;
  live_spend_drops: string | null;
  live_spend_xrp?: string | null;
  reserved_drops?: string | null;
  uncertain_drops?: string | null;
  accounted_spent_drops?: string | null;
  source: string;
  source_observed_at: string | null;
  stale?: boolean;
  killed?: boolean;
  note?: string;
  missions?: Array<{ id: string; status: string; rationale?: string; settlement?: string | null }>;
};

export async function missionStatus(now?: string): Promise<MissionStatus> {
  return (await loadMissionStatus(now)) as MissionStatus;
}

export async function missionRoute(route: string, id?: string, now?: string) {
  return (await loadMissionRoute(route, id, now)) as {
    status: number;
    body: MissionStatus & { code?: string; error?: string };
  };
}

export async function publicMissionResponse(method: string, route: string, id?: string) {
  if (method !== "GET") {
    return {
      status: 405,
      body: {
        ok: false,
        code: "PUBLIC_WRITE",
        error: "public mission routes are read-only",
        signed: false,
        submitted: false,
      },
    };
  }
  return missionRoute(route, id);
}
