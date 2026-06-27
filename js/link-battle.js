(function () {
  'use strict';

  var state = {
    dashboard: null,
    selectedStageId: null,
    runId: null,
    battle: null,
    selectedTileId: null,
    isAnimating: false,
    timerId: null,
    timeLeft: 0,
    hintedIds: new Set(),
    rulesShown: false,
    pendingStageSelectAfterRules: false,
    stageSelectOpen: false,
    openChapterKey: null,
    linkPath: null,
    boardMetrics: null,
    teamPickerOpen: false,
    teamDraftIds: [],
    teamPanelOpen: false,
    nextStageIdAfterVictory: null,
    bossDefeatAnimationRunId: null,
    lastStoryStageId: null,
    pendingScenePrimary: null,
    pendingSceneSecondary: null
  };

  var TLO_LINK_BATTLE_BUILD = '20260627-boss-main-hp-v1';
  try { console.info('[TLO LinkBattle] build', TLO_LINK_BATTLE_BUILD); } catch (e) {}

  var AUDIO_BASE_PATH = './audio/';
  var AUDIO = {
    boss_warning: AUDIO_BASE_PATH + 'boss_warning.mp3',
    boss_attack: AUDIO_BASE_PATH + 'boss_attack.mp3',
    boss_hit_player: AUDIO_BASE_PATH + 'boss_hit_player.mp3',
    card_merge: AUDIO_BASE_PATH + 'card_merge.mp3',
    card_hit_boss: AUDIO_BASE_PATH + 'card_hit_boss.mp3',
    combo_bonus: AUDIO_BASE_PATH + 'combo_bonus.mp3',
    battle_victory: AUDIO_BASE_PATH + 'battle_victory.mp3',
    battle_failed: AUDIO_BASE_PATH + 'battle_failed.mp3',
    player_attack_normal: AUDIO_BASE_PATH + 'player_attack_normal.mp3',
    player_attack_rare: AUDIO_BASE_PATH + 'player_attack_rare.mp3',
    player_attack_super_rare: AUDIO_BASE_PATH + 'player_attack_super_rare.mp3',
    player_attack_ssr: AUDIO_BASE_PATH + 'player_attack_ssr.mp3',
    player_attack_ur: AUDIO_BASE_PATH + 'player_attack_ur.mp3'
  };

  function $(id) { return document.getElementById(id); }
  function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }
  function jsArg(value) {
    return escapeHtml(JSON.stringify(String(value == null ? '' : value)));
  }
  function sleep(ms) { return new Promise(function(resolve){ setTimeout(resolve, ms); }); }


  function uniqueImageUrls(urls) {
    var seen = new Set();
    return (Array.isArray(urls) ? urls : [urls]).map(function(url){ return String(url || '').trim(); }).filter(function(url){
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
  }

  function preloadGameImages(urls, options) {
    var list = uniqueImageUrls(urls);
    if (!list.length) return Promise.resolve([]);
    if (window.TLOImageLoader && typeof window.TLOImageLoader.preload === 'function') {
      return window.TLOImageLoader.preload(list, options || { timeout: 2600, concurrency: 6, fetchPriority: 'high' });
    }
    return Promise.resolve([]);
  }

  function collectLinkBattleImageUrls(battleState) {
    var b = battleState || {};
    var urls = [];
    var boss = b.boss || (b.stage && b.stage.boss) || {};
    if (boss.bossImage) urls.push(boss.bossImage);
    if (boss.bossBackground) urls.push(boss.bossBackground);
    var tiles = (b.boardData && b.boardData.tiles) || flattenBoardForRender(b.board || []);
    (tiles || []).forEach(function(tile){ if (tile && tile.image_url) urls.push(tile.image_url); });
    (b.supportCards || []).forEach(function(card){ if (card && (card.imageUrl || card.image_url)) urls.push(card.imageUrl || card.image_url); });
    return uniqueImageUrls(urls);
  }

  function preloadLinkBattleImages(battleState) {
    var urls = collectLinkBattleImageUrls(battleState);
    if (!urls.length) return Promise.resolve([]);
    setMsg('正在預載本場 BOSS 與卡牌圖片...', '#00fff0');
    return preloadGameImages(urls, { timeout: 2800, concurrency: 8, fetchPriority: 'high' });
  }


  var LINK_BATTLE_CH1_CONTENT = {
    chapterName: '第一章｜墮落的熾天使',
    chapterTag: '墮落聖域遠征',
    stages: {
      1: { stageTitle: '聖域外廊', bossName: '殘翼守望者', bossIntro: '失去羽翼的守望者徘徊在外廊裂口，仍執行早已扭曲的護衛命令。', battleIntro: '外圍結界已經崩落，第一道防線由殘翼守望者把守。先突破這裡，才能真正踏入墮落聖域。', clearStory: '外廊的結界碎片逐漸黯淡。你從守望者的殘破誓言中，得知聖域深處還有更高階的墮化者。', node: '外廊裂口', tier: 'normal' },
      2: { stageTitle: '斷羽巡禮', bossName: '血印巡戒者', bossIntro: '巡戒者在牆面留下血印標記，任何闖入者都會被視為褻瀆者。', battleIntro: '循著殘翼守望者留下的血痕前進，巡戒者已經察覺你的氣息。', clearStory: '巡戒者的血印失去光芒，通往內環的走廊短暫安靜了下來。', node: '巡戒迴廊', tier: 'normal' },
      3: { stageTitle: '破碎聖牆', bossName: '斷罪執盾兵', bossIntro: '這名執盾兵以斷裂的聖盾阻絕前路，象徵過去聖域最後的秩序。', battleIntro: '破碎的聖牆仍殘留防禦術式，執盾兵正站在牆前鎮守缺口。', clearStory: '聖盾碎裂後，牆內的封印線路露出來，你看見更深處牢獄區的地圖殘片。', node: '聖牆缺口', tier: 'normal' },
      4: { stageTitle: '暮鐘走道', bossName: '失序聖堂衛', bossIntro: '昔日守衛聖堂的戰士，如今只會盲目追逐每一次鐘聲。', battleIntro: '暮鐘響起，整條走道的怨念都被喚醒。若不擊倒聖堂衛，鐘聲會不斷召集敵影。', clearStory: '鐘聲戛然而止。走道盡頭的封門開始鬆動，露出一條通往內城的狹縫。', node: '暮鐘走道', tier: 'normal' },
      5: { stageTitle: '墮翼門廳', bossName: '墮天守門將', bossIntro: '守門將統領外層墮化者，是第一個真正阻攔遠征的精英守門者。', battleIntro: '你抵達聖域內門。墮天守門將展開殘翼，宣告所有外來者都將止步於此。', clearStory: '守門將倒下後，第一道內門終於敞開。你確定這場討伐不是單純的清剿，而是深入聖域核心的遠征。', node: '第一道內門', tier: 'mini' },
      6: { stageTitle: '鐵鎖迴廊', bossName: '枷鎖司祭', bossIntro: '司祭以鎖鏈代替禱文，把受刑者的哀號編成束縛術。', battleIntro: '越過內門後，空氣變得沉重。鐵鎖迴廊裡滿是用於囚禁叛徒的拘束咒。', clearStory: '枷鎖司祭的鎖鏈斷裂，走廊深處傳來沉重鐵門開啟的回音。', node: '鐵鎖迴廊', tier: 'normal' },
      7: { stageTitle: '懺罪牢階', bossName: '黑鐵懺罪官', bossIntro: '黑鐵懺罪官專門審判不服從者，並以痛楚迫使靈魂屈服。', battleIntro: '階梯兩側刻滿懺罪文，懺罪官已經將你列入審判名單。', clearStory: '審判台崩裂，牢階之下露出更多囚室，證明這裡曾鎮壓無數異端。', node: '牢階審判台', tier: 'normal' },
      8: { stageTitle: '縛魂牢域', bossName: '縛魂監視者', bossIntro: '它藉由觀測靈魂波動來封殺逃脫者，是牢域最危險的監控者。', battleIntro: '牢域的燈火逐一亮起，縛魂監視者從高處凝視你的每一步。', clearStory: '監視者熄滅後，困在牢域的殘魂終於稍稍平靜，為你指向主牢方向。', node: '牢域外圈', tier: 'normal' },
      9: { stageTitle: '聖鎖祭壇', bossName: '聖鎖審問官', bossIntro: '審問官將聖性與刑罰混為一談，讓祭壇成為最殘酷的拷問室。', battleIntro: '祭壇的光芒不再神聖，反而像是專門審問入侵者的牢籠。', clearStory: '祭壇封印鬆動，主牢的真正看守者似乎已經感應到你的到來。', node: '審問祭壇', tier: 'normal' },
      10: { stageTitle: '獄門終鎖', bossName: '聖鎖獄卒', bossIntro: '獄卒掌控整座牢域的拘束之力，每一條鎖鏈都回應他的號令。', battleIntro: '你終於抵達主牢獄門。聖鎖獄卒從層層鎖鏈間現身，準備親手執行最後的封殺。', clearStory: '獄卒被擊退後，主牢完全解放。殘魂留下關鍵警告：真正扭曲聖域命運的，是一名仍在深層低語的神諭者。', node: '主牢獄門', tier: 'mini' },
      11: { stageTitle: '祕典前庭', bossName: '狂信詠唱者', bossIntro: '狂信詠唱者不停誦讀失控經文，使整片前庭籠罩在偏執的共鳴中。', battleIntro: '走出牢域後，你踏入記錄聖域歷史的前庭。然而此地經文已被改寫成煽動瘋狂的咒歌。', clearStory: '經文殘頁四散，你從其中拼湊出關於神諭大廳的殘缺紀錄。', node: '祕典前庭', tier: 'normal' },
      12: { stageTitle: '裂光書庫', bossName: '畸光預言徒', bossIntro: '這名預言徒被異常光芒侵蝕，能在書庫中扭曲視線與方向。', battleIntro: '裂光書庫內的每一道光束都可能是陷阱，預言徒正躲在其中觀察你的失誤。', clearStory: '光束失去控制後，書庫中央的導引星圖重新顯現，為你指出正確路徑。', node: '裂光書庫', tier: 'normal' },
      13: { stageTitle: '逆位星廳', bossName: '混沌讀星者', bossIntro: '讀星者不再解讀天命，而是將錯亂星象當成武器操弄戰場。', battleIntro: '星廳的天穹全部逆轉。若不擊破讀星者，整個大廳都會變成無法辨識方向的迷宮。', clearStory: '逆位星圖破碎後，你開始看見神諭者留下的真正路標。', node: '逆位星廳', tier: 'normal' },
      14: { stageTitle: '噤聲觀測台', bossName: '逆位觀測者', bossIntro: '觀測者剝奪一切聲音，讓入侵者在無聲中逐漸失去判斷。', battleIntro: '踏上觀測台時，所有雜音都被抽離，只剩視野中愈發濃烈的異象。', clearStory: '無聲結界消退，遠方終於傳來深層大廳的鐘律。', node: '觀測台', tier: 'normal' },
      15: { stageTitle: '神諭回廊', bossName: '混沌神諭者', bossIntro: '掌握扭曲預言的神諭者，已經能將命運本身改寫為通往混沌的路徑。', battleIntro: '回廊盡頭，混沌神諭者正等待你的到來。他宣稱聖域的墮落並非災難，而是進化。', clearStory: '神諭者敗退時留下最後一段預言：真正的終末正在上層空域甦醒。你知道遠征已進入後半段。', node: '神諭大廳', tier: 'mini' },
      16: { stageTitle: '失重回橋', bossName: '虛蝕翼侍', bossIntro: '翼侍在失重空橋間來回穿梭，以虛蝕之力侵蝕來者的意志。', battleIntro: '離開大廳後，道路轉為懸空空橋。稍有失誤，就會墜入下方的虛無裂縫。', clearStory: '空橋恢復穩定，上層聖歌的殘響開始傳入耳中。', node: '失重回橋', tier: 'normal' },
      17: { stageTitle: '殘歌長廊', bossName: '無光聖歌隊', bossIntro: '這支聖歌隊早已失去光明，只剩無盡低鳴在長廊中迴盪。', battleIntro: '長廊本該是迎接榮光的儀式之路，如今卻成了詭異合唱的巢穴。', clearStory: '殘歌停歇後，長廊兩側的封翼碑開始崩落。', node: '殘歌長廊', tier: 'normal' },
      18: { stageTitle: '裂界升降座', bossName: '裂界傳令官', bossIntro: '傳令官負責連接各層空域，能驅使裂界之風干擾所有接近者。', battleIntro: '升降座已被裂界風暴包圍。唯有擊倒傳令官，才能上行至更高層。', clearStory: '風暴平息，升降座再次運作，你正式進入聖域最危險的上層空域。', node: '裂界升降座', tier: 'normal' },
      19: { stageTitle: '空域斷章', bossName: '空域斷章使', bossIntro: '斷章使蒐集破碎祕典，把整片空域變成無序漂浮的記憶殘章。', battleIntro: '半空中漂浮的斷章遮蔽視野，稍一分神就會被捲入無序書頁。', clearStory: '斷章逐一墜落，遠方的王座輪廓開始出現。', node: '斷章空域', tier: 'normal' },
      20: { stageTitle: '虛空門扉', bossName: '虛無司門者', bossIntro: '司門者看守通往內殿的門扉，是上層空域第一位真正的門關。', battleIntro: '厚重門扉前的光芒被完全抽空。虛無司門者拒絕任何生者繼續前行。', clearStory: '門扉鬆動，內殿的寒意撲面而來。你意識到真正的熾天階層已近在眼前。', node: '虛空門扉', tier: 'mini' },
      21: { stageTitle: '墮曜中庭', bossName: '墮曜巡禮者', bossIntro: '巡禮者沿著中庭不斷繞行，用墮曜之火焚去一切不潔。', battleIntro: '中庭曾是聖域最莊嚴的朝拜區，如今只剩墮曜火焰與扭曲祈禱。', clearStory: '火焰略微減弱，前往王座庭園的石階終於顯露完整。', node: '中庭火環', tier: 'normal' },
      22: { stageTitle: '聖骸石階', bossName: '聖骸束縛者', bossIntro: '束縛者以聖骸碎片築成囚牢，讓石階本身也成為陷阱。', battleIntro: '踏上石階後，你發現每一塊階石都藏著束縛術，束縛者就在高處等待。', clearStory: '石階上的骸紋崩碎，通往庭園的視野被打開。', node: '聖骸石階', tier: 'normal' },
      23: { stageTitle: '灰燼庭園', bossName: '灰燼記錄官', bossIntro: '記錄官焚燒所有不被允許的歷史，讓真相只剩灰燼。', battleIntro: '庭園裡飄散著無數灰燼。每一片都像是被抹去的一段歷史。', clearStory: '你從未燒盡的殘片中，讀到最上層存在一位失名熾翼。', node: '灰燼庭園', tier: 'normal' },
      24: { stageTitle: '熾翼回廊', bossName: '失名熾翼', bossIntro: '失去名字的熾翼守衛，在回廊中徘徊，只為服從最終王座的意志。', battleIntro: '回廊的羽光不再純白，這裡已成為內殿最後的迴響地帶。', clearStory: '失名熾翼消散後，王座內殿的大門徹底展開。', node: '熾翼回廊', tier: 'normal' },
      25: { stageTitle: '內殿門衛', bossName: '虛無熾天侍', bossIntro: '熾天侍是最終王座前的高階精英，僅次於真正的熾天使。', battleIntro: '你來到王座內殿門前，虛無熾天侍展翼降臨，宣告凡人不得踏入終焉領域。', clearStory: '熾天侍敗退後，王座廳堂完全顯現。你能感受到核心深處的巨大威壓正在蘇醒。', node: '王座內殿門前', tier: 'mini' },
      26: { stageTitle: '冠冕迴座', bossName: '空洞冠冕', bossIntro: '失控的冠冕自主意識化，漂浮在王座周圍汲取殘存聖力。', battleIntro: '尚未見到最終敵人前，王座四周的冠冕殘器便率先甦醒。', clearStory: '冠冕墜落地面，王座周圍的力場出現裂隙。', node: '冠冕迴座', tier: 'normal' },
      27: { stageTitle: '熾翼王座前庭', bossName: '斷章熾翼王', bossIntro: '熾翼王以殘缺榮耀統御前庭，是最終熾天使的最後護衛長。', battleIntro: '前庭的每一道羽痕都像劍鋒，熾翼王不允許任何人接近王座正廳。', clearStory: '護衛長倒下後，王座門扉不再有守護者，只剩令人窒息的靜默。', node: '王座前庭', tier: 'normal' },
      28: { stageTitle: '深淵聖歌壇', bossName: '深淵鳴奏者', bossIntro: '鳴奏者以深淵聖歌維持王座結界，是終末降臨前最後的儀式者。', battleIntro: '聖歌壇中央的樂律正支撐整個內殿結界，必須先破壞這份演奏。', clearStory: '樂律中斷，結界開始快速鬆動，最終戰的氣息愈發明顯。', node: '聖歌壇', tier: 'normal' },
      29: { stageTitle: '終末門前', bossName: '終末開門者', bossIntro: '開門者受命迎接終末，握有啟動王座最終儀式的鑰印。', battleIntro: '終末門前只剩最後一位守衛。他要以自己的生命，換取虛無熾天使完全甦醒。', clearStory: '鑰印粉碎後，終末之門終於緩緩開啟。你已站在最終決戰的入口。', node: '終末之門', tier: 'normal' },
      30: { stageTitle: '終焉王座', bossName: '虛無熾天使．亞薩洛斯', bossIntro: '亞薩洛斯曾是聖域最接近光明的熾天使，如今卻以虛無之力統御整座墮落聖域。', battleIntro: '終焉王座前，虛無熾天使．亞薩洛斯終於現身。他宣稱一切秩序終將歸於虛無，而你正是最後的阻礙。', clearStory: '亞薩洛斯的羽翼逐漸化為光塵，墮落聖域的震動也慢慢平息。第一章告一段落，但聖域深處仍藏著更大的真相。', node: '終焉王座', tier: 'final' }
    }
  };

  function getStageNarrative(stageOrNumber) {
    var n = typeof stageOrNumber === 'number' ? stageOrNumber : getStageNumber(stageOrNumber);
    return (LINK_BATTLE_CH1_CONTENT.stages && LINK_BATTLE_CH1_CONTENT.stages[n]) || null;
  }

  function getStageTier(stage) {
    var content = getStageNarrative(stage);
    if (content && content.tier) return content.tier;
    var n = getStageNumber(stage);
    if (n === 30) return 'final';
    if (n > 0 && n % 5 === 0) return 'mini';
    return 'normal';
  }

  function getStageTierLabel(stage) {
    var tier = getStageTier(stage);
    return tier === 'final' ? '章節最終 BOSS' : (tier === 'mini' ? '章節小 BOSS' : '一般戰');
  }

  function getStageNodeLabel(stage) {
    var content = getStageNarrative(stage);
    return (content && content.node) || (stage && stage.chapterName) || '墮落聖域';
  }

  function getDisplayStageName(stage) {
    if (!stage) return '卡牌連線討伐戰';
    var content = getStageNarrative(stage);
    if (content && content.stageTitle) return '第' + getStageNumber(stage) + '關｜' + content.stageTitle;
    return stage.stageName || '卡牌連線討伐戰';
  }

  function getDisplayBossName(stage) {
    var content = getStageNarrative(stage);
    if (content && content.bossName) return content.bossName;
    var boss = stage && stage.boss || {};
    return boss.bossName || '連線戰 BOSS';
  }

  function getDisplayBossIntro(stage) {
    var content = getStageNarrative(stage);
    if (content && content.bossIntro) return content.bossIntro;
    return String(stage && stage.boss && stage.boss.description || '');
  }

  function getBattleIntroText(stage) {
    var content = getStageNarrative(stage);
    return (content && content.battleIntro) || '請連線相同卡牌，突破敵陣，向 BOSS 發起討伐。';
  }

  function getClearStoryText(stage) {
    var content = getStageNarrative(stage);
    return (content && content.clearStory) || '你成功突破本關的阻礙，前方道路暫時打開。';
  }

  function buildSceneSummaryHtml(items) {
    var list = Array.isArray(items) ? items.filter(Boolean) : [];
    return list.map(function(item) {
      return '<div class="item"><span>' + escapeHtml(item.label || '') + '</span><b>' + escapeHtml(item.value || '') + '</b></div>';
    }).join('');
  }

  function closeSceneModal() {
    var modal = $('link-battle-scene-modal');
    if (modal) modal.classList.remove('active');
    state.pendingScenePrimary = null;
    state.pendingSceneSecondary = null;
  }

  function openSceneModal(options) {
    options = options || {};
    var modal = $('link-battle-scene-modal');
    var card = $('link-battle-scene-card');
    var badge = $('link-battle-scene-badge');
    var title = $('link-battle-scene-title');
    var subtitle = $('link-battle-scene-subtitle');
    var body = $('link-battle-scene-body');
    var summary = $('link-battle-scene-summary');
    var primary = $('link-battle-scene-primary');
    var secondary = $('link-battle-scene-secondary');
    if (!modal || !card || !badge || !title || !subtitle || !body || !summary || !primary || !secondary) return;
    card.className = 'link-battle-scene-card' + (options.type ? ' type-' + options.type : '');
    badge.textContent = options.badge || '戰鬥資訊';
    title.textContent = options.title || '討伐資訊';
    subtitle.textContent = options.subtitle || '';
    body.innerHTML = String(options.body || '').replace(/\n/g, '<br>');
    summary.innerHTML = buildSceneSummaryHtml(options.summaryItems || []);
    primary.textContent = options.primaryText || '確認';
    secondary.textContent = options.secondaryText || '關閉';
    state.pendingScenePrimary = typeof options.onPrimary === 'function' ? options.onPrimary : function(){ closeSceneModal(); };
    state.pendingSceneSecondary = typeof options.onSecondary === 'function' ? options.onSecondary : function(){ closeSceneModal(); };
    modal.classList.add('active');
  }

  function scenePrimaryAction() {
    if (typeof state.pendingScenePrimary === 'function') return state.pendingScenePrimary();
    closeSceneModal();
  }

  function sceneSecondaryAction() {
    if (typeof state.pendingSceneSecondary === 'function') return state.pendingSceneSecondary();
    closeSceneModal();
  }

  function updateBossLorePanel(stage) {
    var badgeEl = $('link-battle-stage-badge');
    var nodeEl = $('link-battle-stage-node');
    var loreEl = $('link-battle-boss-lore');
    if (badgeEl) {
      badgeEl.textContent = getStageTierLabel(stage);
      badgeEl.className = 'link-battle-boss-tier' + (getStageTier(stage) === 'mini' ? ' tier-mini' : (getStageTier(stage) === 'final' ? ' tier-final' : ''));
    }
    if (nodeEl) nodeEl.textContent = getStageNodeLabel(stage);
    if (loreEl) loreEl.textContent = getDisplayBossIntro(stage) || 'BOSS 情報讀取中...';
  }


  function normalizeImageUrlForCompare(url) {
    return String(url || '').trim().replace(/([?&])v=[^&]*/g, '$1').replace(/[?&]$/, '');
  }

  function getBossVisual(stage) {
    var boss = stage && stage.boss || {};
    var bossImage = String(boss.bossImage || '').trim();
    var bossBackground = String(boss.bossBackground || '').trim();
    // 若資料庫舊資料把 boss_image 同時塞進 boss_background，避免同一張圖同時變成背景與主圖。
    if (bossImage && bossBackground && normalizeImageUrlForCompare(bossImage) === normalizeImageUrlForCompare(bossBackground)) bossBackground = '';
    return { bossImage: bossImage, bossBackground: bossBackground };
  }

  function applyBossBackground(stage) {
    var bg = $('link-battle-boss-bg');
    if (!bg) return;
    var visual = getBossVisual(stage);
    bg.style.backgroundImage = visual.bossBackground ? 'url("' + visual.bossBackground + '")' : '';
  }

  function renderBossFigure(stage) {
    var figure = $('link-battle-boss-figure');
    if (!figure) return;
    var visual = getBossVisual(stage || {});
    var tier = getStageTier(stage || {});
    figure.className = 'link-battle-boss-figure tier-' + tier + (visual.bossImage ? ' has-image' : ' no-image');
    if (visual.bossImage) {
      figure.innerHTML = '<img class="link-battle-boss-main-image tlo-card-art" src="' + escapeHtml(visual.bossImage) + '" alt="' + escapeHtml(getDisplayBossName(stage || {})) + '" loading="eager" decoding="async" fetchpriority="high">';
      var img = figure.querySelector('img');
      if (img && window.TLOImageLoader && typeof window.TLOImageLoader.enhanceImage === 'function') window.TLOImageLoader.enhanceImage(img);
    } else {
      figure.innerHTML = '<span class="link-battle-boss-main-silhouette">BOSS</span>';
    }
  }

  function maybeShowPreBattleStory(stage) {
    return new Promise(function(resolve) {
      if (!stage) return resolve(true);
      if (state.lastStoryStageId === stage.stageId) return resolve(true);
      openSceneModal({
        type: 'prebattle',
        badge: '戰前劇情',
        title: getDisplayStageName(stage),
        subtitle: getDisplayBossName(stage) + '｜' + getStageTierLabel(stage),
        body: getBattleIntroText(stage),
        summaryItems: [
          { label: '關卡節點', value: getStageNodeLabel(stage) },
          { label: 'BOSS 目標', value: getDisplayBossName(stage) },
          { label: '時間限制', value: String(Number(stage.timeLimitSeconds || 0)) + ' 秒' },
          { label: '盤面規格', value: String(Number(stage.rows || 0)) + ' × ' + String(Number(stage.cols || 0)) + '｜' + String(Number(stage.layerCount || 1)) + ' 層' }
        ],
        primaryText: '開始討伐',
        secondaryText: '略過劇情',
        onPrimary: function(){ state.lastStoryStageId = stage.stageId; closeSceneModal(); resolve(true); },
        onSecondary: function(){ state.lastStoryStageId = stage.stageId; closeSceneModal(); resolve(true); }
      });
    });
  }

  function showVictoryScene(rewardSummary) {
    var b = state.battle || {};
    var stage = b.stage || {};
    openSceneModal({
      type: 'victory',
      badge: '通關結果',
      title: '擊敗 ' + getDisplayBossName(stage),
      subtitle: getDisplayStageName(stage),
      body: getClearStoryText(stage),
      summaryItems: [
        { label: '剩餘 HP', value: Math.max(0, Number(b.playerHp || 0)).toLocaleString() + ' / ' + Number(b.playerMaxHp || 0).toLocaleString() },
        { label: '最高 Combo', value: String(Number(b.maxCombo || b.combo || 0)) },
        { label: '剩餘時間', value: formatTime(state.timeLeft || b.remainingSeconds || 0) },
        { label: '通關獎勵', value: rewardSummary || '本關無額外獎勵' }
      ],
      primaryText: '關閉',
      secondaryText: state.nextStageIdAfterVictory ? '下一關待命' : '返回章節',
      onPrimary: function(){ closeSceneModal(); },
      onSecondary: function(){ closeSceneModal(); if (state.nextStageIdAfterVictory) { setMsg('已準備下一關，按下下方「下一關」即可直接挑戰。', '#00fff0'); } else { openStageSelect(); } }
    });
  }

  function showFailureScene(reason) {
    var b = state.battle || {};
    var stage = b.stage || {};
    openSceneModal({
      type: 'failure',
      badge: '討伐失敗',
      title: getDisplayStageName(stage),
      subtitle: '未能擊敗 ' + getDisplayBossName(stage),
      body: formatLinkBattleEndReason(reason) + '\n\n建議重新整理連線節奏，優先保留可連線路徑，避免過多失誤與無效洗牌。',
      summaryItems: [
        { label: 'BOSS 剩餘 HP', value: Math.max(0, Number(b.bossHp || 0)).toLocaleString() + ' / ' + Number(b.bossMaxHp || 0).toLocaleString() },
        { label: '玩家剩餘 HP', value: Math.max(0, Number(b.playerHp || 0)).toLocaleString() + ' / ' + Number(b.playerMaxHp || 0).toLocaleString() },
        { label: '錯誤次數', value: Number(b.errorCount || 0) + ' / ' + Number(stage.errorLimit || 0) },
        { label: '最高 Combo', value: String(Number(b.maxCombo || b.combo || 0)) }
      ],
      primaryText: '再次討伐',
      secondaryText: '關閉',
      onPrimary: function(){ closeSceneModal(); retryBattle(); },
      onSecondary: function(){ closeSceneModal(); }
    });
  }


  // v7：手機瀏覽器實際可視高度修正。
  // iPhone Safari / Chrome 的網址列會改變可視高度，單純 100vh 容易把底部按鈕擠出畫面。
  function updateViewportVars() {
    try {
      var vv = window.visualViewport;
      var h = vv && vv.height ? vv.height : window.innerHeight;
      var w = vv && vv.width ? vv.width : window.innerWidth;
      if (!h || h < 320) h = window.innerHeight || 720;
      document.documentElement.style.setProperty('--tlo-link-vh', Math.floor(h) + 'px');
      document.documentElement.style.setProperty('--tlo-link-vw', Math.floor(w || window.innerWidth || 390) + 'px');
    } catch (_) {}
  }

  function scheduleBoardRerender(delay) {
    clearTimeout(resizeRenderTimer);
    resizeRenderTimer = setTimeout(function() {
      updateViewportVars();
      if (state.battle) renderBoard();
    }, delay || 120);
  }

  function playAudio(key) {
    try {
      if (localStorage.getItem('TLO_SOUND_ENABLED') !== '1') return;
      var src = AUDIO[key];
      if (!src) return;
      var a = new Audio(src);
      a.volume = key.indexOf('boss') >= 0 ? 0.72 : 0.58;
      var result = a.play();
      if (result && typeof result.catch === 'function') result.catch(function(){});
    } catch (_) {}
  }

  function playAttackByRarity(rarity) {
    var key = 'player_attack_' + String(rarity || 'Normal').toLowerCase().replace(/\s+/g, '_');
    if (!AUDIO[key]) key = 'player_attack_normal';
    playAudio(key);
  }

  function callRpc(method, args) {
    return new Promise(function(resolve, reject) {
      google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[method].apply(null, args || []);
    });
  }

  function formatTime(sec) {
    var n = Math.max(0, Math.floor(Number(sec || 0)));
    var m = Math.floor(n / 60);
    var s = n % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function setMsg(html, color) {
    var el = $('link-battle-msg');
    if (!el) return;
    el.style.color = color || '#aaa';
    el.innerHTML = html || '';
  }

  function setButtonsDisabled(disabled) {
    ['link-battle-start-btn','link-battle-hint-btn','link-battle-shuffle-btn'].forEach(function(id) {
      var el = $(id);
      if (el) el.disabled = !!disabled;
    });
  }

  function isBattleActive() {
    return !!(state.battle && state.battle.status !== 'victory' && state.battle.status !== 'failed');
  }

  function updateShellMode() {
    var shell = $('link-battle-shell');
    if (!shell) return;
    var active = isBattleActive();
    shell.classList.toggle('in-battle', active);
    var startBtn = $('link-battle-start-btn');
    if (startBtn) {
      // v8：底部三顆按鈕永遠保留位置，不再隱藏開始 / 再次討伐按鈕。
      startBtn.style.display = '';
      if (active) {
        startBtn.innerHTML = '⚔️ 戰鬥中';
        startBtn.disabled = true;
      } else if (state.battle && state.battle.status === 'victory' && state.nextStageIdAfterVictory) {
        startBtn.innerHTML = '➡️ 下一關';
        startBtn.disabled = false;
      } else {
        startBtn.innerHTML = state.battle && state.battle.status === 'failed' ? '⚔️ 再次討伐' : '⚔️ 開始挑戰';
        startBtn.disabled = false;
      }
    }
  }

  function openModal() {
    updateViewportVars();
    var modal = $('link-battle-modal');
    if (modal) modal.style.display = 'flex';
    setTimeout(function(){ scheduleBoardRerender(40); }, 40);
    state.pendingStageSelectAfterRules = true;
    loadDashboard();
    // v9：每次進入模式都先顯示規則；關閉規則後再開啟章節與關卡選擇。
    setTimeout(function() {
      state.rulesShown = true;
      openRules();
    }, 180);
  }

  function openRules() {
    var el = $('link-battle-rules');
    if (el) el.classList.add('active');
  }

  function closeRules(options) {
    var el = $('link-battle-rules');
    if (el) el.classList.remove('active');
    var shouldOpenSelector = state.pendingStageSelectAfterRules || (options && options.openStageSelect);
    state.pendingStageSelectAfterRules = false;
    if (shouldOpenSelector) setTimeout(function(){ openStageSelect(); }, 80);
  }

  async function startFromRules() {
    // 保留舊 onclick 名稱，但 v9 流程改為：規則 → 章節與關卡選擇 → 開始挑戰。
    closeRules({ openStageSelect: true });
  }

  function openStageSelect() {
    state.stageSelectOpen = true;
    state.openChapterKey = null;
    renderStageSelect();
    var el = $('link-battle-stage-select');
    if (el) el.classList.add('active');
  }

  function closeStageSelect() {
    state.stageSelectOpen = false;
    var el = $('link-battle-stage-select');
    if (el) el.classList.remove('active');
  }

  function closeModal() {
    stopTimer();
    var modal = $('link-battle-modal');
    if (modal) modal.style.display = 'none';
  }

  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
  }

  function startTimer(seconds) {
    stopTimer();
    state.timeLeft = Number(seconds || 0);
    updateTimerText();
    if (state.timeLeft <= 0) return;
    state.timerId = setInterval(function() {
      if (!state.battle || state.battle.status === 'victory' || state.battle.status === 'failed') return stopTimer();
      state.timeLeft -= 1;
      updateTimerText();
      if (state.timeLeft <= 0) {
        stopTimer();
        state.battle.status = 'failed';
        setMsg('<b style="color:#ff7777">時間耗盡，討伐失敗。</b>', '#ff7777');
        playAudio('battle_failed');
        setButtonsDisabled(true);
      }
    }, 1000);
  }

  function updateTimerText() {
    var el = $('link-battle-time');
    if (el) el.textContent = formatTime(state.timeLeft);
  }

  async function loadDashboard(stageId) {
    setMsg('正在讀取卡牌連線討伐戰資料...', '#00fff0');
    try {
      var res = await callRpc('getLinkBattleDashboard', [window.playerUID || window.TLO_PLAYER_UID || '', stageId || state.selectedStageId || null]);
      if (!res || !res.success) throw new Error((res && res.msg) || '讀取失敗');
      state.dashboard = res;
      state.selectedStageId = res.selectedStageId || (res.selectedStage && res.selectedStage.stageId) || state.selectedStageId;
      renderDashboard();
      if (!res.canEnter) {
        setMsg(escapeHtml(res.msg || '你的圖鑑卡牌不足，至少解鎖 4 種卡牌後，才能進入卡牌連線討伐戰。').replace(/\n/g,'<br>'), '#ffdd77');
      } else {
        setMsg('請選擇關卡並開始挑戰。', '#aaa');
      }
    } catch (err) {
      setMsg('讀取失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    }
  }

  function getStageNumber(stage) {
    var order = Number(stage && stage.stageOrder || 0);
    if (order > 0) return order;
    var id = String(stage && stage.stageId || '');
    var m = id.match(/(\d+)$/);
    return m ? Number(m[1]) : 0;
  }

  function parseLinkBattleRewardConfig(config) {
    if (!config) return {};
    if (typeof config === 'object') return config;
    try { return JSON.parse(String(config)); } catch (e) { return {}; }
  }

  function getStageDrawRewardAmount(stage) {
    var config = parseLinkBattleRewardConfig(stage && (stage.rewardConfig || stage.reward_config));
    var type = String(config.type || config.rewardType || config.reward_type || '').toUpperCase();
    var amount = Math.max(0, Math.floor(Number(config.amount || config.rewardValue || config.reward_value || 0)));
    if ((type === 'DRAW_TIMES' || type === 'DRAW_ATTEMPTS' || type === 'DRAW') && amount > 0) return amount;
    var text = String(stage && stage.rewardText || '');
    var match = text.match(/抽卡次數\s*\+\s*(\d+)/);
    return match ? Math.max(0, Math.floor(Number(match[1] || 0))) : 0;
  }

  function getDashboardChapters(dash, stages) {
    var chapters = (dash && (dash.linkBattleChapters || dash.chapters)) || [];
    var out = [];
    if (Array.isArray(chapters) && chapters.length) {
      out = chapters.map(function(ch) {
        var key = ch.chapterKey || ch.chapter_key || ch.key || ch.chapterName || ch.name || 'chapter';
        var stageList = Array.isArray(ch.stages) ? ch.stages : stages.filter(function(s){ return (s.chapterKey || s.chapterName) === key || s.chapterName === (ch.chapterName || ch.name); });
        return {
          chapterKey: key,
          chapterName: ch.chapterName || ch.name || '未命名章節',
          description: ch.description || '',
          enabled: ch.enabled !== false,
          placeholder: !!ch.placeholder,
          stages: stageList
        };
      });
    } else {
      var map = new Map();
      stages.forEach(function(stage) {
        var chapterName = stage.chapterName || '墮落的熾天使';
        var chapterKey = stage.chapterKey || chapterName;
        if (!map.has(chapterKey)) map.set(chapterKey, { chapterKey: chapterKey, chapterName: chapterName, description: '', enabled: true, stages: [] });
        map.get(chapterKey).stages.push(stage);
      });
      out = Array.from(map.values());
    }
    var realCount = out.filter(function(ch){ return ch.enabled !== false && !ch.placeholder; }).length;
    if (realCount <= 1) {
      out.push({ chapterKey: 'coming_soon', chapterName: '暫未開放', description: '更多連線討伐戰章節準備中。', enabled: false, placeholder: true, stages: [] });
    }
    return out;
  }

  function toggleStageChapter(chapterKey) {
    state.openChapterKey = state.openChapterKey === chapterKey ? null : chapterKey;
    renderStageSelect();
  }

  function getCardId(card) {
    return String((card && (card.cardId || card.card_id || card.id)) || '');
  }

  function getCardName(card) {
    return String((card && (card.cardName || card.card_name || card.name)) || '未命名角色');
  }

  function getCardImage(card) {
    return String((card && (card.imageUrl || card.image_url || card.image)) || '');
  }

  function getCurrentTeamIds() {
    var team = (state.dashboard && (state.dashboard.linkBattleTeam || state.dashboard.team)) || {};
    var ids = Array.isArray(team.cardIds) ? team.cardIds : (Array.isArray(team.cards) ? team.cards.map(getCardId) : []);
    return ids.map(function(id){ return String(id || '').trim(); }).filter(Boolean).slice(0, 3);
  }

  function getEligibleCardsSorted() {
    var cards = ((state.dashboard && state.dashboard.eligibleCards) || []).slice();
    var rank = { UR: 5, SSR: 4, 'SUPER RARE': 3, RARE: 2, Normal: 1, NORMAL: 1 };
    cards.sort(function(a, b) {
      if (Number(b.power || 0) !== Number(a.power || 0)) return Number(b.power || 0) - Number(a.power || 0);
      var br = rank[String(b.rarity || '').toUpperCase()] || rank[String(b.rarity || '')] || 0;
      var ar = rank[String(a.rarity || '').toUpperCase()] || rank[String(a.rarity || '')] || 0;
      if (br !== ar) return br - ar;
      return getCardName(a).localeCompare(getCardName(b), 'zh-Hant');
    });
    return cards;
  }

  function findEligibleCard(cardId) {
    var id = String(cardId || '');
    return getEligibleCardsSorted().find(function(card){ return getCardId(card) === id; }) || null;
  }

  function getTeamBonus() {
    var dash = state.dashboard || {};
    var team = dash.linkBattleTeam || {};
    return dash.teamBonus || team.bonus || { attackBonusPercent: 0, hpBonusPercent: 0, summary: '攻擊 +0%，HP +0%' };
  }

  function renderTeamSlot(card, role) {
    if (!card) {
      return '<div class="link-battle-team-slot empty"><span>' + escapeHtml(role) + '</span><b>未選擇</b></div>';
    }
    var image = getCardImage(card);
    return '<div class="link-battle-team-slot">'
      + '<span>' + escapeHtml(role) + '</span>'
      + (image ? '<img src="' + escapeHtml(image) + '" alt="' + escapeHtml(getCardName(card)) + '" loading="lazy" decoding="async">' : '<div class="link-battle-team-slot-fallback">🎴</div>')
      + '<b>' + escapeHtml(getCardName(card)) + '</b>'
      + '<em>戰力 ' + Number(card.power || 0).toLocaleString() + '</em>'
      + '</div>';
  }

  function renderTeamSlotsFromIds(ids) {
    var list = (ids || []).map(findEligibleCard);
    var roles = ['隊長', '隊員', '隊員'];
    var html = '<div class="link-battle-team-slots">';
    for (var i = 0; i < 3; i += 1) html += renderTeamSlot(list[i], roles[i]);
    html += '</div>';
    return html;
  }

  function renderPreBattlePanel(stage) {
    if (!stage || !stage.unlocked) return '';
    var ids = getCurrentTeamIds();
    var bonus = getTeamBonus();
    var bonusText = bonus.summary || ('攻擊 +' + Number(bonus.attackBonusPercent || 0) + '%，HP +' + Number(bonus.hpBonusPercent || 0) + '%');
    var open = !!state.teamPanelOpen;
    var cardNames = ids.map(findEligibleCard).filter(Boolean).map(getCardName);
    var teamText = cardNames.length ? cardNames.join('、') : '尚未編隊';
    return '<div class="link-battle-prebattle-panel ' + (open ? 'open' : 'collapsed') + '">'
      + '<button type="button" class="link-battle-prebattle-toggle" onclick="TLOLinkBattle.toggleTeamPanel()">'
      + '<div><span>出戰編隊</span><b>' + escapeHtml(getDisplayStageName(stage)) + '</b><small>' + escapeHtml(teamText) + '</small></div>'
      + '<em>' + escapeHtml(bonusText) + '</em><i>' + (open ? '收合' : '展開') + '</i>'
      + '</button>'
      + '<div class="link-battle-prebattle-compact-actions">'
      + '<button type="button" onclick="TLOLinkBattle.openTeamPicker()">更換編隊</button>'
      + '<button type="button" class="primary" onclick="TLOLinkBattle.startSelectedStage()">開始挑戰</button>'
      + '</div>'
      + '<div class="link-battle-prebattle-body">'
      + renderTeamSlotsFromIds(ids)
      + '<div class="link-battle-team-bonus">' + escapeHtml(bonusText) + '</div>'
      + '<div class="link-battle-prebattle-actions">'
      + '<button type="button" onclick="TLOLinkBattle.openTeamPicker()">更換編隊</button>'
      + '<button type="button" onclick="TLOLinkBattle.autoLinkBattleTeam()">自動編隊</button>'
      + '<button type="button" class="primary" onclick="TLOLinkBattle.startSelectedStage()">開始挑戰</button>'
      + '</div>'
      + '</div>'
      + '</div>';
  }

  function toggleTeamPanel() {
    state.teamPanelOpen = !state.teamPanelOpen;
    renderDashboard();
  }

  function renderTeamPicker() {
    var root = $('link-battle-team-picker-content');
    if (!root) return;
    var cards = getEligibleCardsSorted();
    var ids = state.teamDraftIds || [];
    var selected = new Set(ids);
    if (!cards.length) {
      root.innerHTML = '<div class="link-battle-stage-select-empty">目前沒有可出戰的卡片。</div>';
      return;
    }
    var html = '<div class="link-battle-team-picker-summary">'
      + '<div><span>目前選擇</span><b>' + ids.length + ' / 3</b></div>'
      + '<em>隊長位會略高權重；編隊只提供小幅攻擊與 HP 加成。</em>'
      + '</div>';
    html += renderTeamSlotsFromIds(ids);
    html += '<div class="link-battle-team-picker-actions">'
      + '<button type="button" onclick="TLOLinkBattle.autoLinkBattleTeam()">自動編隊</button>'
      + '<button type="button" class="primary" onclick="TLOLinkBattle.saveTeamDraft()">儲存編隊</button>'
      + '</div>';
    html += '<div class="link-battle-team-card-grid">';
    html += cards.map(function(card) {
      var id = getCardId(card);
      var picked = selected.has(id);
      var image = getCardImage(card);
      return '<button type="button" class="link-battle-team-card-option ' + (picked ? 'selected' : '') + '" onclick="TLOLinkBattle.toggleTeamCard(' + jsArg(id) + ')">'
        + (image ? '<img src="' + escapeHtml(image) + '" alt="' + escapeHtml(getCardName(card)) + '" loading="lazy" decoding="async">' : '<div class="link-battle-team-card-fallback">🎴</div>')
        + '<strong>' + escapeHtml(getCardName(card)) + '</strong>'
        + '<span>' + escapeHtml(card.rarity || 'Normal') + '｜★' + Number(card.star || 1) + '</span>'
        + '<em>戰力 ' + Number(card.power || 0).toLocaleString() + '</em>'
        + '<i>' + (picked ? '已出戰' : '選擇') + '</i>'
        + '</button>';
    }).join('');
    html += '</div>';
    root.innerHTML = html;
  }

  function openTeamPicker() {
    state.teamPickerOpen = true;
    state.teamDraftIds = getCurrentTeamIds();
    renderTeamPicker();
    var el = $('link-battle-team-picker');
    if (el) el.classList.add('active');
  }

  function closeTeamPicker() {
    state.teamPickerOpen = false;
    var el = $('link-battle-team-picker');
    if (el) el.classList.remove('active');
  }

  function toggleTeamCard(cardId) {
    var id = String(cardId || '');
    if (!id) return;
    var ids = (state.teamDraftIds || []).slice();
    var index = ids.indexOf(id);
    if (index >= 0) ids.splice(index, 1);
    else {
      if (ids.length >= 3) {
        setMsg('出戰編隊最多選擇 3 張卡牌。', '#ffdd77');
        return;
      }
      ids.push(id);
    }
    state.teamDraftIds = ids;
    renderTeamPicker();
  }

  async function saveTeamDraft() {
    try {
      var res = await callRpc('setLinkBattleTeam', [window.playerUID || window.TLO_PLAYER_UID || '', state.teamDraftIds || []]);
      if (!res || !res.success) throw new Error((res && res.msg) || '編隊儲存失敗');
      if (res.dashboard) state.dashboard = res.dashboard;
      closeTeamPicker();
      renderDashboard();
      setMsg('出戰編隊已儲存。', '#00fff0');
    } catch (err) {
      setMsg('編隊儲存失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    }
  }

  async function autoLinkBattleTeam() {
    try {
      var cards = getEligibleCardsSorted().slice(0, 3);
      var ids = cards.map(getCardId).filter(Boolean);
      var res = await callRpc('setLinkBattleTeam', [window.playerUID || window.TLO_PLAYER_UID || '', ids]);
      if (!res || !res.success) throw new Error((res && res.msg) || '自動編隊失敗');
      if (res.dashboard) state.dashboard = res.dashboard;
      state.teamDraftIds = getCurrentTeamIds();
      renderDashboard();
      if (state.teamPickerOpen) renderTeamPicker();
      setMsg('已自動選擇目前戰力最高的 3 張卡牌。', '#00fff0');
    } catch (err) {
      setMsg('自動編隊失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    }
  }

  function renderStageSelect() {
    var root = $('link-battle-stage-select-content');
    if (!root) return;
    var dash = state.dashboard || {};
    var stages = dash.stages || [];
    if (!dash.canEnter) {
      root.innerHTML = '<div class="link-battle-stage-select-empty">' + escapeHtml(dash.msg || '你的圖鑑卡牌不足，暫時無法進入連線討伐戰。').replace(/\n/g, '<br>') + '</div>';
      return;
    }
    if (!stages.length) {
      root.innerHTML = '<div class="link-battle-stage-select-empty">目前沒有開放的連線討伐戰關卡。</div>';
      return;
    }
    var chapters = getDashboardChapters(dash, stages);
    root.innerHTML = chapters.map(function(chapter) {
      var chapterKey = String(chapter.chapterKey || chapter.chapterName || 'chapter');
      var isPlaceholder = chapter.placeholder || chapter.enabled === false;
      var opened = state.openChapterKey === chapterKey && !isPlaceholder;
      var chStages = chapter.stages || [];
      var cleared = chStages.filter(function(s){ return !!s.cleared; }).length;
      var total = chStages.length;
      var subText = isPlaceholder ? '暫未開放' : (cleared + ' / ' + total + ' 通關');
      var html = '<section class="link-battle-chapter-block ' + (opened ? 'open ' : '') + (isPlaceholder ? 'coming-soon' : '') + '">'
        + '<button type="button" class="link-battle-chapter-toggle" ' + (isPlaceholder ? 'disabled' : '') + ' onclick="TLOLinkBattle.toggleStageChapter(\'' + escapeHtml(chapterKey) + '\')">'
        + '<div><span>章節</span><b>' + escapeHtml(chapter.chapterName || '未命名章節') + '</b>'
        + (chapter.description ? '<small>' + escapeHtml(chapter.description) + '</small>' : '') + '</div>'
        + '<em>' + escapeHtml(subText) + '</em>'
        + '<i>' + (isPlaceholder ? '🔒' : (opened ? '收起 ▲' : '展開 ▼')) + '</i>'
        + '</button>';
      if (opened) {
        html += '<div class="link-battle-stage-scroll-pane"><div class="link-battle-stage-card-grid">';
        html += chStages.map(function(stage) {
          var boss = stage.boss || {};
          var n = getStageNumber(stage);
          var cls = ['link-battle-stage-card'];
          if (stage.stageId === state.selectedStageId) cls.push('current');
          if (stage.cleared) cls.push('cleared');
          if (!stage.unlocked) cls.push('locked');
          var drawRewardAmount = getStageDrawRewardAmount(stage);
          var rewardHtml = drawRewardAmount > 0 ? '<div class="link-battle-stage-card-reward">首次獎勵：抽卡次數 +' + drawRewardAmount + '</div>' : '';
          var progressText = stage.cleared ? ('已通關' + (stage.progress && stage.progress.clearCount ? ' x ' + Number(stage.progress.clearCount) : '')) : '未通關';
          if (getStageTier(stage) === 'mini') cls.push('stage-mini');
          if (getStageTier(stage) === 'final') cls.push('stage-final');
          return '<button type="button" class="' + cls.join(' ') + '" ' + (!stage.unlocked ? 'disabled' : '') + ' onclick="TLOLinkBattle.chooseStageAndStart(\'' + escapeHtml(stage.stageId) + '\')">'
            + '<div class="link-battle-stage-card-top"><strong>第 ' + n + ' 關</strong><span>' + escapeHtml(progressText) + '</span></div>'
            + '<div class="link-battle-stage-card-title">' + escapeHtml(getDisplayStageName(stage)) + '</div>'
            + '<div class="link-battle-stage-card-boss">BOSS：' + escapeHtml(getDisplayBossName(stage)) + '</div>'
            + '<div class="link-battle-stage-card-sub">' + escapeHtml(getDisplayBossIntro(stage)) + '</div>'
            + '<div class="link-battle-stage-card-badges">'
            + '<span class="link-battle-stage-card-badge ' + (getStageTier(stage) === 'mini' ? 'mini' : (getStageTier(stage) === 'final' ? 'final' : '')) + '">' + escapeHtml(getStageTierLabel(stage)) + '</span>'
            + '<span class="link-battle-stage-card-badge">' + escapeHtml(getStageNodeLabel(stage)) + '</span>'
            + '</div>'
            + rewardHtml
            + '<div class="link-battle-stage-card-cta">' + (stage.unlocked ? (stage.stageId === state.selectedStageId ? '已選擇' : '選擇關卡') : '尚未解鎖') + '</div>'
            + '</button>';
        }).join('');
        html += '</div>';
        var selectedInChapter = chStages.find(function(s){ return s.stageId === state.selectedStageId; });
        if (selectedInChapter) html += renderPreBattlePanel(selectedInChapter);
        html += '</div>';
      }
      html += '</section>';
      return html;
    }).join('');
  }

  function selectStageForTeam(stageId) {
    if (state.isAnimating) return;
    state.teamPanelOpen = false;
    state.selectedStageId = stageId;
    renderDashboard();
    setMsg('已選擇關卡，確認出戰編隊後即可開始挑戰。', '#d9c7ff');
  }

  async function startSelectedStage() {
    if (state.isAnimating) return;
    closeStageSelect();
    renderDashboard();
    await startBattle();
  }

  async function chooseStageAndStart(stageId) {
    if (state.isAnimating) return;
    // 下一關：沿用目前已儲存的出戰編隊，直接開始下一關，不再回到編隊確認流程。
    state.selectedStageId = stageId;
    state.teamPanelOpen = false;
    state.nextStageIdAfterVictory = null;
    closeStageSelect();
    renderDashboard();
    await startBattle();
  }

  function renderDashboard() {
    var list = $('link-battle-stage-list');
    var dash = state.dashboard || {};
    var stages = dash.stages || [];
    if (list) {
      list.innerHTML = stages.map(function(stage) {
        var cls = ['link-battle-stage-btn'];
        if (stage.stageId === state.selectedStageId) cls.push('current');
        if (stage.cleared) cls.push('cleared');
        if (!stage.unlocked) cls.push('locked');
        return '<button class="' + cls.join(' ') + '" ' + (!stage.unlocked ? 'disabled' : '') + ' onclick="TLOLinkBattle.selectStage(' + jsArg(stage.stageId) + ')">' + Number(stage.stageOrder || 0) + '</button>';
      }).join('') || '<span class="muted">尚無開放關卡。</span>';
    }
    var stage = stages.find(function(s){ return s.stageId === state.selectedStageId; }) || dash.selectedStage || stages[0];
    if (stage) renderStagePreview(stage);
    var startBtn = $('link-battle-start-btn');
    if (startBtn) startBtn.disabled = !dash.canEnter || !stage || !stage.unlocked;
    updateShellMode();
    if (state.stageSelectOpen) renderStageSelect();
  }

  function renderStagePreview(stage) {
    var boss = stage.boss || {};
    applyBossBackground(stage);
    renderBossFigure(stage);
    if ($('link-battle-stage-name')) $('link-battle-stage-name').textContent = getDisplayStageName(stage);
    if ($('link-battle-boss-name')) $('link-battle-boss-name').textContent = getDisplayBossName(stage);
    updateBossLorePanel(stage);
    if ($('link-battle-boss-hp-text')) $('link-battle-boss-hp-text').textContent = '尚未開始';
    if ($('link-battle-player-hp')) $('link-battle-player-hp').textContent = '--';
    if ($('link-battle-combo')) $('link-battle-combo').textContent = '0';
    if ($('link-battle-rage-fill')) $('link-battle-rage-fill').style.width = '0%';
    if ($('link-battle-hpfill')) $('link-battle-hpfill').style.width = '100%';
    if ($('link-battle-time')) $('link-battle-time').textContent = formatTime(stage.timeLimitSeconds || 0);
    var center = $('link-battle-boss-center');
    if (center) center.innerHTML = '';
  }

  function selectStage(stageId) {
    selectStageForTeam(stageId);
  }

  async function startOrRetryBattle() {
    if (state.battle && state.battle.status === 'failed') return retryBattle();
    if (state.battle && state.battle.status === 'victory') {
      if (state.nextStageIdAfterVictory) return chooseStageAndStart(state.nextStageIdAfterVictory);
      return openStageSelect();
    }
    return startBattle();
  }

  async function startBattle(options) {
    if (state.isAnimating) return;
    options = options || {};
    var dash = state.dashboard || {};
    var stages = dash.stages || [];
    var stage = stages.find(function(s){ return s.stageId === state.selectedStageId; }) || dash.selectedStage || stages[0] || null;
    if (!options.skipStory) await maybeShowPreBattleStory(stage);
    setButtonsDisabled(true);
    setMsg('正在產生連線卡牌盤面...', '#00fff0');
    try {
      var res = await callRpc('startLinkBattle', [window.playerUID || window.TLO_PLAYER_UID || '', state.selectedStageId]);
      if (!res || !res.success) {
        if (res && res.dashboard) state.dashboard = res.dashboard;
        renderDashboard();
        setMsg(escapeHtml((res && res.msg) || '無法開始挑戰').replace(/\n/g,'<br>'), '#ffdd77');
        setButtonsDisabled(false);
        return;
      }
      await preloadLinkBattleImages(res.state).catch(function(){});
      state.runId = res.runId;
      state.battle = res.state;
      state.selectedTileId = null;
      state.hintedIds = new Set();
      state.linkPath = null;
      state.nextStageIdAfterVictory = null;
      renderBattleState();
      startTimer(state.battle.stage && state.battle.stage.timeLimitSeconds);
      setMsg('✦ 連線相同卡牌，合成攻擊 BOSS！ ✦', '#d9c7ff');
      setButtonsDisabled(false);
    } catch (err) {
      setMsg('開始失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
      setButtonsDisabled(false);
    }
  }

  function renderBattleState() {
    var b = state.battle || {};
    var boss = b.boss || (b.stage && b.stage.boss) || {};
    var visualStage = b.stage || { boss: boss };
    applyBossBackground(visualStage);
    renderBossFigure(visualStage);
    if ($('link-battle-stage-name')) $('link-battle-stage-name').textContent = getDisplayStageName(visualStage);
    if ($('link-battle-boss-name')) $('link-battle-boss-name').textContent = getDisplayBossName(visualStage);
    updateBossLorePanel(visualStage);
    var hpPct = b.bossMaxHp > 0 ? Math.max(0, Math.min(100, Math.round(Number(b.bossHp || 0) / Number(b.bossMaxHp || 1) * 100))) : 0;
    if ($('link-battle-hpfill')) $('link-battle-hpfill').style.width = hpPct + '%';
    if ($('link-battle-boss-hp-text')) $('link-battle-boss-hp-text').textContent = Math.max(0, Number(b.bossHp || 0)).toLocaleString() + ' / ' + Number(b.bossMaxHp || 0).toLocaleString();
    if ($('link-battle-player-hp')) $('link-battle-player-hp').textContent = Math.max(0, Number(b.playerHp || 0)).toLocaleString() + ' / ' + Number(b.playerMaxHp || 0).toLocaleString();
    if ($('link-battle-combo')) $('link-battle-combo').textContent = Number(b.combo || 0);
    if ($('link-battle-error')) $('link-battle-error').textContent = Number(b.errorCount || 0) + ' / ' + Number((b.stage && b.stage.errorLimit) || 0);
    if ($('link-battle-shuffle-left')) $('link-battle-shuffle-left').textContent = Number(b.shuffleLeft || 0);
    if ($('link-battle-hint-left')) $('link-battle-hint-left').textContent = Number(b.hintLeft || 0);
    var rageLimit = Number((b.stage && b.stage.bossRageLimit) || 100);
    var ragePct = Math.max(0, Math.min(100, Math.round(Number(b.bossRage || 0) / rageLimit * 100)));
    if ($('link-battle-rage-fill')) $('link-battle-rage-fill').style.width = ragePct + '%';
    var center = $('link-battle-boss-center');
    if (center) center.innerHTML = '';
    renderBoard();
    var active = !state.isAnimating && b.status !== 'victory' && b.status !== 'failed';
    if ($('link-battle-hint-btn')) $('link-battle-hint-btn').disabled = !active || Number(b.hintLeft || 0) <= 0;
    if ($('link-battle-shuffle-btn')) $('link-battle-shuffle-btn').disabled = !active || Number(b.shuffleLeft || 0) <= 0;
    updateShellMode();
  }

  function getBoardDimensions(board) {
    var layers = (board || []).length || 1;
    var rows = 1;
    var cols = 1;
    (board || []).forEach(function(layer) {
      rows = Math.max(rows, (layer || []).length || 0);
      (layer || []).forEach(function(row) { cols = Math.max(cols, (row || []).length || 0); });
    });
    return { layers: layers, rows: rows, cols: cols };
  }

  function flattenBoardForRender(board) {
    var tiles = [];
    for (var layer = 0; layer < (board || []).length; layer++) {
      for (var row = 0; row < (board[layer] || []).length; row++) {
        for (var col = 0; col < (board[layer][row] || []).length; col++) {
          var tile = board[layer][row][col];
          if (tile) tiles.push(Object.assign({}, tile, { layer: layer, row: row, col: col, selectable: isTileSelectable(tile) }));
        }
      }
    }
    return tiles;
  }

  function getTileVisualCenter(tile) {
    var m = state.boardMetrics;
    if (!m || !tile) return null;
    var row = Number(tile.row || 0);
    var col = Number(tile.col || 0);
    var inset = Number(m.tileInset || 5);
    var x = inset + (col * m.colStep) + (m.tileW / 2);
    var y = inset + (row * m.rowStep) + (m.tileH / 2);
    return { x: x, y: y };
  }

  function getPathPointCenter(point) {
    var m = state.boardMetrics;
    if (!m || !point) return null;
    var row = Number(point.row || 0);
    var col = Number(point.col || 0);
    var inset = Number(m.tileInset || 5);
    var x = inset + (col * m.colStep) + (m.tileW / 2);
    var y = inset + (row * m.rowStep) + (m.tileH / 2);
    // 路徑可走到盤面外圍一格；視覺上把線段裁在操作區內，避免破框。
    x = Math.max(5, Math.min(m.boardW - 5, x));
    y = Math.max(5, Math.min(m.boardH - 5, y));
    return { x: x, y: y };
  }

  function compressPolylinePoints(points) {
    var out = [];
    points.forEach(function(p) {
      if (!p) return;
      if (out.length && Math.abs(out[out.length - 1].x - p.x) < 0.5 && Math.abs(out[out.length - 1].y - p.y) < 0.5) return;
      out.push(p);
      while (out.length >= 3) {
        var a = out[out.length - 3];
        var b = out[out.length - 2];
        var c = out[out.length - 1];
        var sameX = Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5;
        var sameY = Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5;
        if (!sameX && !sameY) break;
        out.splice(out.length - 2, 1);
      }
    });
    return out;
  }

  function renderLinkPathOverlay() {
    var linkPath = state.linkPath;
    var m = state.boardMetrics;
    if (!linkPath || !m) return '';
    var raw = [];
    if (Array.isArray(linkPath.points) && linkPath.points.length >= 2) {
      raw = linkPath.points.map(getPathPointCenter).filter(Boolean);
    } else if (linkPath.tileA && linkPath.tileB) {
      raw = [getTileVisualCenter(linkPath.tileA), getTileVisualCenter(linkPath.tileB)].filter(Boolean);
    }
    var pts = compressPolylinePoints(raw);
    if (pts.length < 2) return '';
    var pointText = pts.map(function(p){ return Math.round(p.x) + ',' + Math.round(p.y); }).join(' ');
    var type = linkPath.type === 'error' ? 'error' : 'success';
    var html = '<svg class="link-battle-path-overlay ' + type + '" viewBox="0 0 ' + Math.round(m.boardW) + ' ' + Math.round(m.boardH) + '" preserveAspectRatio="none" aria-hidden="true">';
    html += '<polyline class="link-battle-path-line" points="' + pointText + '"></polyline>';
    pts.forEach(function(p, idx) {
      html += '<circle class="link-battle-path-dot ' + (idx === 0 || idx === pts.length - 1 ? 'end' : 'turn') + '" cx="' + Math.round(p.x) + '" cy="' + Math.round(p.y) + '" r="' + (idx === 0 || idx === pts.length - 1 ? 5 : 4) + '"></circle>';
    });
    if (type === 'error') {
      var mid = pts[Math.floor(pts.length / 2)];
      html += '<text class="link-battle-path-x" x="' + Math.round(mid.x) + '" y="' + Math.round(mid.y + 7) + '" text-anchor="middle">×</text>';
    }
    html += '</svg>';
    return html;
  }

  function formatLinkBattleInvalidReason(reason) {
    var map = {
      EMPTY_TILE: '卡牌不存在',
      SAME_TILE: '不能選同一張卡牌',
      COVERED_TILE: '卡牌目前不可選擇，不能連線',
      DIFFERENT_CARD: '必須選擇同一張卡牌',
      PATH_BLOCKED: '路徑被其他卡牌阻擋，或超過 2 次轉彎'
    };
    return map[String(reason || '')] || String(reason || '連線失敗');
  }

  function formatLinkBattleEndReason(reason) {
    var map = {
      DAMAGE_NOT_ENOUGH: '卡牌已全數消除，但傷害不足，討伐失敗。',
      PLAYER_HP_ZERO: '玩家 HP 歸零，討伐失敗。',
      ERROR_LIMIT: '錯誤次數過多，討伐失敗。',
      NO_MOVES: '沒有可連線組合且洗牌次數已用完，討伐失敗。',
      TIMEOUT: '時間耗盡，討伐失敗。',
      FAILED: '討伐失敗。'
    };
    return map[String(reason || '')] || '討伐失敗。';
  }

  function renderBoard() {
    var wrap = $('link-battle-board');
    if (!wrap) return;
    var b = state.battle || {};
    var data = b.boardData || {};
    var board = (data.board || b.board || []);
    if (!board.length) {
      wrap.innerHTML = '<div class="link-battle-board-empty">選擇關卡後開始挑戰。</div>';
      return;
    }

    var dims = getBoardDimensions(board);
    var renderTiles = (data.tiles && data.tiles.length ? data.tiles : flattenBoardForRender(board)).map(function(tile) {
      return Object.assign({}, tile, {
        layer: Number(tile.layer || 0),
        row: Number(tile.row || 0),
        col: Number(tile.col || 0)
      });
    });

    var isMobileBrowser = (window.matchMedia && window.matchMedia('(max-width: 560px)').matches) || window.innerWidth <= 560;
    var rect = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : null;
    var wrapWidth = Math.max(isMobileBrowser ? 250 : 300, Math.floor((rect && rect.width) || wrap.clientWidth || 360));
    var wrapHeight = Math.max(isMobileBrowser ? 220 : 340, Math.floor((rect && rect.height) || wrap.clientHeight || 380));
    var usableWidth = Math.max(isMobileBrowser ? 238 : 278, wrapWidth - (isMobileBrowser ? 8 : 14));
    var usableHeight = Math.max(isMobileBrowser ? 212 : 308, wrapHeight - (isMobileBrowser ? 8 : 14));
    var aspect = 1.34;

    // v12：規矩格子盤面。卡牌大小只由 rows/cols 與操作區大小決定，不再因 layer_count 改變。
    var boardPadding = isMobileBrowser ? 8 : 12;
    var gapX = isMobileBrowser ? 4 : 6;
    var gapY = isMobileBrowser ? 4 : 6;
    var tileWByWidth = Math.floor((usableWidth - boardPadding - Math.max(0, dims.cols - 1) * gapX) / Math.max(1, dims.cols));
    var tileHByHeight = Math.floor((usableHeight - boardPadding - Math.max(0, dims.rows - 1) * gapY) / Math.max(1, dims.rows));
    var tileW = Math.floor(Math.min(tileWByWidth, tileHByHeight / aspect));
    tileW = Math.max(isMobileBrowser ? 40 : 44, Math.min(isMobileBrowser ? 88 : 96, tileW));
    var tileH = Math.round(tileW * aspect);
    if ((tileH * dims.rows + gapY * Math.max(0, dims.rows - 1) + boardPadding) > usableHeight) {
      tileW = Math.floor((usableHeight - boardPadding - gapY * Math.max(0, dims.rows - 1)) / Math.max(1, dims.rows) / aspect);
      tileW = Math.max(isMobileBrowser ? 38 : 42, Math.min(isMobileBrowser ? 88 : 96, tileW));
      tileH = Math.round(tileW * aspect);
    }
    var colStep = tileW + gapX;
    var rowStep = tileH + gapY;
    var layerOffsetX = 0;
    var layerOffsetY = 0;
    var boardW = boardPadding + ((dims.cols - 1) * colStep) + tileW;
    var boardH = boardPadding + ((dims.rows - 1) * rowStep) + tileH;
    if (boardW > usableWidth || boardH > usableHeight) {
      var exactFitW = Math.floor(Math.min(
        (usableWidth - boardPadding - gapX * Math.max(0, dims.cols - 1)) / Math.max(1, dims.cols),
        ((usableHeight - boardPadding - gapY * Math.max(0, dims.rows - 1)) / Math.max(1, dims.rows)) / aspect
      ));
      tileW = Math.max(isMobileBrowser ? 36 : 40, Math.min(tileW, exactFitW));
      tileH = Math.round(tileW * aspect);
      colStep = tileW + gapX;
      rowStep = tileH + gapY;
      boardW = boardPadding + ((dims.cols - 1) * colStep) + tileW;
      boardH = boardPadding + ((dims.rows - 1) * rowStep) + tileH;
    }

    state.boardMetrics = {
      dims: dims,
      tileW: tileW,
      tileH: tileH,
      colStep: colStep,
      rowStep: rowStep,
      layerOffsetX: layerOffsetX,
      layerOffsetY: layerOffsetY,
      boardW: boardW,
      boardH: boardH,
      tileInset: Math.round(boardPadding / 2)
    };

    renderTiles.sort(function(a, b) {
      if (a.layer !== b.layer) return a.layer - b.layer;
      if (a.row !== b.row) return a.row - b.row;
      return a.col - b.col;
    });

    var tileInset = Math.round(boardPadding / 2);
    var html = '<div class="link-battle-stacked-board" style="width:' + boardW + 'px;height:' + boardH + 'px;--tile-w:' + tileW + 'px;--tile-h:' + tileH + 'px;">';
    renderTiles.forEach(function(tile) {
      var x = tileInset + (tile.col * colStep);
      var y = tileInset + (tile.row * rowStep);
      var z = (tile.layer * 1000) + (tile.row * 20) + tile.col;
      html += renderTile(tile, 'left:' + x + 'px;top:' + y + 'px;z-index:' + z + ';--tile-layer:' + tile.layer + ';');
    });
    html += renderLinkPathOverlay();
    html += '</div>';
    wrap.innerHTML = html;
  }

  function isTileSelectable(tile) {
    var tiles = (state.battle && state.battle.boardData && state.battle.boardData.tiles) || [];
    var current = tiles.find(function(t){ return t.tile_id === tile.tile_id; });
    return current ? !!current.selectable : true;
  }

  function rarityClass(rarity) {
    return 'link-battle-rarity-' + String(rarity || 'Normal').replace(/\s+/g, '-');
  }

  function renderTile(tile, positionStyle) {
    var selectable = tile.selectable != null ? !!tile.selectable : isTileSelectable(tile);
    var cls = ['link-battle-tile', rarityClass(tile.rarity)];
    cls.push('layer-' + Number(tile.layer || 0));
    if (selectable) cls.push('selectable');
    if (!selectable) cls.push('covered');
    if (tile.locked_until && new Date(String(tile.locked_until)).getTime() > Date.now()) cls.push('locked');
    if (state.selectedTileId === tile.tile_id) cls.push('selected');
    if (state.hintedIds.has(tile.tile_id)) cls.push('hinted');
    var img = tile.image_url
      ? '<img src="' + escapeHtml(tile.image_url) + '" alt="' + escapeHtml(tile.card_name) + '" draggable="false" loading="lazy" decoding="async">'
      : '<div class="link-battle-tile-fallback">🎴</div>';
    return '<button class="' + cls.join(' ') + '" style="' + (positionStyle || '') + '" title="' + escapeHtml(tile.card_name) + '" aria-label="' + escapeHtml(tile.card_name) + '" data-tile-id="' + escapeHtml(tile.tile_id) + '" ' + (!selectable || state.isAnimating ? 'disabled' : '') + ' onclick="TLOLinkBattle.pickTile(\'' + escapeHtml(tile.tile_id) + '\')">' + img + '</button>';
  }

  function findTile(tileId) {
    var tiles = (state.battle && state.battle.boardData && state.battle.boardData.tiles) || [];
    return tiles.find(function(t){ return t.tile_id === tileId; }) || null;
  }

  async function pickTile(tileId) {
    if (state.isAnimating || !state.battle || !state.runId) return;
    if (!state.selectedTileId) {
      state.selectedTileId = tileId;
      renderBoard();
      return;
    }
    if (state.selectedTileId === tileId) {
      state.selectedTileId = null;
      renderBoard();
      return;
    }
    var tileA = findTile(state.selectedTileId);
    var tileB = findTile(tileId);
    var aId = state.selectedTileId;
    state.selectedTileId = null;
    state.hintedIds = new Set();
    state.isAnimating = true;
    renderBattleState();
    try {
      var res = await callRpc('resolveLinkBattleMove', [window.playerUID || window.TLO_PLAYER_UID || '', state.runId, aId, tileId]);
      if (!res || !res.success) throw new Error((res && res.msg) || '連線失敗');
      if (res.effects && res.effects.playerAttack) {
        state.linkPath = { type: 'success', points: res.effects.playerAttack.path || [], tileA: tileA, tileB: tileB };
        renderBoard();
        await sleep(650);
        await playPlayerAttack(res.effects.playerAttack, tileA || tileB);
      }
      if (res.effects && res.effects.invalid) {
        state.linkPath = { type: 'error', points: res.effects.invalid.path || [], tileA: tileA, tileB: tileB };
        renderBoard();
        playAudio('boss_hit_player');
        setMsg('連線失敗：' + escapeHtml(formatLinkBattleInvalidReason(res.effects.invalid.reason)), '#ff7777');
        await sleep(700);
      }
      state.linkPath = null;
      state.battle = res.state;
      state.battle.status = res.status;
      renderBattleState();
      if (res.effects && res.effects.bossCounter) await playBossCounter(res.effects.bossCounter);
      handleBattleEnd(res.status, res.reason, res.rewardSummary);
    } catch (err) {
      setMsg('操作失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    } finally {
      state.isAnimating = false;
      renderBattleState();
    }
  }

  async function playPlayerAttack(effect, tile) {
    playAudio('card_merge');
    await sleep(120);
    playAttackByRarity(effect.rarity);
    var card = $('link-battle-attack-card');
    if (card) {
      card.innerHTML = tile && tile.image_url ? '<img src="' + escapeHtml(tile.image_url) + '" alt="" loading="eager" decoding="async">' : '<div style="font-size:42px">🎴</div>';
      card.className = 'link-battle-attack-card active';
    }
    await sleep(520);
    playAudio('card_hit_boss');
    showDamage(effect.damage, effect.comboBonus);
    var shell = $('link-battle-shell');
    if (shell) {
      shell.classList.add('boss-shake');
      setTimeout(function(){ shell.classList.remove('boss-shake'); }, 560);
    }
    await sleep(320);
    if (card) card.className = 'link-battle-attack-card';
    if (Number(effect.comboBonus || 0) > 0) playAudio('combo_bonus');
  }

  function showDamage(damage, comboBonus) {
    var shell = $('link-battle-shell');
    if (!shell) return;
    var el = document.createElement('div');
    el.className = 'link-battle-float-damage';
    el.innerHTML = '-' + Number(damage || 0).toLocaleString() + (Number(comboBonus || 0) > 0 ? '<div style="font-size:13px;color:#ffdd77">Combo Bonus +' + Number(comboBonus || 0).toLocaleString() + '</div>' : '');
    shell.appendChild(el);
    setTimeout(function(){ if (el && el.parentNode) el.parentNode.removeChild(el); }, 950);
  }

  async function playBossCounter(effect) {
    playAudio('boss_warning');
    var warning = $('link-battle-warning');
    if (warning) warning.classList.add('active');
    await sleep(900);
    if (warning) warning.classList.remove('active');
    playAudio('boss_attack');
    var shell = $('link-battle-shell');
    if (shell) {
      shell.classList.add('boss-redflash', 'boss-shake', 'boss-distort');
      setTimeout(function(){ shell.classList.remove('boss-redflash', 'boss-shake', 'boss-distort'); }, 720);
    }
    if (effect && Number(effect.playerHpDamage || 0) > 0) {
      playAudio('boss_hit_player');
      showPlayerHpDamage(effect.playerHpDamage);
    }
    var damageText = effect && Number(effect.playerHpDamage || 0) > 0 ? '｜玩家 HP -' + Number(effect.playerHpDamage || 0).toLocaleString() : '';
    setMsg('BOSS反擊：' + escapeHtml(effect.label || effect.skill || '攻擊') + escapeHtml(damageText), '#ff7777');
    await sleep(760);
  }

  function showPlayerHpDamage(damage) {
    var shell = $('link-battle-shell');
    if (!shell) return;
    var el = document.createElement('div');
    el.className = 'link-battle-float-player-damage';
    el.innerHTML = '玩家 HP -' + Number(damage || 0).toLocaleString();
    shell.appendChild(el);
    setTimeout(function(){ if (el && el.parentNode) el.parentNode.removeChild(el); }, 980);
  }

  function getNextUnlockedStageId(currentStageId) {
    var stages = (state.dashboard && state.dashboard.stages) || [];
    var current = stages.find(function(s){ return String(s.stageId) === String(currentStageId); });
    if (!current) return null;
    var nextOrder = Number(current.stageOrder || 0) + 1;
    var next = stages.find(function(s){ return Number(s.stageOrder || 0) === nextOrder; });
    return next ? next.stageId : null;
  }

  function showBossDefeatAnimation(rewardSummary) {
    var overlay = $('link-battle-boss-defeat');
    var reward = $('link-battle-boss-defeat-reward');
    if (!overlay) return;
    if (reward) {
      reward.innerHTML = rewardSummary ? '通關獎勵：' + escapeHtml(rewardSummary) : '討伐成功';
    }
    overlay.classList.remove('active');
    // 重新觸發動畫
    void overlay.offsetWidth;
    overlay.classList.add('active');
    setTimeout(function() {
      if (overlay) overlay.classList.remove('active');
    }, 2200);
  }

  function maybeShowBossDefeatAnimation(rewardSummary) {
    if (!state.battle || state.battle.status !== 'victory') return;
    var runKey = String(state.runId || '') + ':' + String(state.battle.stageId || '');
    if (state.bossDefeatAnimationRunId === runKey) return;
    state.bossDefeatAnimationRunId = runKey;
    showBossDefeatAnimation(rewardSummary);
  }

  function handleBattleEnd(status, reason, rewardSummary) {
    if (status === 'victory') {
      stopTimer();
      playAudio('battle_victory');
      maybeShowBossDefeatAnimation(rewardSummary);
      setMsg('<b style="color:#00ff7f">討伐成功！</b>' + (rewardSummary ? '<br><span style="color:#ffdd77">通關獎勵：' + escapeHtml(rewardSummary) + '</span>' : ''), '#00ff7f');
      setButtonsDisabled(true);
      state.nextStageIdAfterVictory = null;
      loadDashboard().then(function() {
        state.nextStageIdAfterVictory = getNextUnlockedStageId(state.battle && state.battle.stageId);
        var startBtn = $('link-battle-start-btn');
        if (startBtn) { startBtn.disabled = false; startBtn.style.display = ''; startBtn.innerHTML = state.nextStageIdAfterVictory ? '➡️ 下一關' : '📖 回章節'; }
        updateShellMode();
        showVictoryScene(rewardSummary);
      }).catch(function(){ updateShellMode(); showVictoryScene(rewardSummary); });
    } else if (status === 'failed') {
      stopTimer();
      playAudio('battle_failed');
      setMsg('<b style="color:#ff7777">' + escapeHtml(formatLinkBattleEndReason(reason)) + '</b>', '#ff7777');
      setButtonsDisabled(true);
      var startBtn = $('link-battle-start-btn');
      if (startBtn) { startBtn.disabled = false; startBtn.style.display = ''; startBtn.innerHTML = '⚔️ 再次討伐'; }
      updateShellMode();
      showFailureScene(reason);
    }
  }

  async function retryBattle() {
    if (state.isAnimating) return;
    state.selectedTileId = null;
    state.hintedIds = new Set();
    state.linkPath = null;
    await startBattle({ skipStory: true });
  }

  async function useHint() {
    if (state.isAnimating || !state.runId) return;
    state.isAnimating = true;
    try {
      var res = await callRpc('useLinkBattleHint', [window.playerUID || window.TLO_PLAYER_UID || '', state.runId]);
      if (!res || !res.success) throw new Error((res && res.msg) || '提示失敗');
      state.battle = res.state;
      state.battle.status = res.status;
      state.hintedIds = new Set([res.hint.tileAId, res.hint.tileBId]);
      state.linkPath = null;
      renderBattleState();
      setMsg('已高亮一組可連線卡牌。使用提示會清空 Combo，並增加 BOSS 怒氣。', '#ffdd77');
      if (res.effects && res.effects.bossCounter) await playBossCounter(res.effects.bossCounter);
      handleBattleEnd(res.status, null, res.rewardSummary);
    } catch (err) {
      setMsg('提示失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    } finally {
      state.isAnimating = false;
      renderBattleState();
    }
  }

  async function shuffleBoard() {
    if (state.isAnimating || !state.runId) return;
    state.isAnimating = true;
    try {
      var res = await callRpc('shuffleLinkBattle', [window.playerUID || window.TLO_PLAYER_UID || '', state.runId]);
      if (!res || !res.success) throw new Error((res && res.msg) || '洗牌失敗');
      state.battle = res.state;
      state.battle.status = res.status;
      state.hintedIds = new Set();
      state.linkPath = null;
      renderBattleState();
      setMsg('已重新洗牌，場上至少保留可連線組合。洗牌會增加 BOSS 怒氣。', '#ffdd77');
      if (res.effects && res.effects.bossCounter) await playBossCounter(res.effects.bossCounter);
      handleBattleEnd(res.status, null, res.rewardSummary);
    } catch (err) {
      setMsg('洗牌失敗：' + escapeHtml(err && err.message ? err.message : err), '#ff7777');
    } finally {
      state.isAnimating = false;
      renderBattleState();
    }
  }

  var resizeRenderTimer = null;
  updateViewportVars();
  window.addEventListener('resize', function() { scheduleBoardRerender(120); });
  window.addEventListener('orientationchange', function() { scheduleBoardRerender(220); });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() { scheduleBoardRerender(120); });
    window.visualViewport.addEventListener('scroll', function() { updateViewportVars(); });
  }

  window.TLOLinkBattle = {
    openModal: openModal,
    closeModal: closeModal,
    loadDashboard: loadDashboard,
    selectStage: selectStage,
    startBattle: startBattle,
    startOrRetryBattle: startOrRetryBattle,
    pickTile: pickTile,
    useHint: useHint,
    shuffleBoard: shuffleBoard,
    retryBattle: retryBattle,
    openRules: openRules,
    closeRules: closeRules,
    startFromRules: startFromRules,
    openStageSelect: openStageSelect,
    closeStageSelect: closeStageSelect,
    chooseStageAndStart: chooseStageAndStart,
    selectStageForTeam: selectStageForTeam,
    startSelectedStage: startSelectedStage,
    toggleTeamPanel: toggleTeamPanel,
    openTeamPicker: openTeamPicker,
    closeTeamPicker: closeTeamPicker,
    toggleTeamCard: toggleTeamCard,
    saveTeamDraft: saveTeamDraft,
    autoLinkBattleTeam: autoLinkBattleTeam,
    toggleStageChapter: toggleStageChapter,
    scenePrimaryAction: scenePrimaryAction,
    sceneSecondaryAction: sceneSecondaryAction
  };
  window.openLinkBattleModal = openModal;
})();
