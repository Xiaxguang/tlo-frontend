import fs from "fs";
import path from "path";
import { execute, queryOne, queryAll, dbProvider } from "./db.js";
import { DEFAULT_BETA_PASSWORD, hashPassword } from "./utils/auth.js";

const root = process.cwd();
const schemaFileName = dbProvider === "supabase" ? "schema.supabase.sql" : "schema.sql";
const schemaPath = path.join(root, "src", schemaFileName);
const seedPath = path.join(root, "data", "seed.json");

async function addColumnIfMissing(tableName, columnSql) {
  try {
    await execute(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql}`);
  } catch (err) {
    const msg = String(err.message || err).toLowerCase();
    if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
      throw err;
    }
  }
}

async function ensureAuthSchema() {
  await addColumnIfMissing("players", "password_hash TEXT");
  await addColumnIfMissing("players", "must_change_password INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("players", "password_changed_at TEXT");

  await execute(`CREATE TABLE IF NOT EXISTS player_sessions (
    token TEXT PRIMARY KEY,
    player_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_player_sessions_player_id ON player_sessions(player_id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_player_sessions_expires_at ON player_sessions(expires_at)");

  const defaultHash = hashPassword(DEFAULT_BETA_PASSWORD);
  const now = new Date().toISOString();
  const playersWithoutPassword = await queryAll("SELECT id FROM players WHERE password_hash IS NULL OR password_hash = ''", []);
  for (const p of playersWithoutPassword) {
    await execute(
      "UPDATE players SET password_hash = ?, must_change_password = 1, password_changed_at = ? WHERE id = ?",
      [defaultHash, now, p.id]
    );
  }

  console.log(`✅ auth schema ready，已替 ${playersWithoutPassword.length} 位既有玩家設定預設密碼`);
}


async function ensureAdminSchema() {
  await execute(`CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'GM',
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    admin_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_used_at TEXT,
    FOREIGN KEY (admin_id) REFERENCES admin_users(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT,
    action TEXT NOT NULL,
    target_uid TEXT,
    detail TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES admin_users(id)
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id ON admin_sessions(admin_id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at)");
  await execute("CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at)");
  await execute("CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_target_uid ON admin_audit_logs(target_uid)");

  const username = String(process.env.GM_ADMIN_USERNAME || "admin").trim();
  const password = String(process.env.GM_ADMIN_PASSWORD || "aaa123456");
  const displayName = String(process.env.GM_ADMIN_DISPLAY_NAME || "GM管理員").trim();
  const now = new Date().toISOString();

  if (username && password) {
    const id = "admin_" + username.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40);
    await execute(
      `INSERT INTO admin_users (id, username, display_name, role, password_hash, created_at, last_login_at)
       VALUES (?, ?, ?, 'OWNER', ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         display_name = excluded.display_name,
         role = excluded.role,
         password_hash = excluded.password_hash`,
      [id, username, displayName || username, hashPassword(password), now, now]
    );
    console.log(`✅ GM admin ready：${username}`);
  }
}


async function ensureOpsRpgSchema() {
  const now = new Date().toISOString();

  await execute(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  )`);

  const defaults = {
    maintenance_enabled: "0",
    maintenance_message: "系統維護中，請稍後再試。",
    announcement_title: "T-LO 公告",
    announcement_body: "歡迎來到 T-LO 潮流盲盒開榜現場。"
  };
  for (const [key, value] of Object.entries(defaults)) {
    await execute(
      "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
      [key, value, now]
    );
  }

  await execute(`CREATE TABLE IF NOT EXISTS redeem_codes (
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
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS redeem_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id INTEGER NOT NULL,
    player_id TEXT NOT NULL,
    reward_summary TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(code_id, player_id),
    FOREIGN KEY (code_id) REFERENCES redeem_codes(id),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_redeem_codes_code ON redeem_codes(code)");
  await execute("CREATE INDEX IF NOT EXISTS idx_redeem_redemptions_code_id ON redeem_redemptions(code_id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_redeem_redemptions_player_id ON redeem_redemptions(player_id)");

  await execute(`CREATE TABLE IF NOT EXISTS rpg_party (
    player_id TEXT PRIMARY KEY,
    slot1_card_name TEXT,
    slot2_card_name TEXT,
    slot3_card_name TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS rpg_chapters (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    unlock_type TEXT NOT NULL DEFAULT 'NONE',
    unlock_value TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);

  await execute(`CREATE TABLE IF NOT EXISTS rpg_dungeons (
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
  )`);
  await addColumnIfMissing("rpg_dungeons", "chapter_key TEXT NOT NULL DEFAULT 'isekai_entry'");
  await addColumnIfMissing("rpg_dungeons", "stage_order INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("rpg_dungeons", "boss_card_name TEXT");
  await addColumnIfMissing("rpg_dungeons", "reward_draw_times INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("rpg_dungeons", "reward_card_name TEXT");
  await addColumnIfMissing("rpg_dungeons", "reward_card_chance INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("rpg_dungeons", "reward_card_quantity INTEGER NOT NULL DEFAULT 1");
  await addColumnIfMissing("rpg_dungeons", "unlock_type TEXT NOT NULL DEFAULT 'NONE'");
  await addColumnIfMissing("rpg_dungeons", "unlock_value TEXT");
  await execute("CREATE INDEX IF NOT EXISTS idx_rpg_chapters_active_sort ON rpg_chapters(is_active, sort_order, key)");
  await execute("CREATE INDEX IF NOT EXISTS idx_rpg_dungeons_chapter_order ON rpg_dungeons(chapter_key, stage_order, sort_order)");
  await execute(`CREATE TABLE IF NOT EXISTS rpg_adventure_logs (
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
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_rpg_adventure_logs_player_id ON rpg_adventure_logs(player_id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_rpg_adventure_logs_created_at ON rpg_adventure_logs(created_at)");

  await execute(
    `INSERT INTO rpg_chapters (key, name, description, sort_order, is_active, unlock_type, unlock_value, created_at, updated_at)
     VALUES ('isekai_entry', '異世界入口', '最初開放的遠征異世界，所有舊遠征關卡會自動歸到這裡。', 1, 1, 'NONE', '', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       name = COALESCE(NULLIF(rpg_chapters.name, ''), excluded.name),
       description = COALESCE(NULLIF(rpg_chapters.description, ''), excluded.description),
       sort_order = COALESCE(rpg_chapters.sort_order, excluded.sort_order),
       is_active = 1,
       updated_at = excluded.updated_at`,
    [now, now]
  );

  const dungeons = [
    ["street_01", "潮流街區試煉", "適合新手隊伍的第一個遠征關卡。", "isekai_entry", 1, "阿福", 300, 80, 40, 5, 0, "NONE", "", 1],
    ["neon_02", "霓虹夜市突襲", "需要穩定戰力，勝利可取得更多能量。", "isekai_entry", 2, "星羽", 900, 150, 90, 8, 0, "NONE", "", 2],
    ["tower_03", "LBR 高塔攻略戰", "中高戰力挑戰，適合升星後再挑戰。", "isekai_entry", 3, "月婆婆", 1800, 260, 160, 12, 0, "NONE", "", 3],
    ["boss_04", "潮流王座決戰", "目前最高難度遠征試煉。", "isekai_entry", 4, "葉書宏", 3200, 450, 260, 18, 1, "NONE", "", 4]
  ];
  for (const d of dungeons) {
    await execute(
      `INSERT INTO rpg_dungeons (key, name, description, chapter_key, stage_order, boss_card_name, required_power, reward_score, reward_energy, reward_draw_chance, reward_draw_times, unlock_type, unlock_value, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         chapter_key = COALESCE(NULLIF(rpg_dungeons.chapter_key, ''), excluded.chapter_key),
         stage_order = CASE WHEN COALESCE(rpg_dungeons.stage_order, 0) = 0 THEN excluded.stage_order ELSE rpg_dungeons.stage_order END,
         boss_card_name = COALESCE(rpg_dungeons.boss_card_name, excluded.boss_card_name),
         required_power = excluded.required_power,
         reward_score = excluded.reward_score,
         reward_energy = excluded.reward_energy,
         reward_draw_chance = excluded.reward_draw_chance,
         reward_draw_times = excluded.reward_draw_times,
         unlock_type = COALESCE(NULLIF(rpg_dungeons.unlock_type, ''), excluded.unlock_type),
         unlock_value = COALESCE(rpg_dungeons.unlock_value, excluded.unlock_value),
         is_active = excluded.is_active,
         sort_order = excluded.sort_order`,
      d
    );
  }

  await execute("UPDATE rpg_dungeons SET chapter_key = 'isekai_entry' WHERE chapter_key IS NULL OR chapter_key = ''");
  await execute("UPDATE rpg_dungeons SET stage_order = sort_order WHERE COALESCE(stage_order, 0) = 0");
  console.log("✅ ops / redeem / RPG schema ready：遠征異世界章節/關卡管理已啟用");
}


async function ensureCharacterGrowthSchema() {
  await execute(`CREATE TABLE IF NOT EXISTS card_progression (
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
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_card_progression_player_id ON card_progression(player_id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_card_progression_card_name ON card_progression(card_name)");
  await addColumnIfMissing("training_profiles", "skill_exp INTEGER NOT NULL DEFAULT 0");
  console.log("✅ character growth schema ready");
}


const NORMAL_BATTLE_BOSSES = [
  "阿福", "小葵", "米雅", "小梅", "星羽",
  "可可", "咩姨", "庫奇", "王太太", "李爺爺",
  "王伯伯", "鐵叔", "小柚", "毛毛", "月婆婆",
  "阿甘", "達達", "露西", "老陳", "鹿比",
  "小波", "吳奶奶", "阿土", "菜菜子", "葉書宏"
];

const NORMAL_BATTLE_STAGE_NAMES = [
  "閣前的第一盞燈", "向陽花道的邀請", "米色書頁的低語", "梅香庭院的試煉", "星光羽痕",
  "可可香氣的走廊", "羊鈴茶室", "餅乾櫃檯的守門人", "閣中貴客的盤問", "老鑰匙的主人",
  "木櫃旁的考驗", "鐵門前的敲擊聲", "柚香燈影", "毛絨地毯的陷阱", "月光窗邊的占卜",
  "甘草藥櫃的謎題", "奔跑鐘聲", "露珠玻璃房", "陳年木箱的秘密", "鹿影階梯",
  "波紋水鏡", "老茶壺的守候", "土色倉庫", "青菜籃後的暗門", "秘寶閣的第一枚印記",

  "失落門牌的指引", "向陽花下的暗格", "被封起的書頁", "梅影密廊", "星羽落下的暗號",
  "香氣後方的機關", "茶室地下的回聲", "餅乾盒裡的密令", "貴客名冊的破綻", "舊鑰匙開啟之門",
  "木櫃深處的夾層", "鐵門背後的齒輪", "柚香迷霧", "絨毛暗道", "月相占盤的警告",
  "藥櫃中的殘卷", "鐘聲追逐戰", "玻璃房的倒影", "陳年帳本", "鹿角徽章",
  "水鏡裡的第二個人", "茶壺裡的密語", "倉庫地板下的盒子", "暗門後的菜園", "秘寶閣的隱藏契約",

  "最後邀請函", "向陽花道的決意", "書頁燃起之時", "梅庭終局", "星羽墜落戰",
  "香氣中的對決", "茶室封鎖線", "餅乾守衛戰", "貴客廳的審判", "老鑰匙的真正用途",
  "木櫃前的決斷", "鐵門崩落", "柚光破陣", "絨毛陷阱終章", "月光預言戰",
  "藥櫃封印", "終局鐘聲", "玻璃房決裂", "陳年秘密揭露", "鹿影王座",
  "水鏡碎裂", "最後一壺茶", "大地密室", "暗門最深處", "秘寶閣歸屬之戰"
];

const HARD_BATTLE_BOSSES = ["星羽", "庫奇", "李爺爺", "月婆婆", "鹿比", "葉書宏"];
const HARD_BATTLE_STAGE_NAMES = [
  "星羽再臨", "甜點陷阱", "古鑰試煉", "月影預言", "鹿影急襲", "秘寶守約者",
  "墜星迴廊", "餅乾迷宮", "禁鑰之門", "逆月占盤", "鹿角封印", "契約審判",
  "星羽終焉", "甜點王座", "古鑰裁決", "滿月終局", "鹿影王權", "秘寶閣最終歸屬"
];

const BATTLE_BOSS_POWER_BOOST = {
  "星羽": 1.18,
  "庫奇": 1.14,
  "李爺爺": 1.16,
  "月婆婆": 1.24,
  "鹿比": 1.20,
  "葉書宏": 1.36
};

function getBattleStageSeed(stageId) {
  if (stageId <= 75) {
    const index = stageId - 1;
    const bossName = NORMAL_BATTLE_BOSSES[index % NORMAL_BATTLE_BOSSES.length];
    const chapter = Math.ceil(stageId / 25);
    const bossBoost = BATTLE_BOSS_POWER_BOOST[bossName] || 1;
    const chapterBoost = 1 + (chapter - 1) * 0.12;
    const bossPower = Math.round((520 + stageId * 175 + Math.pow(stageId, 1.34) * 42) * chapterBoost * bossBoost);
    return {
      stageId,
      bossName,
      stageName: `第 ${stageId} 關｜${NORMAL_BATTLE_STAGE_NAMES[index] || bossName}`,
      bossPower,
      rewardDrawTimes: stageId % 5 === 0 ? 3 : 0
    };
  }

  const hardIndex = stageId - 76;
  const bossName = HARD_BATTLE_BOSSES[hardIndex % HARD_BATTLE_BOSSES.length];
  const bossBoost = BATTLE_BOSS_POWER_BOOST[bossName] || 1.2;
  const hardChapter = Math.floor(hardIndex / 6) + 1;
  const hardStageInChapter = (hardIndex % 6) + 1;
  const bossPower = Math.round((40000 + hardIndex * 1800 + Math.pow(hardIndex + 1, 1.28) * 450) * (1 + (hardChapter - 1) * 0.10) * bossBoost);
  return {
    stageId,
    bossName,
    stageName: `困難 H${hardChapter}-${hardStageInChapter}｜${HARD_BATTLE_STAGE_NAMES[hardIndex] || bossName}`,
    bossPower,
    rewardDrawTimes: hardStageInChapter === 6 ? 5 : 0
  };
}


const DEFAULT_BATTLE_CHAPTERS = [
  ['normal_1', '第一章｜初見秘寶閣', '初次接觸秘寶閣，從外圍試煉開始踏入未知領域。', 'normal', '普通', 10, 1, 'NONE', ''],
  ['normal_2', '第二章｜秘寶閣隱秘', '發現秘寶閣深處藏有不為人知的秘密，守關者實力全面提升。', 'normal', '普通', 20, 1, 'BATTLE_STAGE', '25'],
  ['normal_3', '第三章｜決戰秘寶閣', '各方勢力爭奪秘寶閣歸屬權，最終守關者展開決戰。', 'normal', '普通', 30, 1, 'BATTLE_STAGE', '50'],
  ['hard_1', '困難第一章｜秘寶閣深層試煉', '普通模式全通後開啟，秘寶閣真正的深層試煉開始。', 'hard', '困難', 110, 1, 'BATTLE_STAGE', '75'],
  ['hard_2', '困難第二章｜秘寶閣禁區', '踏入秘寶閣禁區，精英守關者開始阻擋玩家接近核心。', 'hard', '困難', 120, 1, 'BATTLE_STAGE', '81'],
  ['hard_3', '困難第三章｜秘寶閣終局', '終局王權之戰，決定秘寶閣最後歸屬。', 'hard', '困難', 130, 1, 'BATTLE_STAGE', '87']
];

function getDefaultBattleChapterKey(stageId) {
  const id = Number(stageId || 0);
  if (id <= 25) return 'normal_1';
  if (id <= 50) return 'normal_2';
  if (id <= 75) return 'normal_3';
  if (id <= 81) return 'hard_1';
  if (id <= 87) return 'hard_2';
  return 'hard_3';
}

function getDefaultBattleStageOrder(stageId) {
  const id = Number(stageId || 0);
  if (id <= 75) return ((id - 1) % 25) + 1;
  return ((id - 76) % 6) + 1;
}

async function ensureBossBattleV2Schema() {
  const now = new Date().toISOString();
  await execute(`CREATE TABLE IF NOT EXISTS battle_chapters (
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
  )`);
  await addColumnIfMissing("boss_stages", "chapter_key TEXT NOT NULL DEFAULT 'normal_1'");
  await addColumnIfMissing("boss_stages", "stage_order INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("boss_stages", "unlock_type TEXT NOT NULL DEFAULT 'NONE'");
  await addColumnIfMissing("boss_stages", "unlock_value TEXT");
  await addColumnIfMissing("boss_stages", "is_active INTEGER NOT NULL DEFAULT 1");
  await execute("CREATE INDEX IF NOT EXISTS idx_battle_chapters_active_sort ON battle_chapters(is_active, sort_order, key)");
  await execute("CREATE INDEX IF NOT EXISTS idx_boss_stages_chapter_order ON boss_stages(chapter_key, stage_order, id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_boss_stages_active_id ON boss_stages(is_active, id)");

  for (const ch of DEFAULT_BATTLE_CHAPTERS) {
    await execute(
      `INSERT INTO battle_chapters (key, name, description, mode, mode_label, sort_order, is_active, unlock_type, unlock_value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         name = COALESCE(NULLIF(battle_chapters.name, ''), excluded.name),
         description = COALESCE(NULLIF(battle_chapters.description, ''), excluded.description),
         mode = COALESCE(NULLIF(battle_chapters.mode, ''), excluded.mode),
         mode_label = COALESCE(NULLIF(battle_chapters.mode_label, ''), excluded.mode_label),
         sort_order = CASE WHEN COALESCE(battle_chapters.sort_order, 0) = 0 THEN excluded.sort_order ELSE battle_chapters.sort_order END,
         is_active = COALESCE(battle_chapters.is_active, excluded.is_active),
         unlock_type = COALESCE(NULLIF(battle_chapters.unlock_type, ''), excluded.unlock_type),
         unlock_value = COALESCE(battle_chapters.unlock_value, excluded.unlock_value),
         updated_at = excluded.updated_at`,
      [ch[0], ch[1], ch[2], ch[3], ch[4], ch[5], ch[6], ch[7], ch[8], now, now]
    );
  }

  await addColumnIfMissing("battle_progress", "representative_card_name TEXT");
  await addColumnIfMissing("battle_progress", "representative_power INTEGER NOT NULL DEFAULT 0");

  const allBossNames = Array.from(new Set([...NORMAL_BATTLE_BOSSES, ...HARD_BATTLE_BOSSES]));
  const placeholders = allBossNames.map(() => "?").join(",");
  const cardRows = allBossNames.length
    ? await queryAll(`SELECT id, name, rarity FROM cards WHERE name IN (${placeholders})`, allBossNames)
    : [];
  const cardMap = new Map((cardRows || []).map(row => [String(row.name), row]));
  const missingCards = [];

  for (let stageId = 1; stageId <= 93; stageId++) {
    const stage = getBattleStageSeed(stageId);
    const card = cardMap.get(stage.bossName);
    if (!card) missingCards.push(stage.bossName);
    const chapterKey = getDefaultBattleChapterKey(stageId);
    const stageOrder = getDefaultBattleStageOrder(stageId);
    await execute(
      `INSERT INTO boss_stages (id, chapter_key, stage_order, boss_card_id, boss_card_name, boss_power, stage_name, reward_draw_times, unlock_type, unlock_value, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NONE', '', 1)
       ON CONFLICT(id) DO UPDATE SET
         chapter_key = COALESCE(NULLIF(boss_stages.chapter_key, ''), excluded.chapter_key),
         stage_order = CASE WHEN COALESCE(boss_stages.stage_order, 0) = 0 THEN excluded.stage_order ELSE boss_stages.stage_order END,
         boss_card_id = COALESCE(boss_stages.boss_card_id, excluded.boss_card_id),
         boss_card_name = COALESCE(NULLIF(boss_stages.boss_card_name, ''), excluded.boss_card_name),
         boss_power = CASE WHEN COALESCE(boss_stages.boss_power, 0) = 0 THEN excluded.boss_power ELSE boss_stages.boss_power END,
         stage_name = COALESCE(NULLIF(boss_stages.stage_name, ''), excluded.stage_name),
         reward_draw_times = COALESCE(boss_stages.reward_draw_times, excluded.reward_draw_times),
         unlock_type = COALESCE(NULLIF(boss_stages.unlock_type, ''), excluded.unlock_type),
         unlock_value = COALESCE(boss_stages.unlock_value, excluded.unlock_value),
         is_active = COALESCE(boss_stages.is_active, excluded.is_active)`,
      [stageId, chapterKey, stageOrder, card?.id || null, stage.bossName, stage.bossPower, stage.stageName, stage.rewardDrawTimes]
    );
  }

  await execute("UPDATE boss_stages SET chapter_key = CASE WHEN id BETWEEN 1 AND 25 THEN 'normal_1' WHEN id BETWEEN 26 AND 50 THEN 'normal_2' WHEN id BETWEEN 51 AND 75 THEN 'normal_3' WHEN id BETWEEN 76 AND 81 THEN 'hard_1' WHEN id BETWEEN 82 AND 87 THEN 'hard_2' ELSE 'hard_3' END WHERE chapter_key IS NULL OR chapter_key = ''");
  await execute("UPDATE boss_stages SET stage_order = CASE WHEN id <= 75 THEN ((id - 1) % 25) + 1 ELSE ((id - 76) % 6) + 1 END WHERE COALESCE(stage_order, 0) = 0");

  const uniqueMissing = Array.from(new Set(missingCards));
  console.log("✅ boss battle schema ready：爭霸戰章節/關卡 GM 管理已啟用，保留既有自訂關卡");
  if (uniqueMissing.length) {
    console.log("⚠️ 注意：以下 BOSS 名稱在 cards 表找不到，關卡仍會建立，但圖片/稀有度可能需要到 GM 卡牌管理補資料：");
    console.log(uniqueMissing.join("、"));
  }
}


async function ensureLaunchMissionSchema() {
  await addColumnIfMissing("training_profiles", "skill_exp INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("training_logs", "date_key TEXT");

  await execute(`CREATE TABLE IF NOT EXISTS launch_reward_claims (
    player_id TEXT NOT NULL,
    day_number INTEGER NOT NULL,
    date_key TEXT NOT NULL,
    reward_summary TEXT,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (player_id, day_number),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS mission_reward_claims (
    player_id TEXT NOT NULL,
    mission_group TEXT NOT NULL,
    mission_key TEXT NOT NULL,
    date_key TEXT NOT NULL DEFAULT '',
    reward_summary TEXT,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY (player_id, mission_group, mission_key, date_key),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_launch_reward_claims_player_id ON launch_reward_claims(player_id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_mission_reward_claims_player_group ON mission_reward_claims(player_id, mission_group)");
  console.log("✅ launch welfare / missions schema ready：開服7日福利、每日任務、新手任務");
}

async function ensureDailyLimitSchema() {
  await execute(`CREATE TABLE IF NOT EXISTS battle_daily_status (
    player_id TEXT NOT NULL,
    date_key TEXT NOT NULL,
    challenge_count INTEGER NOT NULL DEFAULT 0,
    bonus_challenge_count INTEGER NOT NULL DEFAULT 0,
    normal_first_clears INTEGER NOT NULL DEFAULT 0,
    hard_first_clears INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (player_id, date_key),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS rpg_daily_status (
    player_id TEXT NOT NULL,
    date_key TEXT NOT NULL,
    expedition_count INTEGER NOT NULL DEFAULT 0,
    bonus_expedition_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (player_id, date_key),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await addColumnIfMissing("battle_daily_status", "bonus_challenge_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("rpg_daily_status", "bonus_expedition_count INTEGER NOT NULL DEFAULT 0");
  await execute("CREATE INDEX IF NOT EXISTS idx_battle_daily_status_player_date ON battle_daily_status(player_id, date_key)");
  await execute("CREATE INDEX IF NOT EXISTS idx_rpg_daily_status_player_date ON rpg_daily_status(player_id, date_key)");
  console.log("✅ daily limit schema ready：爭霸戰每日券/首通上限、遠征每日券");
}

const DEFAULT_SHOP_ITEMS = [
  { key: 'energy_battle_ticket_5', category: 'ENERGY', name: '爭霸戰補給 +5', description: '消耗能量，今日爭霸戰挑戰券額外 +5。', priceType: 'ENERGY', priceAmount: 100, limitType: 'DAILY', limitCount: 1, active: 1, payment: 0, sort: 10, tag: '每日限購', rewards: [['BATTLE_TICKET', 5]] },
  { key: 'energy_rpg_ticket_5', category: 'ENERGY', name: '遠征補給 +5', description: '消耗能量，今日遠征券額外 +5。', priceType: 'ENERGY', priceAmount: 100, limitType: 'DAILY', limitCount: 1, active: 1, payment: 0, sort: 20, tag: '每日限購', rewards: [['RPG_TICKET', 5]] },
  { key: 'energy_draw_1_weekly', category: 'ENERGY', name: '小型抽卡補給 +1', description: '消耗能量，抽卡次數 +1。', priceType: 'ENERGY', priceAmount: 300, limitType: 'WEEKLY', limitCount: 3, active: 1, payment: 0, sort: 30, tag: '每週限購', rewards: [['DRAW_TIMES', 1]] },

  { key: 'points_draw_1', category: 'POINTS', name: '抽卡次數 +1', description: '消耗訓練總分，抽卡次數 +1。', priceType: 'POINTS', priceAmount: 300, limitType: 'WEEKLY', limitCount: 3, active: 1, payment: 0, sort: 10, tag: '每週限購', rewards: [['DRAW_TIMES', 1]] },
  { key: 'points_battle_ticket_5', category: 'POINTS', name: '爭霸戰補給 +5', description: '消耗訓練總分，今日爭霸戰挑戰券額外 +5。', priceType: 'POINTS', priceAmount: 200, limitType: 'WEEKLY', limitCount: 2, active: 1, payment: 0, sort: 20, tag: '每週限購', rewards: [['BATTLE_TICKET', 5]] },
  { key: 'points_rpg_ticket_5', category: 'POINTS', name: '遠征補給 +5', description: '消耗訓練總分，今日遠征券額外 +5。', priceType: 'POINTS', priceAmount: 200, limitType: 'WEEKLY', limitCount: 2, active: 1, payment: 0, sort: 30, tag: '每週限購', rewards: [['RPG_TICKET', 5]] },
  { key: 'points_energy_100', category: 'POINTS', name: '能量包 +100', description: '消耗訓練總分，潮流能量 +100。', priceType: 'POINTS', priceAmount: 120, limitType: 'WEEKLY', limitCount: 5, active: 1, payment: 0, sort: 40, tag: '每週限購', rewards: [['ENERGY', 100]] },
  { key: 'points_premium_supply_monthly', category: 'POINTS', name: '高級補給包', description: '消耗訓練總分，抽卡次數 +3、潮流能量 +300。', priceType: 'POINTS', priceAmount: 1200, limitType: 'MONTHLY', limitCount: 1, active: 1, payment: 0, sort: 50, tag: '每月限購', rewards: [['DRAW_TIMES', 3], ['ENERGY', 300]] },
  { key: 'points_card_reset_ticket_monthly', category: 'POINTS', name: '卡牌重置券', description: '消耗訓練總分，獲得卡牌重置券 x1。可重置 1 張卡牌星等與技能，並退還資源。', priceType: 'POINTS', priceAmount: 3000, limitType: 'MONTHLY', limitCount: 1, active: 1, payment: 0, sort: 60, tag: '每月限購', rewards: [['ITEM', 1, 'CARD_RESET_TICKET']] },

  { key: 'cash_daily_33', category: 'TOPUP', name: '每日小禮包', description: '尚未啟用正式付款。內容：抽卡次數 +1、遠征補給 +1、爭霸戰補給 +1。', priceType: 'CASH', priceAmount: 33, limitType: 'DAILY', limitCount: 1, active: 1, payment: 0, sort: 10, tag: '每日限購', rewards: [['DRAW_TIMES', 1], ['RPG_TICKET', 1], ['BATTLE_TICKET', 1]] },
  { key: 'cash_newbie_500', category: 'TOPUP', name: '新人補給包', description: '尚未啟用正式付款。內容：抽卡次數 +8、潮流能量 +1000。', priceType: 'CASH', priceAmount: 500, limitType: 'ONCE', limitCount: 1, active: 1, payment: 0, sort: 20, tag: '每帳號限購', rewards: [['DRAW_TIMES', 8], ['ENERGY', 1000]] },
  { key: 'cash_card_reset_ticket_99', category: 'TOPUP', name: '卡牌重置券', description: '尚未啟用正式付款。內容：卡牌重置券 x1。', priceType: 'CASH', priceAmount: 99, limitType: 'WEEKLY', limitCount: 3, active: 1, payment: 0, sort: 25, tag: '每週限購', rewards: [['ITEM', 1, 'CARD_RESET_TICKET']] },
  { key: 'cash_first_charge_1000', category: 'TOPUP', name: '首儲大禮包', description: '尚未啟用正式付款。內容：抽卡次數 +17、潮流能量 +1000、技能經驗 +5000。', priceType: 'CASH', priceAmount: 1000, limitType: 'ONCE', limitCount: 1, active: 1, payment: 0, sort: 30, tag: '每帳號限購', rewards: [['DRAW_TIMES', 17], ['ENERGY', 1000], ['SKILL_EXP', 5000]] }
];


async function ensureProfileSocialSchema() {
  await execute(`CREATE TABLE IF NOT EXISTS player_profiles (
    player_id TEXT PRIMARY KEY,
    uid TEXT UNIQUE NOT NULL,
    display_name TEXT,
    bio TEXT,
    status TEXT NOT NULL DEFAULT 'ONLINE',
    last_seen_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS friend_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL,
    responded_at TEXT,
    UNIQUE(requester_id, receiver_id),
    FOREIGN KEY (requester_id) REFERENCES players(id),
    FOREIGN KEY (receiver_id) REFERENCES players(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS friendships (
    player_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (player_id, friend_id),
    FOREIGN KEY (player_id) REFERENCES players(id),
    FOREIGN KEY (friend_id) REFERENCES players(id)
  )`);
  await addColumnIfMissing("player_profiles", "uid TEXT");
  await addColumnIfMissing("player_profiles", "display_name TEXT");
  await addColumnIfMissing("player_profiles", "bio TEXT");
  await addColumnIfMissing("player_profiles", "status TEXT NOT NULL DEFAULT 'ONLINE'");
  await addColumnIfMissing("player_profiles", "last_seen_at TEXT");
  await addColumnIfMissing("player_profiles", "created_at TEXT");
  await addColumnIfMissing("player_profiles", "updated_at TEXT");
  await addColumnIfMissing("friend_requests", "responded_at TEXT");
  await execute("CREATE INDEX IF NOT EXISTS idx_player_profiles_uid ON player_profiles(uid)");
  await execute("CREATE INDEX IF NOT EXISTS idx_player_profiles_status_seen ON player_profiles(status, last_seen_at)");
  await execute("CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver_status ON friend_requests(receiver_id, status, created_at)");
  await execute("CREATE INDEX IF NOT EXISTS idx_friend_requests_requester_status ON friend_requests(requester_id, status, created_at)");
  await execute("CREATE INDEX IF NOT EXISTS idx_friendships_player_friend ON friendships(player_id, friend_id)");
  await execute("CREATE INDEX IF NOT EXISTS idx_friendships_friend_player ON friendships(friend_id, player_id)");
  const now = new Date().toISOString();
  const players = await queryAll("SELECT id, uid, display_name FROM players", []);
  for (const p of players) {
    await execute(
      `INSERT OR IGNORE INTO player_profiles (player_id, uid, display_name, bio, status, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, '', 'ONLINE', ?, ?, ?)`,
      [p.id, p.uid, p.display_name || p.uid, now, now, now]
    );
  }
  console.log("✅ profile / social schema ready：個人頁、好友邀請與好友列表已啟用；私訊功能未開放");
}

async function ensureShopSchema() {
  await addColumnIfMissing("battle_daily_status", "bonus_challenge_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing("rpg_daily_status", "bonus_expedition_count INTEGER NOT NULL DEFAULT 0");

  await execute(`CREATE TABLE IF NOT EXISTS shop_items (
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
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS shop_item_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_key TEXT NOT NULL,
    reward_type TEXT NOT NULL,
    reward_value INTEGER NOT NULL DEFAULT 0,
    card_name TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (product_key) REFERENCES shop_items(product_key)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS shop_purchase_logs (
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
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_shop_items_category_active_sort ON shop_items(category, is_active, sort_order)");
  await addColumnIfMissing("shop_item_rewards", "card_name TEXT");
  await execute("CREATE INDEX IF NOT EXISTS idx_shop_rewards_product_sort ON shop_item_rewards(product_key, sort_order)");
  await execute("CREATE INDEX IF NOT EXISTS idx_shop_purchase_player_product_period ON shop_purchase_logs(player_id, product_key, period_key)");
  await execute("CREATE INDEX IF NOT EXISTS idx_shop_purchase_player_created ON shop_purchase_logs(player_id, created_at)");
  await execute(`CREATE TABLE IF NOT EXISTS player_items (
    player_id TEXT NOT NULL,
    item_key TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (player_id, item_key),
    FOREIGN KEY (player_id) REFERENCES players(id)
  )`);
  await execute(`CREATE TABLE IF NOT EXISTS card_reset_logs (
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
  )`);
  await execute("CREATE INDEX IF NOT EXISTS idx_player_items_player_key ON player_items(player_id, item_key)");
  await execute("CREATE INDEX IF NOT EXISTS idx_card_reset_logs_player_created ON card_reset_logs(player_id, created_at)");

  const now = new Date().toISOString();
  for (const item of DEFAULT_SHOP_ITEMS) {
    await execute(`INSERT INTO shop_items (product_key, category, name, description, price_type, price_amount, limit_type, limit_count, is_active, is_payment_enabled, sort_order, tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(product_key) DO UPDATE SET
        category = excluded.category,
        name = excluded.name,
        description = excluded.description,
        price_type = excluded.price_type,
        price_amount = excluded.price_amount,
        limit_type = excluded.limit_type,
        limit_count = excluded.limit_count,
        is_active = excluded.is_active,
        is_payment_enabled = excluded.is_payment_enabled,
        sort_order = excluded.sort_order,
        tag = excluded.tag,
        updated_at = excluded.updated_at`,
      [item.key, item.category, item.name, item.description, item.priceType, item.priceAmount, item.limitType, item.limitCount, item.active, item.payment, item.sort, item.tag, now, now]
    );
    await execute("DELETE FROM shop_item_rewards WHERE product_key = ?", [item.key]);
    for (let i = 0; i < item.rewards.length; i++) {
      const [type, value, extra] = item.rewards[i];
      await execute("INSERT INTO shop_item_rewards (product_key, reward_type, reward_value, card_name, sort_order) VALUES (?, ?, ?, ?, ?)", [item.key, type, value, extra || null, (i + 1) * 10]);
    }
  }

  console.log("✅ shop schema ready：商城商品管理、限購紀錄、測試發獎已啟用；綠界 AIO 付款與卡牌重置券已啟用");
}

async function initSchema() {
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`找不到資料庫 schema 檔案：${schemaPath}`);
  }

  console.log(`🔧 init-db 使用資料庫：${dbProvider} / schema：${schemaFileName}`);

  const schema = fs.readFileSync(schemaPath, "utf8");
  const statements = schema
    .split(";")
    .map(s => s.trim())
    .filter(Boolean);

  // 先執行非索引語句，再跑各版本的補欄位遷移，最後才建立索引。
  // 原因：Supabase 既有資料表遇到 CREATE TABLE IF NOT EXISTS 不會自動補新欄位，
  // 若 schema 先建立 chapter_key / bonus_* 等新欄位索引，會出現 column does not exist。
  const indexStatements = [];
  for (const sql of statements) {
    if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(sql)) {
      indexStatements.push(sql);
      continue;
    }
    await execute(sql);
  }

  await ensureAuthSchema();
  await ensureAdminSchema();
  await ensureOpsRpgSchema();
  await ensureCharacterGrowthSchema();
  await ensureBossBattleV2Schema();
  await ensureLaunchMissionSchema();
  await ensureDailyLimitSchema();
  await ensureProfileSocialSchema();
  await ensureShopSchema();

  for (const sql of indexStatements) {
    await execute(sql);
  }

  console.log("✅ schema initialized");
}

async function upsertSeed() {
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const now = new Date().toISOString();

  for (const p of seed.players || []) {
    await execute(
      `INSERT INTO players (id, uid, display_name, recovery_code, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         uid = excluded.uid,
         display_name = excluded.display_name,
         recovery_code = excluded.recovery_code`,
      [p.id, p.uid, p.display_name || p.uid, p.recovery_code, now, now]
    );
  }

  for (const c of seed.cards || []) {
    await execute(
      `INSERT INTO cards (id, name, rarity, weight, image_url, is_drawable, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         rarity = excluded.rarity,
         weight = excluded.weight,
         image_url = excluded.image_url,
         is_drawable = excluded.is_drawable,
         sort_order = excluded.sort_order`,
      [c.id, c.name, c.rarity, c.weight || 0, c.image_url || "", c.is_drawable ? 1 : 0, c.sort_order || 0]
    );
  }

  for (const a of seed.player_assets || []) {
    await execute(
      `INSERT INTO player_assets (player_id, draw_times, trend_energy, total_topup, available_points, total_points, used_points, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         draw_times = excluded.draw_times,
         trend_energy = excluded.trend_energy,
         total_topup = excluded.total_topup,
         available_points = excluded.available_points,
         total_points = excluded.total_points,
         used_points = excluded.used_points,
         updated_at = excluded.updated_at`,
      [a.player_id, a.draw_times || 0, 0, a.total_topup || 0, a.available_points || 0, a.total_points || 0, a.used_points || 0, a.updated_at || now]
    );
  }

  for (const r of seed.player_collection || []) {
    await execute(
      `INSERT INTO player_collection (player_id, card_id, card_name, quantity, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id, card_id) DO UPDATE SET
         card_name = excluded.card_name,
         quantity = excluded.quantity,
         updated_at = excluded.updated_at`,
      [r.player_id, r.card_id, r.card_name, r.quantity || 0, r.updated_at || now]
    );
  }

  for (const r of seed.gacha_logs || []) {
    // 避免重複 seed 時大量重複匯入同一筆：用近似條件查一次。
    const exists = await queryOne(
      `SELECT id FROM gacha_logs WHERE player_id = ? AND card_name = ? AND source = ? AND note = ? AND created_at = ? LIMIT 1`,
      [r.player_id, r.card_name, r.source || "", r.note || "", r.created_at || now]
    );
    if (!exists) {
      await execute(
        `INSERT INTO gacha_logs (player_id, card_id, card_name, source, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.player_id, r.card_id || null, r.card_name, r.source || "", r.note || "", r.created_at || now]
      );
    }
  }

  for (const b of seed.boss_stages || []) {
    await execute(
      `INSERT INTO boss_stages (id, boss_card_id, boss_card_name, boss_power, stage_name, reward_draw_times)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         boss_card_id = excluded.boss_card_id,
         boss_card_name = excluded.boss_card_name,
         boss_power = excluded.boss_power,
         stage_name = excluded.stage_name,
         reward_draw_times = excluded.reward_draw_times`,
      [b.id, b.boss_card_id || null, b.boss_card_name, b.boss_power || 0, b.stage_name, b.reward_draw_times || 0]
    );
  }

  for (const p of seed.battle_progress || []) {
    await execute(
      `INSERT INTO battle_progress (player_id, current_stage_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         current_stage_id = excluded.current_stage_id,
         updated_at = excluded.updated_at`,
      [p.player_id, p.current_stage_id || 1, p.updated_at || now]
    );
  }

  for (const r of seed.battle_rewards || []) {
    await execute(
      `INSERT OR IGNORE INTO battle_rewards (player_id, stage_id, claimed_at)
       VALUES (?, ?, ?)`,
      [r.player_id, r.stage_id, r.claimed_at || now]
    );
  }

  for (const s of seed.card_stars || []) {
    await execute(
      `INSERT INTO card_stars (player_id, card_id, card_name, star, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(player_id, card_id) DO UPDATE SET
         card_name = excluded.card_name,
         star = excluded.star,
         updated_at = excluded.updated_at`,
      [s.player_id, s.card_id, s.card_name, s.star || 1, s.updated_at || now]
    );
  }

  for (const p of seed.training_profiles || []) {
    await execute(
      `INSERT INTO training_profiles
       (player_id, energy, total_score, streak, last_checkin_date, daily_key, memory_plays_today, quiz_done_today, title, max_memory_score, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         energy = excluded.energy,
         total_score = excluded.total_score,
         streak = excluded.streak,
         last_checkin_date = excluded.last_checkin_date,
         daily_key = excluded.daily_key,
         memory_plays_today = excluded.memory_plays_today,
         quiz_done_today = excluded.quiz_done_today,
         title = excluded.title,
         max_memory_score = excluded.max_memory_score,
         updated_at = excluded.updated_at`,
      [p.player_id, p.energy || 0, p.total_score || 0, p.streak || 0, p.last_checkin_date || "", p.daily_key || "", p.memory_plays_today || 0, p.quiz_done_today ? 1 : 0, p.title || "潮流新人", p.max_memory_score || 0, p.updated_at || now]
    );
  }

  for (const l of seed.training_logs || []) {
    const exists = await queryOne(
      `SELECT id FROM training_logs WHERE player_id = ? AND type = ? AND score = ? AND energy = ? AND note = ? AND created_at = ? LIMIT 1`,
      [l.player_id, l.type || "", l.score || 0, l.energy || 0, l.note || "", l.created_at || now]
    );
    if (!exists) {
      await execute(
        `INSERT INTO training_logs (player_id, type, score, energy, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [l.player_id, l.type || "", l.score || 0, l.energy || 0, l.note || "", l.created_at || now]
      );
    }
  }

  for (const d of seed.mini_daily_status || []) {
    await execute(
      `INSERT INTO mini_daily_status (player_id, date_key, shadow_plays_today, fortune_result, message_count_today, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id, date_key) DO UPDATE SET
         shadow_plays_today = excluded.shadow_plays_today,
         fortune_result = excluded.fortune_result,
         message_count_today = excluded.message_count_today,
         updated_at = excluded.updated_at`,
      [d.player_id, d.date_key || "", d.shadow_plays_today || 0, d.fortune_result || "", d.message_count_today || 0, d.updated_at || now]
    );
  }

  for (const m of seed.messages || []) {
    const exists = await queryOne(
      `SELECT id FROM messages WHERE masked_uid = ? AND message = ? AND created_at = ? LIMIT 1`,
      [m.masked_uid || "玩家", m.message || "", m.created_at || now]
    );
    if (!exists) {
      await execute(
        `INSERT INTO messages (player_id, masked_uid, message, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [m.player_id || null, m.masked_uid || "玩家", m.message || "", m.status || "OK", m.created_at || now]
      );
    }
  }

  for (const p of seed.pvp_players || []) {
    await execute(
      `INSERT INTO pvp_players (player_id, representative_card_name, representative_power, fragments, total_wins, total_losses, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id) DO UPDATE SET
         representative_card_name = excluded.representative_card_name,
         representative_power = excluded.representative_power,
         fragments = excluded.fragments,
         total_wins = excluded.total_wins,
         total_losses = excluded.total_losses,
         updated_at = excluded.updated_at`,
      [p.player_id, p.representative_card_name || "", p.representative_power || 0, p.fragments || 0, p.total_wins || 0, p.total_losses || 0, p.updated_at || now]
    );
  }

  for (const d of seed.pvp_daily_status || []) {
    await execute(
      `INSERT INTO pvp_daily_status (player_id, date_key, challenges, wins, fragment_claimed, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(player_id, date_key) DO UPDATE SET
         challenges = excluded.challenges,
         wins = excluded.wins,
         fragment_claimed = excluded.fragment_claimed,
         updated_at = excluded.updated_at`,
      [d.player_id, d.date_key || "", d.challenges || 0, d.wins || 0, d.fragment_claimed ? 1 : 0, d.updated_at || now]
    );
  }

  for (const l of seed.pvp_logs || []) {
    const exists = await queryOne(
      `SELECT id FROM pvp_logs WHERE player_id = ? AND my_card = ? AND opponent_card = ? AND my_power = ? AND opponent_power = ? AND result = ? AND created_at = ? LIMIT 1`,
      [l.player_id, l.my_card || "", l.opponent_card || "", l.my_power || 0, l.opponent_power || 0, l.result || "", l.created_at || now]
    );
    if (!exists) {
      await execute(
        `INSERT INTO pvp_logs (player_id, date_key, my_card, opponent_masked_uid, opponent_card, my_power, opponent_power, result, reward, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [l.player_id, l.date_key || "", l.my_card || "", l.opponent_masked_uid || "", l.opponent_card || "", l.my_power || 0, l.opponent_power || 0, l.result || "", l.reward || "", l.created_at || now]
      );
    }
  }

  await ensureBossBattleV2Schema();
  await ensureLaunchMissionSchema();
  await ensureDailyLimitSchema();
  await ensureAuthSchema();
  await ensureAdminSchema();
  console.log("✅ seed imported");
  console.log({
    players: (seed.players || []).length,
    cards: (seed.cards || []).length,
    gachaLogs: (seed.gacha_logs || []).length,
    collections: (seed.player_collection || []).length
  });
}

await initSchema();
if (process.argv.includes("--seed")) {
  await upsertSeed();
}