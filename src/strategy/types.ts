import type { BeastType } from "../data/beasts.js";
import type { ApiBeast } from "../api/types.js";

export type EnrichedBeast = ApiBeast & {
  type: BeastType;
  tier: number;
  name: string;
  fullName: string;
  basePower: number;
  isAlive: boolean;
  cooldownEndsAt: number;
};

export type ScoredBeast = EnrichedBeast & {
  score: number;
  typeAdvantage: number;
  reason: string;
};

export type ActionType = "attack" | "claim_rewards" | "claim_quest_rewards" | "wait";

export type AgentAction = {
  type: ActionType;
  reason: string;
  beasts?: ScoredBeast[];
  payload?: Record<string, unknown>;
};

export type GameSnapshot = {
  summitHolder: EnrichedBeast | null;
  ourBeasts: EnrichedBeast[];
  timestamp: number;
};
