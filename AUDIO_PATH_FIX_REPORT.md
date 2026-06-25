# 連線討伐戰音效路徑修正報告

## 修正原因
使用者已將連線討伐戰 `.mp3` 音效統一移到前端 `audio/` 資料夾。原本 `js/link-battle.js` 的音效路徑指向前端根目錄，例如 `./boss_warning.mp3`，可能導致遊戲找不到音效。

## 已修正內容
- 將 `frontend/tlo-frontend-main/js/link-battle.js` 的連線討伐戰音效路徑全部改為 `./audio/`。
- 將原本放在前端根目錄的連線討伐戰音效搬到 `frontend/tlo-frontend-main/audio/`。
- 新增 `frontend/tlo-frontend-main/audio/README_AUDIO_FILES.txt`，列出目前需要的音效檔名。

## 現在正確音效位置
`frontend/tlo-frontend-main/audio/`

## 連線討伐戰音效檔名
- `boss_warning.mp3`
- `boss_attack.mp3`
- `boss_hit_player.mp3`
- `card_merge.mp3`
- `card_hit_boss.mp3`
- `combo_bonus.mp3`
- `battle_victory.mp3`
- `battle_failed.mp3`
- `player_attack_normal.mp3`
- `player_attack_rare.mp3`
- `player_attack_super_rare.mp3`
- `player_attack_ssr.mp3`
- `player_attack_ur.mp3`

## 檢查結果
- `node --check frontend/tlo-frontend-main/js/link-battle.js`：通過
- 前端根目錄不再需要放置連線討伐戰 `.mp3` 音效
- 後端不需要修改
