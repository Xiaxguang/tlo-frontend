PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  display_name TEXT,
  recovery_code TEXT,
  password_hash TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  password_changed_at TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS player_assets (
  player_id TEXT PRIMARY KEY,
  draw_times INTEGER NOT NULL DEFAULT 0,
  trend_energy INTEGER NOT NULL DEFAULT 0,
  total_topup INTEGER NOT NULL DEFAULT 0,
  available_points INTEGER NOT NULL DEFAULT 0,
  total_points INTEGER NOT NULL DEFAULT 0,
  used_points INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  rarity TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  is_drawable INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gacha_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  card_id TEXT,
  card_name TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

CREATE TABLE IF NOT EXISTS player_collection (
  player_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  card_name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, card_id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

CREATE TABLE IF NOT EXISTS card_stars (
  player_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  card_name TEXT NOT NULL,
  star INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, card_id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_id) REFERENCES cards(id)
);


CREATE TABLE IF NOT EXISTS battle_chapters (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  mode TEXT NOT NULL DEFAULT 'normal',
  mode_label TEXT NOT NULL DEFAULT '普通',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  unlock_type TEXT NOT NULL DEFAULT 'NONE',
  unlock_value TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS boss_stages (
  id INTEGER PRIMARY KEY,
  chapter_key TEXT NOT NULL DEFAULT 'normal_1',
  stage_order INTEGER NOT NULL DEFAULT 0,
  boss_card_id TEXT,
  boss_card_name TEXT NOT NULL,
  boss_power INTEGER NOT NULL,
  stage_name TEXT NOT NULL,
  reward_draw_times INTEGER NOT NULL DEFAULT 0,
  unlock_type TEXT NOT NULL DEFAULT 'NONE',
  unlock_value TEXT,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS battle_progress (
  player_id TEXT PRIMARY KEY,
  current_stage_id INTEGER NOT NULL DEFAULT 1,
  representative_card_name TEXT,
  representative_power INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS battle_rewards (
  player_id TEXT NOT NULL,
  stage_id INTEGER NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (player_id, stage_id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS battle_daily_status (
  player_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  challenge_count INTEGER NOT NULL DEFAULT 0,
  bonus_challenge_count INTEGER NOT NULL DEFAULT 0,
  normal_first_clears INTEGER NOT NULL DEFAULT 0,
  hard_first_clears INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, date_key),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS training_profiles (
  player_id TEXT PRIMARY KEY,
  energy INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_checkin_date TEXT,
  daily_key TEXT,
  memory_plays_today INTEGER NOT NULL DEFAULT 0,
  quiz_done_today INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '潮流新人',
  max_memory_score INTEGER NOT NULL DEFAULT 0,
  skill_exp INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS training_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  date_key TEXT,
  type TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS mini_daily_status (
  player_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  shadow_plays_today INTEGER NOT NULL DEFAULT 0,
  fortune_result TEXT,
  message_count_today INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, date_key),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT,
  masked_uid TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OK',
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS pvp_players (
  player_id TEXT PRIMARY KEY,
  representative_card_name TEXT,
  representative_power INTEGER NOT NULL DEFAULT 0,
  fragments INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  total_losses INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS pvp_daily_status (
  player_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  challenges INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  fragment_claimed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, date_key),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS pvp_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  my_card TEXT,
  opponent_masked_uid TEXT,
  opponent_card TEXT,
  my_power INTEGER NOT NULL DEFAULT 0,
  opponent_power INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  reward TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS player_sessions (
  token TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_gacha_logs_player_id ON gacha_logs(player_id);
CREATE INDEX IF NOT EXISTS idx_gacha_logs_created_at ON gacha_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_pvp_logs_player_id ON pvp_logs(player_id);
CREATE INDEX IF NOT EXISTS idx_training_logs_player_id ON training_logs(player_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_player_id ON player_sessions(player_id);
CREATE INDEX IF NOT EXISTS idx_player_sessions_expires_at ON player_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'GM',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id)
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id TEXT,
  action TEXT NOT NULL,
  target_uid TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admin_users(id)
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target_uid ON admin_audit_logs(target_uid);

-- =========================
-- OPS / REDEEM / RPG PATCH
-- =========================
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redeem_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  title TEXT,
  reward_type TEXT NOT NULL,
  reward_value INTEGER NOT NULL DEFAULT 0,
  card_name TEXT,
  max_uses INTEGER NOT NULL DEFAULT 0,
  per_player_limit INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  expires_at TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_admin_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id)
);

CREATE TABLE IF NOT EXISTS redeem_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_id INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  reward_summary TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(code_id, player_id),
  FOREIGN KEY (code_id) REFERENCES redeem_codes(id),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_redeem_codes_code ON redeem_codes(code);
CREATE INDEX IF NOT EXISTS idx_redeem_redemptions_code_id ON redeem_redemptions(code_id);
CREATE INDEX IF NOT EXISTS idx_redeem_redemptions_player_id ON redeem_redemptions(player_id);

CREATE TABLE IF NOT EXISTS rpg_party (
  player_id TEXT PRIMARY KEY,
  slot1_card_name TEXT,
  slot2_card_name TEXT,
  slot3_card_name TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS rpg_chapters (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  unlock_type TEXT NOT NULL DEFAULT 'NONE',
  unlock_value TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rpg_dungeons (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  chapter_key TEXT NOT NULL DEFAULT 'isekai_entry',
  stage_order INTEGER NOT NULL DEFAULT 0,
  boss_card_name TEXT,
  required_power INTEGER NOT NULL DEFAULT 0,
  reward_score INTEGER NOT NULL DEFAULT 0,
  reward_energy INTEGER NOT NULL DEFAULT 0,
  reward_draw_chance INTEGER NOT NULL DEFAULT 0,
  reward_draw_times INTEGER NOT NULL DEFAULT 0,
  reward_card_name TEXT,
  reward_card_chance INTEGER NOT NULL DEFAULT 0,
  reward_card_quantity INTEGER NOT NULL DEFAULT 1,
  unlock_type TEXT NOT NULL DEFAULT 'NONE',
  unlock_value TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rpg_adventure_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  dungeon_key TEXT NOT NULL,
  dungeon_name TEXT NOT NULL,
  result TEXT NOT NULL,
  team_power INTEGER NOT NULL DEFAULT 0,
  enemy_power INTEGER NOT NULL DEFAULT 0,
  reward_summary TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS rpg_daily_status (
  player_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  expedition_count INTEGER NOT NULL DEFAULT 0,
  bonus_expedition_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, date_key),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_rpg_adventure_logs_player_id ON rpg_adventure_logs(player_id);
CREATE INDEX IF NOT EXISTS idx_rpg_adventure_logs_created_at ON rpg_adventure_logs(created_at);

-- =========================
-- CHARACTER GROWTH PATCH
-- =========================
CREATE TABLE IF NOT EXISTS card_progression (
  player_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  card_name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  exp INTEGER NOT NULL DEFAULT 0,
  skill_level INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, card_id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

CREATE INDEX IF NOT EXISTS idx_card_progression_player_id ON card_progression(player_id);
CREATE INDEX IF NOT EXISTS idx_card_progression_card_name ON card_progression(card_name);


-- =========================
-- PLAYER ITEMS / CARD RESET TICKET
-- =========================
CREATE TABLE IF NOT EXISTS player_items (
  player_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (player_id, item_key),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS card_reset_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  uid TEXT,
  card_id TEXT NOT NULL,
  card_name TEXT NOT NULL,
  old_star INTEGER NOT NULL DEFAULT 1,
  old_skill_level INTEGER NOT NULL DEFAULT 1,
  refunded_energy INTEGER NOT NULL DEFAULT 0,
  refunded_skill_exp INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (card_id) REFERENCES cards(id)
);

CREATE INDEX IF NOT EXISTS idx_player_items_player_key ON player_items(player_id, item_key);
CREATE INDEX IF NOT EXISTS idx_card_reset_logs_player_created ON card_reset_logs(player_id, created_at);


-- =========================
-- LAUNCH WELFARE / MISSIONS PATCH
-- =========================
CREATE TABLE IF NOT EXISTS launch_reward_claims (
  player_id TEXT NOT NULL,
  day_number INTEGER NOT NULL,
  date_key TEXT NOT NULL,
  reward_summary TEXT,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (player_id, day_number),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS mission_reward_claims (
  player_id TEXT NOT NULL,
  mission_group TEXT NOT NULL,
  mission_key TEXT NOT NULL,
  date_key TEXT NOT NULL DEFAULT '',
  reward_summary TEXT,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (player_id, mission_group, mission_key, date_key),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_launch_reward_claims_player_id ON launch_reward_claims(player_id);
CREATE INDEX IF NOT EXISTS idx_mission_reward_claims_player_group ON mission_reward_claims(player_id, mission_group);


-- =========================
-- PERFORMANCE INDEX PATCH
-- These indexes speed up common player/admin lookups without changing gameplay data.
-- =========================
CREATE INDEX IF NOT EXISTS idx_players_uid ON players(uid);
CREATE INDEX IF NOT EXISTS idx_players_display_name ON players(display_name);
CREATE INDEX IF NOT EXISTS idx_players_last_login_at ON players(last_login_at);
CREATE INDEX IF NOT EXISTS idx_player_collection_player_card ON player_collection(player_id, card_id);
CREATE INDEX IF NOT EXISTS idx_player_collection_card_name ON player_collection(card_name);
CREATE INDEX IF NOT EXISTS idx_card_stars_player_card ON card_stars(player_id, card_id);
CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_drawable_sort ON cards(is_drawable, sort_order);
CREATE INDEX IF NOT EXISTS idx_battle_rewards_player_stage ON battle_rewards(player_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_battle_progress_player ON battle_progress(player_id);
CREATE INDEX IF NOT EXISTS idx_training_profiles_score ON training_profiles(total_score);
CREATE INDEX IF NOT EXISTS idx_training_profiles_energy ON training_profiles(energy);
CREATE INDEX IF NOT EXISTS idx_pvp_players_wins ON pvp_players(total_wins);
CREATE INDEX IF NOT EXISTS idx_pvp_daily_status_player_date ON pvp_daily_status(player_id, date_key);
CREATE INDEX IF NOT EXISTS idx_mini_daily_status_player_date ON mini_daily_status(player_id, date_key);
CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages(status, created_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_token_expires ON admin_sessions(token, expires_at);
CREATE INDEX IF NOT EXISTS idx_player_sessions_token_expires ON player_sessions(token, expires_at);
CREATE INDEX IF NOT EXISTS idx_redeem_redemptions_player_code ON redeem_redemptions(player_id, code_id);
CREATE INDEX IF NOT EXISTS idx_rpg_dungeons_active_sort ON rpg_dungeons(is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_rpg_chapters_active_sort ON rpg_chapters(is_active, sort_order, key);
CREATE INDEX IF NOT EXISTS idx_rpg_dungeons_chapter_order ON rpg_dungeons(chapter_key, stage_order, sort_order);

CREATE INDEX IF NOT EXISTS idx_rpg_adventure_logs_player_created ON rpg_adventure_logs(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_card_progression_player_card ON card_progression(player_id, card_id);
CREATE INDEX IF NOT EXISTS idx_launch_reward_claims_player_day ON launch_reward_claims(player_id, day_number);
CREATE INDEX IF NOT EXISTS idx_mission_reward_claims_player_lookup ON mission_reward_claims(player_id, mission_group, date_key);


-- =========================
-- ACHIEVEMENTS PATCH
-- =========================
CREATE TABLE IF NOT EXISTS achievement_claims (
  player_id TEXT NOT NULL,
  achievement_key TEXT NOT NULL,
  reward_summary TEXT,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (player_id, achievement_key),
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE INDEX IF NOT EXISTS idx_achievement_claims_player ON achievement_claims(player_id);

-- Performance hotfix indexes for battle/growth dashboards
CREATE INDEX IF NOT EXISTS idx_player_collection_player_quantity ON player_collection(player_id, quantity);
CREATE INDEX IF NOT EXISTS idx_card_stars_player_card_name ON card_stars(player_id, card_name);
CREATE INDEX IF NOT EXISTS idx_card_progression_player_card_name ON card_progression(player_id, card_name);
CREATE INDEX IF NOT EXISTS idx_cards_image_sort ON cards(sort_order, image_url);

-- =========================
-- CLAIM SPEED + GM SKILL EXP PATCH
-- These indexes speed up reward claim checks and common reward history lookups.
-- =========================
CREATE INDEX IF NOT EXISTS idx_training_profiles_player_skill_exp ON training_profiles(player_id, skill_exp);
CREATE INDEX IF NOT EXISTS idx_training_logs_player_type_created ON training_logs(player_id, type, created_at);
CREATE INDEX IF NOT EXISTS idx_mission_reward_claims_exact ON mission_reward_claims(player_id, mission_group, mission_key, date_key);
CREATE INDEX IF NOT EXISTS idx_achievement_claims_exact ON achievement_claims(player_id, achievement_key);
CREATE INDEX IF NOT EXISTS idx_launch_reward_claims_player_date ON launch_reward_claims(player_id, date_key);



-- =========================
-- SHOP SYSTEM PATCH v6
-- 商品由資料庫管理；正式綠界付款尚未啟用。
-- =========================
CREATE TABLE IF NOT EXISTS player_profiles (
  player_id TEXT PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  display_name TEXT,
  bio TEXT,
  status TEXT NOT NULL DEFAULT 'ONLINE',
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS friend_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  responded_at TEXT,
  UNIQUE(requester_id, receiver_id),
  FOREIGN KEY (requester_id) REFERENCES players(id),
  FOREIGN KEY (receiver_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS friendships (
  player_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (player_id, friend_id),
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (friend_id) REFERENCES players(id)
);

CREATE TABLE IF NOT EXISTS shop_items (
  product_key TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_type TEXT NOT NULL,
  price_amount INTEGER NOT NULL DEFAULT 0,
  limit_type TEXT NOT NULL DEFAULT 'NONE',
  limit_count INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_payment_enabled INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  tag TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_item_rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_key TEXT NOT NULL,
  reward_type TEXT NOT NULL,
  reward_value INTEGER NOT NULL DEFAULT 0,
  card_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (product_key) REFERENCES shop_items(product_key)
);

CREATE TABLE IF NOT EXISTS shop_purchase_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  purchase_type TEXT NOT NULL,
  date_key TEXT NOT NULL DEFAULT '',
  period_key TEXT NOT NULL DEFAULT '',
  price_type TEXT NOT NULL DEFAULT '',
  price_amount INTEGER NOT NULL DEFAULT 0,
  reward_summary TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id)
);


CREATE TABLE IF NOT EXISTS payment_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL,
  player_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  product_key TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TWD',
  provider TEXT NOT NULL DEFAULT 'ECPAY',
  status TEXT NOT NULL DEFAULT 'PENDING',
  period_key TEXT NOT NULL DEFAULT '',
  ecpay_token TEXT,
  pay_token TEXT,
  payment_type TEXT,
  provider_trade_no TEXT,
  raw_create_payload TEXT,
  raw_callback_payload TEXT,
  raw_return_payload TEXT,
  raw_result_payload TEXT,
  reward_granted INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT,
  granted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (player_id) REFERENCES players(id),
  FOREIGN KEY (product_key) REFERENCES shop_items(product_key)
);

CREATE INDEX IF NOT EXISTS idx_player_profiles_uid ON player_profiles(uid);
CREATE INDEX IF NOT EXISTS idx_player_profiles_status_seen ON player_profiles(status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver_status ON friend_requests(receiver_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_friend_requests_requester_status ON friend_requests(requester_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_friendships_player_friend ON friendships(player_id, friend_id);
CREATE INDEX IF NOT EXISTS idx_friendships_friend_player ON friendships(friend_id, player_id);
CREATE INDEX IF NOT EXISTS idx_shop_items_category_active_sort ON shop_items(category, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_shop_rewards_product_sort ON shop_item_rewards(product_key, sort_order);
CREATE INDEX IF NOT EXISTS idx_shop_purchase_player_product_period ON shop_purchase_logs(player_id, product_key, period_key);
CREATE INDEX IF NOT EXISTS idx_shop_purchase_player_created ON shop_purchase_logs(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_order_no ON payment_orders(order_no);
CREATE INDEX IF NOT EXISTS idx_payment_orders_player_status ON payment_orders(player_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_orders_player_product_period ON payment_orders(player_id, product_key, period_key, status);


-- =========================
-- FINAL PERFORMANCE PATCH
-- 這些索引只會加速查詢，不會刪除或覆蓋任何玩家資料。
-- =========================
CREATE INDEX IF NOT EXISTS idx_gacha_logs_player_source_id ON gacha_logs(player_id, source, id);
CREATE INDEX IF NOT EXISTS idx_gacha_logs_player_created ON gacha_logs(player_id, created_at);
CREATE INDEX IF NOT EXISTS idx_players_uid_nocase ON players(uid COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_players_display_name_nocase ON players(display_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_player_assets_player ON player_assets(player_id);
CREATE INDEX IF NOT EXISTS idx_player_collection_player_quantity_card ON player_collection(player_id, quantity, card_id);
CREATE INDEX IF NOT EXISTS idx_player_collection_player_card_id ON player_collection(player_id, card_id);
CREATE INDEX IF NOT EXISTS idx_player_collection_player_card_name ON player_collection(player_id, card_name);
CREATE INDEX IF NOT EXISTS idx_card_stars_player_card_id ON card_stars(player_id, card_id);
CREATE INDEX IF NOT EXISTS idx_card_stars_player_name ON card_stars(player_id, card_name);
CREATE INDEX IF NOT EXISTS idx_card_progression_player_card_id ON card_progression(player_id, card_id);
CREATE INDEX IF NOT EXISTS idx_card_progression_player_name ON card_progression(player_id, card_name);
CREATE INDEX IF NOT EXISTS idx_boss_stages_id_power ON boss_stages(id, boss_power);
CREATE INDEX IF NOT EXISTS idx_battle_progress_player_stage ON battle_progress(player_id, current_stage_id);
CREATE INDEX IF NOT EXISTS idx_battle_rewards_player_stage_id ON battle_rewards(player_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_rpg_party_player ON rpg_party(player_id);
CREATE INDEX IF NOT EXISTS idx_rpg_dungeons_active_sort_key ON rpg_dungeons(is_active, sort_order, key);
CREATE INDEX IF NOT EXISTS idx_rpg_logs_player_dungeon_created ON rpg_adventure_logs(player_id, dungeon_key, created_at);
CREATE INDEX IF NOT EXISTS idx_pvp_players_player ON pvp_players(player_id);
CREATE INDEX IF NOT EXISTS idx_pvp_logs_player_date_created ON pvp_logs(player_id, date_key, created_at);
CREATE INDEX IF NOT EXISTS idx_training_profiles_player ON training_profiles(player_id);
CREATE INDEX IF NOT EXISTS idx_training_logs_player_date_type ON training_logs(player_id, date_key, type);
CREATE INDEX IF NOT EXISTS idx_mission_claims_player_group_key_date ON mission_reward_claims(player_id, mission_group, mission_key, date_key);
CREATE INDEX IF NOT EXISTS idx_achievement_claims_player_key ON achievement_claims(player_id, achievement_key);
CREATE INDEX IF NOT EXISTS idx_launch_claims_player_day_date ON launch_reward_claims(player_id, day_number, date_key);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin_created ON admin_audit_logs(admin_id, created_at);

CREATE INDEX IF NOT EXISTS idx_battle_daily_status_player_date ON battle_daily_status(player_id, date_key);
CREATE INDEX IF NOT EXISTS idx_rpg_daily_status_player_date ON rpg_daily_status(player_id, date_key);

CREATE INDEX IF NOT EXISTS idx_battle_chapters_active_sort ON battle_chapters(is_active, sort_order, key);
CREATE INDEX IF NOT EXISTS idx_boss_stages_chapter_order ON boss_stages(chapter_key, stage_order, id);
CREATE INDEX IF NOT EXISTS idx_boss_stages_active_id ON boss_stages(is_active, id);
