import feed from "../../machines/missions/public-feed.json" with { type: "json" };

export type PublicMission = {
  id: string;
  status: string;
  code?: string | null;
  stage?: string;
  rationale?: string;
  settlement?: string | null;
  live?: boolean;
  proof_hash?: string | null;
  explorer?: string | null;
};

export type PublicMissionFeed = Omit<typeof feed, "missions"> & { missions: PublicMission[] };

export function missionFeed(): PublicMissionFeed {
  return feed as PublicMissionFeed;
}

export function publicMissionResponse(method: string, route: string, id?: string) {
  if (method !== "GET") {
    return {
      status: 405,
      body: {
        ok: false,
        code: "PUBLIC_WRITE",
        error: "public mission routes are read-only",
        spending_enabled: false,
        signing_enabled: false,
        signed: false,
        submitted: false,
        live_spend_drops: "0",
      },
    };
  }
  if (route === "status") {
    return {
      status: 200,
      body: {
        ok: true,
        spending_enabled: feed.spending_enabled,
        signing_enabled: feed.signing_enabled,
        authorized_per_mission_drops: feed.authorized_per_mission_drops,
        authorized_daily_drops: feed.authorized_daily_drops,
        authorized_per_mission_xrp: feed.authorized_per_mission_xrp,
        authorized_daily_xrp: feed.authorized_daily_xrp,
        timezone: feed.timezone,
        live_spend_drops: feed.live_spend_drops,
        live_spend_xrp: feed.live_spend_xrp,
        source: feed.source,
        source_observed_at: feed.source_observed_at,
        killed: feed.killed,
        note: feed.note,
      },
    };
  }
  const mission = (feed.missions as PublicMission[]).find((item) => item.id === id);
  if (route === "detail" || route === "replay") {
    if (!mission) {
      return { status: 404, body: { ok: false, code: "NOT_FOUND", error: "mission not found" } };
    }
    if (route === "replay") {
      return { status: 200, body: { schema: "aether.missions.replay", id, events: [] } };
    }
    return { status: 200, body: { schema: "aether.missions.detail", mission } };
  }
  return { status: 200, body: feed };
}
