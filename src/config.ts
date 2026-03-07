import { z } from "zod";
import { readFileSync } from "fs";

export const ConfigSchema = z.object({
  account: z.object({
    username: z.string().min(1),
    controllerAddress: z.string().min(1),
  }),
  chain: z.object({
    rpcUrl: z.string().default("https://api.cartridge.gg/x/starknet/mainnet/rpc/v0_9"),
    summitContract: z.string().default("0x01aa95ea66e7e01acf7dc3fda8be0d8661230c4c36b0169e2bab8ab4d6700dfc"),
    beastContract: z.string().default("0x046da8955829adf2bda310099a0063451923f02e648cf25a1203aac6335cf0e4"),
    accountClassHash: z.string().default("0x743c83c41ce99ad470aa308823f417b2141e02e04571f5c0004e743556e7faf"),
    txWaitRetries: z.number().int().positive().default(80),
    txWaitIntervalMs: z.number().int().positive().default(1500),
  }),
  api: z.object({
    baseUrl: z.string().default("https://summit-production-69ed.up.railway.app"),
    wsUrl: z.string().default("wss://summit-production-69ed.up.railway.app/ws"),
    pollIntervalMs: z.number().int().positive().default(30_000),
  }),
  strategy: z.object({
    conservativeMode: z.boolean().default(false),
    experimentMode: z.boolean().default(false),
    experimentExplorePerProfile: z.number().int().positive().default(2),
    avoidTypeDisadvantage: z.boolean().default(true),
    requireTypeAdvantage: z.boolean().default(false),
    minScoreToAttack: z.number().default(10),
    claimRewardThreshold: z.number().default(0.001),
    maxGasCostStrk: z.number().default(0.1),
    attackCooldownMs: z.number().int().default(30_000),
    ownerBeastsRefreshMs: z.number().int().positive().default(30_000),
    useAttackPotions: z.boolean().default(true),
    attackPotionsPerBeast: z.number().int().default(5),
    requireAttackPotionsForAllAttacks: z.boolean().default(false),
    pauseOnAttackPotionDepleted: z.boolean().default(true),
    useExtraLifePotions: z.boolean().default(false),
    extraLifePotionsPerAttack: z.number().int().nonnegative().default(1),
    extraLifeOnlyForHoldQuest: z.boolean().default(true),
    extraLifeMinScore: z.number().default(300),
    extraLifeMinTypeAdvantage: z.number().min(1).max(1.5).default(1),
    attackCountPerBeast: z.number().int().positive().default(1),
    useRevivalPotions: z.boolean().default(true),
    maxRevivalPotionsPerBeast: z.number().int().nonnegative().max(75).default(10),
    protectedOwners: z.array(z.string()).default([]),
    friendlyPlayers: z.array(z.object({
      name: z.string().default(""),
      address: z.string().min(1),
    })).default([]),
    protectedOwnersRefreshMs: z.number().int().positive().default(300_000),
    attackStreakTarget: z.number().int().nonnegative().max(10).default(10),
    growingStrongerTargetLevels: z.number().int().nonnegative().max(10).default(1),
    rotateWhileHoldingForQuests: z.boolean().default(false),
    rotateHoldSeconds: z.number().int().nonnegative().default(10),
    burstEnabled: z.boolean().default(true),
    burstExtraLivesThreshold: z.number().int().nonnegative().default(10),
    burstAttackCountPerBeast: z.number().int().positive().default(5),
    burstAttackPotionsPerBeast: z.number().int().nonnegative().default(3),
    burstMinTypeAdvantage: z.number().min(1).max(1.5).default(1.5),
    usePoisonOnHighExtraLives: z.boolean().default(false),
    poisonHolderExtraLivesThreshold: z.number().int().nonnegative().default(1),
    poisonCountPerCast: z.number().int().positive().default(1),
    poisonExtraLivesMultiplier: z.number().int().min(1).max(3).default(1),
    poisonCooldownMs: z.number().int().positive().default(20_000),
    sendAllBeasts: z.boolean().default(true),
    maxBeastsProfiles: z.object({
      focused: z.number().int().positive().default(8),
      balanced: z.number().int().positive().default(12),
      swarm: z.number().int().positive().default(24),
    }).default({
      focused: 8,
      balanced: 12,
      swarm: 24,
    }),
    maxBeastsPerAttack: z.number().int().positive().default(30),
  }),
  session: z.object({
    file: z.string().default("./data/userprofile/session.json"),
    dirName: z.string().default("cartridge-session"),
  }),
  logging: z.object({
    eventsFile: z.string().default("./data/userprofile/events.jsonl"),
  }),
});

export type FenrirConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): FenrirConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return ConfigSchema.parse(raw);
}
