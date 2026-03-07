export interface ApiBeast {
  token_id: number;
  beast_id: number;
  prefix: number;
  suffix: number;
  level: number;
  health: number;
  current_health: number;
  bonus_health?: number;
  owner: string;
  xp?: number;
  gold?: number;
  seed?: number;
  created_time?: number;
  death_time?: number;
  killed_by?: number;
  slain_by?: number;
  slain_count?: number;
  bonus_xp?: number;
  summit_held_seconds?: number;
  last_death_timestamp?: number;
  rewards_earned?: number;
  rewards_claimed?: number;
  extra_lives?: number;
  revival_count?: number;
  attack_streak?: number;
  quest_captured_summit?: number;
  quest_used_revival_potion?: number;
  quest_used_attack_potion?: number;
  quest_max_attack_streak?: number;
  poison_count?: number;
  spirit?: number;
  luck?: number;
}

export interface ApiPagination {
  offset: number;
  limit: number;
  total: number;
  has_more: boolean;
}

export interface ApiBeastsResponse {
  data: ApiBeast[];
  pagination: ApiPagination;
}

export interface ApiTopBeast {
  token_id: number;
  summit_held_seconds: number;
  bonus_xp: number;
  last_death_timestamp: number;
  owner: string;
  beast_name: string;
  prefix: string;
  suffix: string;
  full_name: string;
}
