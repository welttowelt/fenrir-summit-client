export type BeastType = "Magic" | "Hunter" | "Brute";

interface BeastMeta {
  id: number;
  name: string;
  type: BeastType;
  tier: number;
}

const BEASTS: BeastMeta[] = [
  { id: 1, name: "Warlock", type: "Magic", tier: 1 },
  { id: 2, name: "Typhon", type: "Magic", tier: 1 },
  { id: 3, name: "Jiangshi", type: "Magic", tier: 1 },
  { id: 4, name: "Anansi", type: "Magic", tier: 1 },
  { id: 5, name: "Basilisk", type: "Magic", tier: 1 },
  { id: 6, name: "Gorgon", type: "Magic", tier: 2 },
  { id: 7, name: "Kitsune", type: "Magic", tier: 2 },
  { id: 8, name: "Lich", type: "Magic", tier: 2 },
  { id: 9, name: "Chimera", type: "Magic", tier: 2 },
  { id: 10, name: "Wendigo", type: "Magic", tier: 2 },
  { id: 11, name: "Rakshasa", type: "Magic", tier: 3 },
  { id: 12, name: "Werewolf", type: "Magic", tier: 3 },
  { id: 13, name: "Banshee", type: "Magic", tier: 3 },
  { id: 14, name: "Draugr", type: "Magic", tier: 3 },
  { id: 15, name: "Vampire", type: "Magic", tier: 3 },
  { id: 16, name: "Goblin", type: "Magic", tier: 4 },
  { id: 17, name: "Ghoul", type: "Magic", tier: 4 },
  { id: 18, name: "Wraith", type: "Magic", tier: 4 },
  { id: 19, name: "Sprite", type: "Magic", tier: 4 },
  { id: 20, name: "Kappa", type: "Magic", tier: 4 },
  { id: 21, name: "Fairy", type: "Magic", tier: 5 },
  { id: 22, name: "Leprechaun", type: "Magic", tier: 5 },
  { id: 23, name: "Kelpie", type: "Magic", tier: 5 },
  { id: 24, name: "Pixie", type: "Magic", tier: 5 },
  { id: 25, name: "Gnome", type: "Magic", tier: 5 },
  { id: 26, name: "Griffin", type: "Hunter", tier: 1 },
  { id: 27, name: "Manticore", type: "Hunter", tier: 1 },
  { id: 28, name: "Phoenix", type: "Hunter", tier: 1 },
  { id: 29, name: "Dragon", type: "Hunter", tier: 1 },
  { id: 30, name: "Minotaur", type: "Hunter", tier: 1 },
  { id: 31, name: "Qilin", type: "Hunter", tier: 2 },
  { id: 32, name: "Ammit", type: "Hunter", tier: 2 },
  { id: 33, name: "Nue", type: "Hunter", tier: 2 },
  { id: 34, name: "Skinwalker", type: "Hunter", tier: 2 },
  { id: 35, name: "Chupacabra", type: "Hunter", tier: 2 },
  { id: 36, name: "Weretiger", type: "Hunter", tier: 3 },
  { id: 37, name: "Wyvern", type: "Hunter", tier: 3 },
  { id: 38, name: "Roc", type: "Hunter", tier: 3 },
  { id: 39, name: "Harpy", type: "Hunter", tier: 3 },
  { id: 40, name: "Hippogriff", type: "Hunter", tier: 3 },
  { id: 41, name: "Fenrir", type: "Hunter", tier: 4 },
  { id: 42, name: "Jaguar", type: "Hunter", tier: 4 },
  { id: 43, name: "Satori", type: "Hunter", tier: 4 },
  { id: 44, name: "Direwolf", type: "Hunter", tier: 4 },
  { id: 45, name: "Bear", type: "Hunter", tier: 4 },
  { id: 46, name: "Wolf", type: "Hunter", tier: 5 },
  { id: 47, name: "Mantis", type: "Hunter", tier: 5 },
  { id: 48, name: "Spider", type: "Hunter", tier: 5 },
  { id: 49, name: "Rat", type: "Hunter", tier: 5 },
  { id: 50, name: "Kraken", type: "Hunter", tier: 5 },
  { id: 51, name: "Colossus", type: "Brute", tier: 1 },
  { id: 52, name: "Balrog", type: "Brute", tier: 1 },
  { id: 53, name: "Leviathan", type: "Brute", tier: 1 },
  { id: 54, name: "Tarrasque", type: "Brute", tier: 1 },
  { id: 55, name: "Titan", type: "Brute", tier: 1 },
  { id: 56, name: "Nephilim", type: "Brute", tier: 2 },
  { id: 57, name: "Behemoth", type: "Brute", tier: 2 },
  { id: 58, name: "Hydra", type: "Brute", tier: 2 },
  { id: 59, name: "Juggernaut", type: "Brute", tier: 2 },
  { id: 60, name: "Oni", type: "Brute", tier: 2 },
  { id: 61, name: "Jotunn", type: "Brute", tier: 3 },
  { id: 62, name: "Ettin", type: "Brute", tier: 3 },
  { id: 63, name: "Cyclops", type: "Brute", tier: 3 },
  { id: 64, name: "Giant", type: "Brute", tier: 3 },
  { id: 65, name: "Ogre", type: "Brute", tier: 3 },
  { id: 66, name: "Orc", type: "Brute", tier: 4 },
  { id: 67, name: "Skeleton", type: "Brute", tier: 4 },
  { id: 68, name: "Golem", type: "Brute", tier: 4 },
  { id: 69, name: "Yeti", type: "Brute", tier: 4 },
  { id: 70, name: "Troll", type: "Brute", tier: 4 },
  { id: 71, name: "Berserker", type: "Brute", tier: 5 },
  { id: 72, name: "Gremlin", type: "Brute", tier: 5 },
  { id: 73, name: "Druid", type: "Brute", tier: 5 },
  { id: 74, name: "Ent", type: "Brute", tier: 5 },
  { id: 75, name: "Goblin", type: "Brute", tier: 5 },
];

const PREFIXES: Record<number, string> = {
  1: "Agony", 2: "Apocalypse", 3: "Armageddon", 4: "Beast", 5: "Behemoth",
  6: "Blight", 7: "Blood", 8: "Bramble", 9: "Brimstone", 10: "Brood",
  11: "Carrion", 12: "Cataclysm", 13: "Chimeric", 14: "Corpse", 15: "Corruption",
  16: "Damnation", 17: "Death", 18: "Demon", 19: "Dire", 20: "Dragon",
  21: "Dread", 22: "Doom", 23: "Dusk", 24: "Eagle", 25: "Empyrean",
  26: "Fate", 27: "Foe", 28: "Gale", 29: "Ghoul", 30: "Gloom",
  31: "Glyph", 32: "Golem", 33: "Grim", 34: "Havoc", 35: "Honour",
  36: "Horror", 37: "Hypnotic", 38: "Kraken", 39: "Loath", 40: "Maelstrom",
  41: "Mind", 42: "Miracle", 43: "Morbid", 44: "Oblivion", 45: "Onslaught",
  46: "Pain", 47: "Pandemonium", 48: "Phoenix", 49: "Plague", 50: "Rage",
  51: "Rapture", 52: "Rune", 53: "Skull", 54: "Sol", 55: "Soul",
  56: "Sorrow", 57: "Spirit", 58: "Storm", 59: "Tempest", 60: "Torment",
  61: "Vengeance", 62: "Victory", 63: "Viper", 64: "Woe", 65: "Wrath",
  66: "Lights", 67: "Shimmering",
};

const SUFFIXES: Record<number, string> = {
  1: "Bane", 2: "Root", 3: "Bite", 4: "Song", 5: "Roar",
  6: "Grasp", 7: "Instrument", 8: "Glow", 9: "Bender", 10: "Shadow",
  11: "Whisper", 12: "Shout", 13: "Growl", 14: "Tear", 15: "Peak",
  16: "Form", 17: "Sun", 18: "Moon",
};

const beastMap = new Map<number, BeastMeta>();
for (const b of BEASTS) beastMap.set(b.id, b);

export function getBeastMeta(beastId: number): BeastMeta | undefined {
  return beastMap.get(beastId);
}

export function getBeastFullName(beastId: number, prefix: number, suffix: number): string {
  const meta = beastMap.get(beastId);
  const name = meta?.name ?? `Beast#${beastId}`;
  const p = PREFIXES[prefix] ?? "";
  const s = SUFFIXES[suffix] ?? "";
  return [p, name, s].filter(Boolean).join(" ");
}

export function getSpecialsKey(prefix: number, suffix: number): string {
  return `${prefix}:${suffix}`;
}

export function getSpecialsVariantName(prefix: number, suffix: number): string {
  const p = PREFIXES[prefix] ?? `Prefix#${prefix}`;
  const s = SUFFIXES[suffix] ?? `Suffix#${suffix}`;
  return `${p} ${s}`;
}

export function getTypeAdvantage(attacker: BeastType, defender: BeastType): number {
  if (attacker === defender) return 1.0;
  if (
    (attacker === "Magic" && defender === "Brute") ||
    (attacker === "Hunter" && defender === "Magic") ||
    (attacker === "Brute" && defender === "Hunter")
  ) {
    return 1.5;
  }
  return 0.5;
}
