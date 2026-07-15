/* =========================================================================
   Harmonies ソロ（自作版・コア）
   - 個人ボード（ヘックス）へのトークン配置＋積み重ね判定
   - 地形5種の得点計算
   - ソロ中央ボード（3スペース・破棄/補充）
   - 動物カード（本家に近いパターン条件）＋キューブ配置
   - localStorage セーブ
   本家の公式イラスト・ロゴは不使用。仕組みのみ再現したオリジナル実装。
   ========================================================================= */

'use strict';

// ---- トークン定義 -------------------------------------------------------
const TOKENS = {
  river:    { label: '川', color: 'var(--c-river)' },
  mountain: { label: '山', color: 'var(--c-mountain)' },
  tree:     { label: '木', color: 'var(--c-tree)' },
  leaf:     { label: '葉', color: 'var(--c-leaf)' },
  field:    { label: '畑', color: 'var(--c-field)' },
  building: { label: '建', color: 'var(--c-building)' },
};
// 袋の内訳（本家準拠）
const BAG_COUNTS = { river: 23, mountain: 23, tree: 21, leaf: 19, field: 19, building: 15 };

// ---- 盤面（オフセット座標で描画、軸座標で隣接/回転を計算） --------------
// 本家準拠：フラットトップの六角形を 5 列 [5,4,5,4,5]＝合計23マスで配置。
// 偶数列(0,2,4)=5マス、奇数列(1,3)=4マスが半個下にネストして丸みのある形になる。
const COLCOUNTS = [5, 4, 5, 4, 5];
const HEX = 34;                 // ヘックス外接半径(px)
const SQRT3 = Math.sqrt(3);

// 軸座標の6方向（pointy-top）
const AX_DIRS = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];

// ---- ゲーム状態 ---------------------------------------------------------
// mode=1 はソロ（精霊＋勝利点あり）。mode=2..4 はマルチ（素点で勝敗）。
// プレイヤーごとの盤/カードは players[] に保持し、G.cells は現在プレイヤーの
// 盤への「別名参照」。得点・隣接・回転コードは従来どおり G.cells を使える。
let G = null;

function P() { return G.players[G.current]; }          // 手番プレイヤー
function PV() { return G.players[G.view != null ? G.view : G.current]; } // 表示中プレイヤー
// 操作可能か：自分の盤を表示中で、手番が人間かつCPU思考中/終了でない
function interactive() {
  return !G.over && !G.cpuThinking && G.view === G.current && !P().isCpu;
}
function isSolo() { return G.mode === 1; }
function centralSize() { return isSolo() ? 3 : 5; }    // 中央スペース数
function marketSize() { return isSolo() ? 3 : 5; }     // 動物カード場の枚数

// 現在プレイヤーの盤を G.cells に別名として結び付ける（保存時は削除）
function syncAliases() { G.cells = P().cells; }

function freshBoard() {
  const cells = {};
  for (let col = 0; col < COLCOUNTS.length; col++) {
    for (let row = 0; row < COLCOUNTS[col]; row++) {
      // odd-q オフセット → 軸座標(q,r)。隣接/回転は軸座標で計算する。
      const q = col;
      const r = row - ((col - (col & 1)) >> 1);
      const key = q + ',' + r;
      cells[key] = { key, q, r, col, row, stack: [], cube: null };
    }
  }
  return cells;
}

function freshState(mode, cpuCount) {
  cpuCount = Math.max(0, Math.min(cpuCount || 0, mode - 1)); // 人間は最低1人
  const humanCount = mode - cpuCount;
  const players = [];
  for (let i = 0; i < mode; i++) {
    const isCpu = i >= humanCount;              // 人間を先頭、CPUを後ろに配置
    const name = isCpu ? ('CPU' + (i - humanCount + 1))
      : (humanCount === 1 ? 'あなた' : 'プレイヤー' + (i + 1));
    players.push({
      name, isCpu,
      cells: freshBoard(),
      owned: [],                       // 自分の動物カード
      spiritOffer: [],                 // 開始時に提示する精霊id（ソロのみ）
      spirit: mode === 1 ? null : 'none', // 選んだ精霊id（マルチは精霊なし固定）
    });
  }
  return {
    mode,
    cpuCount,
    players,
    current: 0,
    view: 0,                 // 表示中の盤（タブで切替。既定は手番プレイヤー）
    bag: buildBag(),
    central: Array.from({ length: mode === 1 ? 3 : 5 }, () => []),
    market: [],              // 場の動物カード（共有：ソロ3/マルチ5）
    animalDeck: [],          // 山札（共有）
    hand: [],                // 取得した3トークン（現在手番のみ）
    handUsed: [],            // 配置済みフラグ
    tookCardThisTurn: false,
    turn: 1,                 // 手番の通し番号
    finishing: false,        // 終了トリガー後、ラウンドを終えるためのフラグ
    over: false,
  };
}

function buildBag() {
  const bag = [];
  for (const [t, n] of Object.entries(BAG_COUNTS)) for (let i = 0; i < n; i++) bag.push(t);
  shuffle(bag);
  return bag;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// =========================================================================
// 配置ルール（積み重ね判定）
// =========================================================================
function canPlace(type, stack) {
  const h = stack.length;
  const top = h ? stack[h - 1] : null;
  switch (type) {
    case 'river':  return h === 0;                        // 平置きのみ
    case 'field':  return h === 0;                        // 平置きのみ
    case 'mountain': return h === 0 || (h < 3 && top === 'mountain'); // 最大3段
    case 'tree':   return h === 0 || (h === 1 && top === 'tree');     // 幹は最大2段
    case 'leaf':   return h === 0 || ((h === 1 || h === 2) && top === 'tree'); // 幹の上/地面
    case 'building': return h === 1 && (top === 'mountain' || top === 'building' || top === 'tree');
    default: return false;
  }
}

function placeToken(cell, type) {
  cell.stack.push(type);
}

// マス単位の配置可否：動物駒が乗っているマスには積めない（スライド7「駒の上に重ねない」）
function canPlaceOn(cell, type) {
  return !cell.cube && canPlace(type, cell.stack);
}
// 未完成の動物カード枚数（4枚枠の判定用。完成カードは横へ移動して枠を空ける）
function incompleteCount(pl) {
  return pl.owned.filter(c => (c.placed || 0) < c.slots.length).length;
}

// =========================================================================
// 隣接・軸座標ユーティリティ
// =========================================================================
function neighbors(cell) {
  const out = [];
  for (const [dq, dr] of AX_DIRS) {
    const k = (cell.q + dq) + ',' + (cell.r + dr);
    if (G.cells[k]) out.push(G.cells[k]);
  }
  return out;
}
function topType(cell) { return cell.stack.length ? cell.stack[cell.stack.length - 1] : null; }

// =========================================================================
// 地形得点計算（A面ルール）
// =========================================================================
function computeTerrainScore() {
  const parts = { leaf: 0, mountain: 0, field: 0, building: 0, river: 0 };
  const cells = Object.values(G.cells);

  // 葉（木）：葉の高さ 1/2/3 → 1/3/7
  for (const c of cells) {
    if (topType(c) === 'leaf') {
      const h = c.stack.length;
      parts.leaf += h === 1 ? 1 : h === 2 ? 3 : 7;
    }
  }

  // 山：高さ 1/2/3 → 1/3/7（隣接に山が無ければ0）
  for (const c of cells) {
    if (topType(c) === 'mountain') {
      const adjMountain = neighbors(c).some(n => topType(n) === 'mountain');
      if (!adjMountain) continue;
      const h = c.stack.length;
      parts.mountain += h === 1 ? 1 : h === 2 ? 3 : 7;
    }
  }

  // 畑：連結グループ（2個以上）ごとに5点
  {
    const seen = new Set();
    for (const c of cells) {
      if (topType(c) !== 'field' || seen.has(c.key)) continue;
      // BFS で連結成分
      let size = 0; const q = [c]; seen.add(c.key);
      while (q.length) {
        const cur = q.pop(); size++;
        for (const n of neighbors(cur))
          if (topType(n) === 'field' && !seen.has(n.key)) { seen.add(n.key); q.push(n); }
      }
      if (size >= 2) parts.field += 5;
    }
  }

  // 建物：高さ2で、隣接に3色以上あれば5点
  for (const c of cells) {
    if (topType(c) === 'building' && c.stack.length === 2) {
      const colors = new Set(neighbors(c).map(topType).filter(Boolean));
      if (colors.size >= 3) parts.building += 5;
    }
  }

  // 川：最長の連結経路長 → 0/2/5/8/11/15（長さ1..6, 6以上は15）
  parts.river = riverScore(cells);

  const total = parts.leaf + parts.mountain + parts.field + parts.building + parts.river;
  return { parts, total };
}

function riverScore(cells) {
  const riverCells = cells.filter(c => topType(c) === 'river');
  if (!riverCells.length) return 0;
  const rset = new Set(riverCells.map(c => c.key));
  const table = [0, 0, 2, 5, 8, 11, 15]; // 長さ1..6 の得点
  let best = 1, steps = 0;
  // 各始点から最長単純経路をDFS（盤面が小さいので許容。全面川など病的ケース用の安全弁つき）
  const dfs = (cell, visited) => {
    let longest = visited.size;
    for (const n of neighbors(cell)) {
      if (rset.has(n.key) && !visited.has(n.key)) {
        if (++steps > 300000) return longest;
        visited.add(n.key);
        longest = Math.max(longest, dfs(n, visited));
        visited.delete(n.key);
      }
    }
    return longest;
  };
  for (const c of riverCells) best = Math.max(best, dfs(c, new Set([c.key])));
  // 長さ7以上は 15点 + 1個ごとに +4点（スライド17準拠）
  return best <= 6 ? table[best] : 15 + 4 * (best - 6);
}

// =========================================================================
// 動物カード（本家に近いパターン条件）
// pattern: 軸座標オフセット {dq,dr,color,h?} の配列。index0 がキューブ設置マス。
// color: トークン種別（top一致）, h: 高さ完全一致（省略可）
// slots: 上→下の得点。全キューブ配置で完成。
// =========================================================================
function animalTemplates() {
  // pattern の index0 がキューブ設置マス（アンカー）。dq,dr は軸座標オフセット。
  // color=必要な最上段トークン, h=高さ完全一致（省略可）。6方向回転で一致判定する。
  return [
    // --- 水辺 ---
    { id: 'fish',   name: 'サカナ',   desc: '川がまっすぐ3つ並ぶ',
      pattern: [ {dq:0,dr:0,color:'river'}, {dq:1,dr:0,color:'river'}, {dq:2,dr:0,color:'river'} ],
      slots: [12, 8, 5, 3] },
    { id: 'otter',  name: 'カワウソ', desc: '川2つの隣に畑',
      pattern: [ {dq:0,dr:0,color:'river'}, {dq:1,dr:0,color:'river'}, {dq:0,dr:1,color:'field'} ],
      slots: [9, 6, 3] },
    { id: 'duck',   name: 'カモ',     desc: '川の隣に木(葉)',
      pattern: [ {dq:0,dr:0,color:'river'}, {dq:1,dr:0,color:'leaf'} ],
      slots: [7, 5, 3, 1] },
    { id: 'heron',  name: 'サギ',     desc: '川2つの先に山',
      pattern: [ {dq:0,dr:0,color:'river'}, {dq:1,dr:0,color:'river'}, {dq:2,dr:0,color:'mountain'} ],
      slots: [10, 6, 3] },
    { id: 'frog',   name: 'カエル',   desc: '川の隣に畑',
      pattern: [ {dq:0,dr:0,color:'river'}, {dq:1,dr:0,color:'field'} ],
      slots: [8, 5, 3, 1] },
    // --- 森・木 ---
    { id: 'owl',    name: 'フクロウ', desc: '高さ3の木（葉が3段目）',
      pattern: [ {dq:0,dr:0,color:'leaf',h:3} ],
      slots: [14, 10, 6, 3] },
    { id: 'wpecker',name: 'キツツキ', desc: '高さ2の木の隣に木',
      pattern: [ {dq:0,dr:0,color:'leaf',h:2}, {dq:1,dr:0,color:'leaf'} ],
      slots: [11, 7, 4] },
    { id: 'squirrel',name:'リス',     desc: '木が3つ集まる（うち1つ高さ2）',
      pattern: [ {dq:0,dr:0,color:'leaf',h:2}, {dq:1,dr:0,color:'leaf'}, {dq:0,dr:1,color:'leaf'} ],
      slots: [13, 8, 4] },
    { id: 'deer',   name: 'シカ',     desc: '木(葉)がまっすぐ3つ',
      pattern: [ {dq:0,dr:0,color:'leaf'}, {dq:1,dr:0,color:'leaf'}, {dq:2,dr:0,color:'leaf'} ],
      slots: [12, 8, 5, 3] },
    { id: 'butterfly',name:'チョウ',  desc: '木(葉)の隣に畑2つ',
      pattern: [ {dq:0,dr:0,color:'leaf'}, {dq:1,dr:0,color:'field'}, {dq:0,dr:1,color:'field'} ],
      slots: [10, 6, 3] },
    // --- 山 ---
    { id: 'eagle',  name: 'ワシ',     desc: '高さ3の山',
      pattern: [ {dq:0,dr:0,color:'mountain',h:3} ],
      slots: [14, 9, 5] },
    { id: 'goat',   name: 'ヤギ',     desc: '高さ2の山が隣り合う',
      pattern: [ {dq:0,dr:0,color:'mountain',h:2}, {dq:1,dr:0,color:'mountain',h:2} ],
      slots: [15, 10, 5] },
    { id: 'bear',   name: 'クマ',     desc: '高さ2の山の隣に木',
      pattern: [ {dq:0,dr:0,color:'mountain',h:2}, {dq:1,dr:0,color:'leaf'} ],
      slots: [13, 8, 4] },
    { id: 'boar',   name: 'イノシシ', desc: '木2つの隣に山',
      pattern: [ {dq:0,dr:0,color:'leaf'}, {dq:1,dr:0,color:'leaf'}, {dq:0,dr:1,color:'mountain'} ],
      slots: [11, 7, 4] },
    { id: 'wolf',   name: 'オオカミ', desc: '木・山・畑が三つ巴',
      pattern: [ {dq:0,dr:0,color:'leaf'}, {dq:1,dr:0,color:'mountain'}, {dq:0,dr:1,color:'field'} ],
      slots: [12, 7, 4] },
    // --- 草原・畑 ---
    { id: 'rabbit', name: 'ウサギ',   desc: '畑が3つ集まる',
      pattern: [ {dq:0,dr:0,color:'field'}, {dq:1,dr:0,color:'field'}, {dq:0,dr:1,color:'field'} ],
      slots: [10, 6, 3] },
    { id: 'sheep',  name: 'ヒツジ',   desc: '畑がまっすぐ2つ',
      pattern: [ {dq:0,dr:0,color:'field'}, {dq:1,dr:0,color:'field'} ],
      slots: [6, 4, 2, 1] },
    // --- 里（建物） ---
    { id: 'lizard', name: 'トカゲ',   desc: '建物の隣に山と畑',
      pattern: [ {dq:0,dr:0,color:'building'}, {dq:1,dr:0,color:'mountain'}, {dq:-1,dr:1,color:'field'} ],
      slots: [12, 7, 4] },
    { id: 'mouse',  name: 'ネズミ',   desc: '建物の隣に畑',
      pattern: [ {dq:0,dr:0,color:'building'}, {dq:1,dr:0,color:'field'} ],
      slots: [8, 5, 3] },
    { id: 'cat',    name: 'ネコ',     desc: '建物の隣に木',
      pattern: [ {dq:0,dr:0,color:'building'}, {dq:1,dr:0,color:'leaf'} ],
      slots: [9, 5, 2] },
  ];
}

// 軸座標オフセットを cube 座標で 60°×k 回転
function rotateOffset(dq, dr, k) {
  let x = dq, z = dr, y = -x - z;
  for (let i = 0; i < ((k % 6) + 6) % 6; i++) {
    const nx = -z, ny = -x, nz = -y;
    x = nx; y = ny; z = nz;
  }
  return [x, z]; // → 軸座標(dq,dr)
}

// カードの pattern がアンカー cell / 回転 rot で成立するか
function matchAt(anchor, pattern, rot) {
  for (const p of pattern) {
    const [dq, dr] = rotateOffset(p.dq, p.dr, rot);
    const k = (anchor.q + dq) + ',' + (anchor.r + dr);
    const cell = G.cells[k];
    if (!cell) return false;
    if (topType(cell) !== p.color) return false;
    if (p.h != null && cell.stack.length !== p.h) return false;
  }
  return true;
}

// このカードでキューブを置ける「アンカー候補セル」を列挙（キューブ未設置マスのみ）
function validAnchors(card) {
  const out = [];
  for (const cell of Object.values(G.cells)) {
    if (cell.cube) continue;              // 1マス1キューブまで
    for (let rot = 0; rot < 6; rot++) {
      if (matchAt(cell, card.pattern, rot)) { out.push(cell.key); break; }
    }
  }
  return out;
}

// アンカーに置いた場合に成立する pattern の全セルキー（最初に一致した回転）を返す
function matchedPatternCells(anchor, card) {
  for (let rot = 0; rot < 6; rot++) {
    if (!matchAt(anchor, card.pattern, rot)) continue;
    return card.pattern.map(p => {
      const [dq, dr] = rotateOffset(p.dq, p.dr, rot);
      return (anchor.q + dq) + ',' + (anchor.r + dr);
    });
  }
  return null;
}

function cardScore(card) {
  const len = card.slots.length;
  const placed = card.placed || 0;
  if (placed === 0) return 0;
  return card.slots[len - placed]; // 埋めた分だけ上の高得点が見える
}

// =========================================================================
// 自然の精霊カード（Spirit）
// ソロ：開始時に2枚から1枚選ぶ（または「なし」）。ゲーム中の追加点を得るが、
// ソロ勝利点はタイプで変化（なし=2 / グループ効果=1 / 個別効果=0）。
// 効果は関数なので保存はしない。G.spirit には id 文字列だけを保持する。
// =========================================================================
function spiritDefs() {
  return [
    { id: 'forest', name: '森の精霊', type: 'group', desc: '最大の木(葉)グループのサイズ×3点',
      score: () => maxGroup('leaf') * 3 },
    { id: 'water',  name: '水の精霊', type: 'group', desc: '最大の川グループのサイズ×3点',
      score: () => maxGroup('river') * 3 },
    { id: 'meadow', name: '草原の精霊', type: 'group', desc: '最大の畑グループのサイズ×4点',
      score: () => maxGroup('field') * 4 },
    { id: 'stone',  name: '石の精霊', type: 'individual', desc: '高さ3の山1つにつき5点',
      score: () => countCond(c => topType(c) === 'mountain' && c.stack.length === 3) * 5 },
    { id: 'village',name: '里の精霊', type: 'individual', desc: '建物1つにつき4点',
      score: () => countCond(c => topType(c) === 'building') * 4 },
    { id: 'grove',  name: '木立の精霊', type: 'individual', desc: '高さ3の木1つにつき4点',
      score: () => countCond(c => topType(c) === 'leaf' && c.stack.length === 3) * 4 },
  ];
}
function spiritById(id) { return spiritDefs().find(s => s.id === id) || null; }

// 最上段が color のセルの、最大連結グループのサイズ
function maxGroup(color) {
  const cells = Object.values(G.cells);
  const seen = new Set();
  let best = 0;
  for (const c of cells) {
    if (topType(c) !== color || seen.has(c.key)) continue;
    let size = 0; const q = [c]; seen.add(c.key);
    while (q.length) {
      const cur = q.pop(); size++;
      for (const n of neighbors(cur))
        if (topType(n) === color && !seen.has(n.key)) { seen.add(n.key); q.push(n); }
    }
    best = Math.max(best, size);
  }
  return best;
}
function countCond(fn) { return Object.values(G.cells).filter(fn).length; }

// 精霊のゲーム中追加点
function spiritPoints() {
  const sp = P().spirit;
  if (!sp || sp === 'none') return 0;
  const s = spiritById(sp);
  return s ? s.score() : 0;
}
// 精霊タイプによるソロ勝利点
function spiritTypeVp() {
  const sp = P().spirit;
  if (!sp || sp === 'none') return 2;                // 精霊なし＝2点
  const s = spiritById(sp);
  return s && s.type === 'group' ? 1 : 0;            // グループ=1 / 個別=0
}

// =========================================================================
// ゲーム進行
// =========================================================================
function newGame(mode, cpuCount) {
  mode = mode || 1;
  G = freshState(mode, cpuCount);
  syncAliases();
  // 動物山札（共有）
  G.animalDeck = shuffle(animalTemplates().map(t => ({ ...t, placed: 0 })));
  if (isSolo()) {
    // ソロのみ：精霊カードを2枚提示
    P().spiritOffer = shuffle(spiritDefs().map(s => s.id)).slice(0, 2);
  }
  refillMarket();
  refillCentral();
  save(); renderAll();
  setHint(isSolo()
    ? 'まず精霊カードを選ぶか「精霊なし」を選ぼう（右）。次に中央スペースからトークンを取得'
    : P().name + 'の手番：中央スペースを1つ選んでトークンを取得しよう');
  scheduleCpuIfNeeded();
}

function refillMarket() {
  while (G.market.length < marketSize() && G.animalDeck.length) G.market.push(G.animalDeck.pop());
}

function refillCentral() {
  for (let i = 0; i < G.central.length; i++) {
    while (G.central[i].length < 3 && G.bag.length) G.central[i].push(G.bag.pop());
  }
}

function takeSpace(i) {
  if (!interactive()) return;                // 自分の手番の盤でのみ操作可
  if (G.hand.length) return;                 // 手札処理中は不可
  if (!G.central[i].length) return;
  G.hand = G.central[i].splice(0, G.central[i].length);
  G.handUsed = G.hand.map(() => false);
  G.selectedHand = null;
  save(); renderAll();
  setHint('手札のトークンを選んで、盤上の配置可能マス（緑枠）に置こう');
}

// タブで表示する盤を切り替える（閲覧のみ。操作は自分の手番の盤でのみ）
function selectView(i) {
  if (G.placingCard != null) return;   // キューブ配置中は切替不可
  G.view = i;
  renderAll();
  if (i !== G.current) setHint(PV().name + ' の盤を見ています（閲覧のみ）');
  else if (interactive()) setHint('あなたの手番：中央スペースからトークンを取得しよう');
}

function selectHand(idx) {
  if (!interactive()) return;
  if (G.handUsed[idx]) return;
  G.selectedHand = (G.selectedHand === idx) ? null : idx;
  renderAll();
}

function clickCell(key) {
  if (!interactive()) return;
  const cell = G.cells[key];
  // 動物キューブ配置モード（placingCard は 0 もあり得るので != null で判定）
  if (G.placingCard != null) {
    if (G.cubeAnchors && G.cubeAnchors.includes(key)) placeCube(cell);
    return;
  }
  // トークン配置モード
  if (G.selectedHand == null) return;
  const type = G.hand[G.selectedHand];
  if (!canPlaceOn(cell, type)) return;
  placeToken(cell, type);
  G.handUsed[G.selectedHand] = true;
  G.selectedHand = null;
  // 全部置いたら手札クリア
  if (G.handUsed.every(Boolean)) { G.hand = []; G.handUsed = []; }
  maybeEnableEndTurn();
  save(); renderAll();
}

function maybeEnableEndTurn() {
  // 手札を置ききったらターン終了可
}

function endTurn() {
  if (G.hand.length && !G.handUsed.every(Boolean)) {
    // 取った3個はすべて置く（スライド7）。置ける手札が残っていれば終了不可。
    const canStillPlace = G.hand.some((t, i) => !G.handUsed[i] &&
      Object.values(G.cells).some(c => canPlaceOn(c, t)));
    if (canStillPlace) { setHint('取ったトークンは3個すべて置く必要があります'); return; }
    // どうしても置けないトークンだけ破棄して進める
    G.hand = []; G.handUsed = [];
  }

  // 現在プレイヤーの盤で終了トリガーを判定（空き2以下）
  const empties = Object.values(G.cells).filter(c => c.stack.length === 0).length;

  if (isSolo()) {
    // ソロ：中央の残りトークンを全破棄 → 補充
    G.central = G.central.map(() => []);
    refillCentral();
    G.tookCardThisTurn = false;
    G.turn++;
    const noRefill = G.central.every(s => s.length === 0);
    if (empties <= 2 || noRefill) G.over = true;
    save(); renderAll();
    if (G.over) showResult();
    else setHint('新しい手番：中央スペースを選ぼう（ターン ' + G.turn + '）');
    return;
  }

  // マルチ：空いたスペースだけ補充（他プレイヤーの分は残る）
  refillCentral();
  refillMarket();
  const noRefill = G.central.every(s => s.length === 0);
  if (empties <= 2 || noRefill) G.finishing = true;   // 終了トリガー

  // 次プレイヤーへ
  G.turn++;
  G.tookCardThisTurn = false;
  G.hand = []; G.handUsed = []; G.selectedHand = null;
  G.placingCard = null; G.cubeAnchors = null;
  G.current = (G.current + 1) % G.mode;
  G.view = G.current;               // 表示も手番プレイヤーに合わせる
  syncAliases();
  // ラウンドの先頭(=0)に戻った時点で終了フラグが立っていれば終了
  if (G.current === 0 && G.finishing) {
    G.over = true;
    save(); renderAll(); showResult(); return;
  }
  save(); renderAll();
  setHint(P().name + 'の手番：中央スペースを1つ選んでトークンを取得しよう');
  scheduleCpuIfNeeded();
}

// 動物カード取得（手番1回・最大4枚）
function takeCard(marketIdx) {
  if (!interactive()) return;
  if (G.tookCardThisTurn) { setHint('動物カードの取得は手番に1枚までです'); return; }
  if (incompleteCount(P()) >= 4) { setHint('未完成の動物カードは4枚まで（完成させると枠が空きます）'); return; }
  const card = G.market.splice(marketIdx, 1)[0];
  P().owned.push(card);
  G.tookCardThisTurn = true;
  refillMarket();
  save(); renderAll();
}

// キューブ配置モードに入る
function startPlaceCube(ownedIdx) {
  if (!interactive()) return;
  const card = P().owned[ownedIdx];
  if (card.placed >= card.slots.length) return;
  const anchors = validAnchors(card);
  if (!anchors.length) { setHint('「' + card.name + '」の条件を満たすマスがありません'); return; }
  G.placingCard = ownedIdx;
  G.cubeAnchors = anchors;
  renderAll();
  setHint('「' + card.name + '」のキューブを置くマス（緑枠）を選ぼう');
}

function placeCube(cell) {
  const card = P().owned[G.placingCard];
  cell.cube = card.id;
  card.placed = (card.placed || 0) + 1;
  G.placingCard = null;
  G.cubeAnchors = null;
  if (card.placed >= card.slots.length) setHint('「' + card.name + '」完成！保持枠が1つ空きました');
  save(); renderAll();
}

function cancelPlaceCube() {
  if (G.cpuThinking) return;
  G.placingCard = null; G.cubeAnchors = null; renderAll();
}

// =========================================================================
// CPU（自動プレイ）
// グリーディ：地形得点が最も伸びる位置にトークンを置き、置けるキューブは全部置く。
// =========================================================================
// 現在プレイヤーがCPUなら、少し待ってから自動で手番を実行する
function scheduleCpuIfNeeded() {
  if (G.over || !P().isCpu) { G.cpuThinking = false; renderAll(); return; }
  G.cpuThinking = true;
  renderAll();
  setHint(P().name + ' が考え中…');
  setTimeout(() => {
    cpuPlayTurn();                         // 手番の行動（盤に反映）
    setHint(P().name + ' が手番を実行しました');
    setTimeout(() => { endTurn(); }, 800); // 結果を見せてから次へ
  }, 700);
}

function cpuPlayTurn() {
  // 1. 最も多く配置できそうな中央スペースを選ぶ
  let bi = -1, best = -1;
  for (let i = 0; i < G.central.length; i++) {
    if (!G.central[i].length) continue;
    const n = G.central[i].filter(t =>
      Object.values(G.cells).some(c => canPlaceOn(c, t))).length;
    if (n > best) { best = n; bi = i; }
  }
  if (bi < 0) { renderAll(); return; }     // 取れるスペースが無い
  const tokens = G.central[bi].splice(0, G.central[bi].length);

  // 2. 各トークンを、地形得点が最も伸びるマスへ置く
  for (const type of tokens) cpuPlaceToken(type);

  // 3. 手持ちカードのキューブを置けるだけ置く
  cpuPlaceCubes();

  // 4. 動物カードを1枚取り、置けるならキューブも
  cpuTakeCard();
  cpuPlaceCubes();

  renderAll();
}

function cpuPlaceToken(type) {
  const cands = Object.values(G.cells).filter(c => canPlaceOn(c, type));
  if (!cands.length) return false;         // 置けない → 破棄
  const base = computeTerrainScore().total;
  let bestCell = null, bestScore = -Infinity;
  for (const c of cands) {
    c.stack.push(type);
    const delta = computeTerrainScore().total - base;
    c.stack.pop();
    const score = delta + Math.random() * 0.4; // 同点はランダムに散らす
    if (score > bestScore) { bestScore = score; bestCell = c; }
  }
  bestCell.stack.push(type);
  return true;
}

function cpuPlaceCubes() {
  for (const card of P().owned) {
    let guard = 0;
    while ((card.placed || 0) < card.slots.length && guard++ < 12) {
      const anchors = validAnchors(card);
      if (!anchors.length) break;
      const cell = G.cells[anchors[0]];
      cell.cube = card.id;
      card.placed = (card.placed || 0) + 1;
    }
  }
}

function cpuTakeCard() {
  if (G.tookCardThisTurn || incompleteCount(P()) >= 4 || !G.market.length) return;
  // 今すぐ置けるカードを優先。無ければトップ得点が高いカード。
  let pick = -1, bestVal = -1;
  for (let i = 0; i < G.market.length; i++) {
    const card = G.market[i];
    const placeable = validAnchors(card).length > 0;
    const val = (placeable ? 100 : 0) + card.slots[0];
    if (val > bestVal) { bestVal = val; pick = i; }
  }
  if (pick < 0) return;
  const card = G.market.splice(pick, 1)[0];
  P().owned.push(card);
  G.tookCardThisTurn = true;
  refillMarket();
}

// 精霊カードを選ぶ（idまたは'none'）。ソロの最初の手番開始時のみ。
function chooseSpirit(id) {
  if (!isSolo()) return;
  if (P().spirit) return;               // 既に選択済み
  if (G.turn !== 1 || G.hand.length)    // 1手目を始める前のみ
    { setHint('精霊カードは最初の手番の開始時にのみ選べます'); return; }
  P().spirit = id;
  save(); renderAll();
  const s = id === 'none' ? '精霊なし' : spiritById(id).name;
  setHint('精霊：' + s + ' を選択。中央スペースからトークンを取得しよう');
}

// =========================================================================
// 得点まとめ（ソロ勝利点は近似：正式表が未公開のため調整可能）
// =========================================================================
function computeScore() {
  const terrain = computeTerrainScore();
  let animal = 0;
  for (const c of P().owned) animal += cardScore(c);
  const spirit = spiritPoints();
  const total = terrain.total + animal + spirit;
  // ソロ勝利点：ゲーム得点の正式変換表（40→1 ... 160→8）
  const thresholds = [40, 70, 90, 110, 130, 140, 150, 160];
  let scoreVp = 0;
  for (const t of thresholds) if (total >= t) scoreVp++;
  const boardVp = 1;                 // A面＝1点（B面は今後対応）
  const spiritVp = spiritTypeVp();   // なし=2 / グループ=1 / 個別=0
  const vp = scoreVp + boardVp + spiritVp;
  return { terrain, animal, spirit, total, scoreVp, boardVp, spiritVp, vp };
}

// 指定プレイヤーの得点を計算（現在プレイヤーを一時的に切り替える）
function scoreForPlayer(i) {
  const cur = G.current;
  G.current = i; syncAliases();
  const s = computeScore();
  G.current = cur; syncAliases();
  return s;
}

// =========================================================================
// 描画
// =========================================================================
function renderAll() {
  renderBoardTitle();
  renderTabs();
  renderBoard();
  renderCentral();
  renderHand();
  renderSpirit();
  renderAnimals();
  renderScore();
  // CPU手番中・CPUの番・終了時は「ターン終了」を無効化
  document.getElementById('btn-endturn').disabled = G.over || G.cpuThinking || (P() && P().isCpu);
}

// 個人ボード／中央ボードの見出しに現在プレイヤーとモードを表示
function renderBoardTitle() {
  const ct = document.getElementById('central-title');
  if (ct) ct.textContent = isSolo() ? '中央ボード（ソロ・3スペース）' : '中央ボード（' + centralSize() + 'スペース）';
  const at = document.getElementById('animals-title');
  if (at) at.textContent = '動物カード（場に' + marketSize() + '枚）';
  const el = document.getElementById('board-title');
  if (!el) return;
  if (isSolo()) { el.textContent = '個人ボード'; return; }
  const viewing = G.view === G.current
    ? '<b style="color:var(--accent)">' + PV().name + '</b> の手番'
    : '<b>' + PV().name + '</b> の盤（閲覧）／手番：' + P().name;
  el.innerHTML = '個人ボード ― ' + viewing +
    ' <span style="color:var(--muted);font-weight:400">（' + G.mode + '人／手番' + G.turn +
    (G.finishing ? '・最終ラウンド' : '') + '）</span>';
}

// プレイヤー切替タブ（マルチのみ）
function renderTabs() {
  const el = document.getElementById('board-tabs');
  if (!el) return;
  if (isSolo()) { el.innerHTML = ''; el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = G.players.map((p, i) => {
    const total = scoreForPlayer(i).total;
    const cls = 'tab' + (i === G.view ? ' viewing' : '') + (i === G.current ? ' turn' : '');
    const mark = i === G.current ? '▶ ' : '';
    return '<button class="' + cls + '" data-view="' + i + '">' + mark + p.name +
      '<span class="tab-score">' + total + '</span></button>';
  }).join('');
  el.querySelectorAll('button[data-view]').forEach(b =>
    b.addEventListener('click', () => selectView(parseInt(b.getAttribute('data-view'), 10))));
}

function hexPixel(col, row) {
  // フラットトップ・odd-q：奇数列を半個下へずらす
  const x = HEX * 1.5 * col + HEX + 4;
  const y = HEX * SQRT3 * (row + (col & 1 ? 0.5 : 0)) + HEX + 4;
  return [x, y];
}
function hexPoints(cx, cy, r) {
  // flat-top（頂点を 0°,60°,… に配置）
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i);
    pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
  }
  return pts.join(' ');
}

function renderBoard() {
  const svg = document.getElementById('board');
  const viewCells = PV().cells;        // 表示中プレイヤーの盤
  const canAct = interactive();        // 操作できるのは自分の手番の盤のみ
  // 実際のセル位置から描画範囲を算出
  let maxX = 0, maxY = 0;
  for (const cell of Object.values(viewCells)) {
    const [cx, cy] = hexPixel(cell.col, cell.row);
    maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
  }
  const w = maxX + HEX + 6, h = maxY + HEX + 8;
  svg.setAttribute('viewBox', '0 0 ' + w.toFixed(0) + ' ' + h.toFixed(0));
  svg.innerHTML = '';

  const placeableKeys = new Set();
  const placingCube = canAct && G.placingCard != null && G.cubeAnchors;
  if (placingCube) {
    G.cubeAnchors.forEach(k => placeableKeys.add(k));
  } else if (canAct && G.selectedHand != null) {
    const type = G.hand[G.selectedHand];
    for (const c of Object.values(viewCells)) if (canPlaceOn(c, type)) placeableKeys.add(c.key);
  }
  const card = placingCube ? P().owned[G.placingCard] : null;
  const hexEls = {};   // key → <g>

  for (const cell of Object.values(viewCells)) {
    const [cx, cy] = hexPixel(cell.col, cell.row);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const isPlaceable = placeableKeys.has(cell.key);
    g.setAttribute('class', 'hex' + (isPlaceable ? ' placeable' : ''));
    g.setAttribute('data-key', cell.key);
    if (canAct) g.addEventListener('click', () => clickCell(cell.key));
    hexEls[cell.key] = g;

    // ホバー時：キューブ配置なら動物の形全体をプレビュー表示
    if (isPlaceable) {
      g.addEventListener('mouseenter', () => {
        g.classList.add('hover');
        if (placingCube) {
          const keys = matchedPatternCells(cell, card);
          if (keys) keys.forEach((k, i) => hexEls[k] &&
            hexEls[k].classList.add(i === 0 ? 'preview-anchor' : 'preview'));
        }
      });
      g.addEventListener('mouseleave', () => {
        Object.values(hexEls).forEach(e =>
          e.classList.remove('hover', 'preview', 'preview-anchor'));
      });
    }

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('class', 'hex-outline');
    poly.setAttribute('points', hexPoints(cx, cy, HEX - 2));
    g.appendChild(poly);

    // スタック描画（上に行くほど小さく＋上へずらす）
    cell.stack.forEach((t, i) => {
      const rr = (HEX - 6) - i * 4;
      const oy = -i * 5;
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      p.setAttribute('class', 'stack-token');
      p.setAttribute('points', hexPoints(cx, cy + oy, Math.max(rr, 8)));
      p.setAttribute('fill', TOKENS[t].color);
      g.appendChild(p);
    });
    if (cell.stack.length) {
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('class', 'stack-height');
      label.setAttribute('x', cx);
      label.setAttribute('y', cy - (cell.stack.length - 1) * 5 + 4);
      label.textContent = TOKENS[topType(cell)].label + (cell.stack.length > 1 ? cell.stack.length : '');
      g.appendChild(label);
    }
    if (cell.cube) {
      const cube = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      cube.setAttribute('class', 'cube');
      cube.setAttribute('x', cx + HEX / 2 - 6);
      cube.setAttribute('y', cy - (cell.stack.length) * 5 - 4);
      cube.setAttribute('width', 12); cube.setAttribute('height', 12);
      cube.setAttribute('rx', 2);
      g.appendChild(cube);
    }
    svg.appendChild(g);
  }
}

function tokEl(type, extraClass) {
  const d = document.createElement('div');
  d.className = 'tok' + (extraClass ? ' ' + extraClass : '');
  d.style.background = TOKENS[type].color;
  d.textContent = TOKENS[type].label;
  return d;
}

function renderCentral() {
  const el = document.getElementById('central');
  el.innerHTML = '';
  const locked = !interactive() || G.hand.length;   // 操作不可 or 手札処理中
  G.central.forEach((space, i) => {
    const d = document.createElement('div');
    d.className = 'space' + (space.length === 0 ? ' empty' : '') + (locked ? ' disabled' : '');
    space.forEach(t => d.appendChild(tokEl(t)));
    if (space.length === 0) d.textContent = '空';
    d.addEventListener('click', () => takeSpace(i));
    el.appendChild(d);
  });
}

function renderHand() {
  const label = document.getElementById('hand-label');
  const el = document.getElementById('hand');
  el.innerHTML = '';
  // 手札は手番プレイヤーのもの。別の盤を閲覧中は表示しない
  if (G.view !== G.current || !G.hand.length) { label.textContent = '手札：なし'; return; }
  label.textContent = '手札：クリックして選択 → 盤に配置';
  G.hand.forEach((t, i) => {
    const cls = (G.handUsed[i] ? 'used' : '') + (G.selectedHand === i ? ' selected' : '');
    const d = tokEl(t, cls.trim());
    d.addEventListener('click', () => selectHand(i));
    el.appendChild(d);
  });
}

function cardEl(card, opts) {
  const d = document.createElement('div');
  const done = (card.placed || 0) >= card.slots.length;
  d.className = 'card' + (done ? ' done' : '');
  const patHtml = card.pattern.map(p => TOKENS[p.color].label + (p.h ? '(高' + p.h + ')' : '')).join(' + ');
  d.innerHTML =
    '<h4>' + card.name + '</h4>' +
    '<div class="pat">' + card.desc + '<br><small>' + patHtml + '</small></div>' +
    '<div class="slots">' + card.slots.map((v, i) => {
      const placed = card.placed || 0;
      const open = i >= card.slots.length - placed; // 下から埋まる
      return '<div class="slot' + (open ? ' open' : '') + '">' + v + '</div>';
    }).join('') + '</div>';
  if (opts.type === 'market') {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = '取得';
    b.disabled = !interactive() || G.tookCardThisTurn || incompleteCount(P()) >= 4;
    b.addEventListener('click', () => takeCard(opts.idx));
    d.appendChild(b);
  } else {
    const b = document.createElement('button');
    b.className = 'small';
    b.textContent = done ? '完成' : 'キューブを置く';
    b.disabled = done || !interactive();
    b.addEventListener('click', () => startPlaceCube(opts.idx));
    d.appendChild(b);
  }
  return d;
}

function renderSpirit() {
  const panel = document.getElementById('spirit-panel');
  const el = document.getElementById('spirit');
  if (!el) return;
  // マルチでは精霊を使わないのでパネルごと非表示
  if (!isSolo()) { if (panel) panel.style.display = 'none'; return; }
  if (panel) panel.style.display = '';
  const sp = P().spirit;
  const typeLabel = t => t === 'group' ? 'グループ効果(勝利点+1)' : '個別効果(勝利点+0)';
  if (!sp) {
    // 未選択：2枚＋「なし」を提示
    let html = '<div class="panel-subtitle" style="margin-top:0">開始時に1枚選択（または精霊なし）</div><div class="spirit-choices">';
    for (const id of P().spiritOffer) {
      const s = spiritById(id);
      html += '<div class="spirit-card"><h4>' + s.name + '</h4>' +
        '<div class="pat">' + s.desc + '<br><small>' + typeLabel(s.type) + '</small></div>' +
        '<button class="small" data-sp="' + id + '">選ぶ</button></div>';
    }
    html += '<div class="spirit-card none"><h4>精霊なし</h4>' +
      '<div class="pat">精霊を使わない<br><small>勝利点+2</small></div>' +
      '<button class="small ghost" data-sp="none">これにする</button></div>';
    html += '</div>';
    el.innerHTML = html;
    el.querySelectorAll('button[data-sp]').forEach(b =>
      b.addEventListener('click', () => chooseSpirit(b.getAttribute('data-sp'))));
  } else if (sp === 'none') {
    el.innerHTML = '<div class="pat">精霊なし（ソロ勝利点 +2）</div>';
  } else {
    const s = spiritById(sp);
    el.innerHTML = '<div class="spirit-card chosen"><h4>' + s.name + '</h4>' +
      '<div class="pat">' + s.desc + '<br><small>' + typeLabel(s.type) +
      ' ／ 現在 ' + s.score() + ' 点</small></div></div>';
  }
}

function renderAnimals() {
  const m = document.getElementById('animals-market');
  const o = document.getElementById('animals-owned');
  m.innerHTML = ''; o.innerHTML = '';
  G.market.forEach((c, i) => m.appendChild(cardEl(c, { type: 'market', idx: i })));
  // 表示中プレイヤーの動物カード（別の盤を閲覧中はそのプレイヤーのものを閲覧）
  const owner = PV();
  const ownedLabel = document.getElementById('owned-label');
  if (ownedLabel) ownedLabel.textContent = (G.view === G.current ? '自分' : owner.name) + 'の動物カード（最大4枚）';
  if (!owner.owned.length) o.innerHTML = '<div style="color:var(--muted);font-size:12px">まだありません</div>';
  owner.owned.forEach((c, i) => o.appendChild(cardEl(c, { type: 'owned', idx: i })));
}

function renderScore() {
  const s = scoreForPlayer(G.view);        // 表示中プレイヤーの内訳
  const t = s.terrain.parts;
  const rows = [
    ['川', t.river], ['山', t.mountain], ['木(葉)', t.leaf],
    ['畑', t.field], ['建物', t.building], ['動物', s.animal],
  ];
  if (isSolo()) rows.push(['精霊', s.spirit]);
  let html = rows.map(([k, v]) => '<div class="row"><span>' + k + '</span><span>' + v + '</span></div>').join('') +
    '<div class="row total"><span>' + (isSolo() ? PV().name : PV().name + ' の得点') + '</span><span>' + s.total + '</span></div>';
  if (isSolo()) {
    html += '<div class="row"><span>ソロ勝利点</span><span class="vp">' + s.vp + '</span></div>' +
      '<div class="row" style="font-size:11px;color:var(--muted)"><span>内訳（得点' + s.scoreVp +
      '＋盤面' + s.boardVp + '＋精霊' + s.spiritVp + '）</span><span></span></div>';
  } else {
    // マルチ：全員の得点順位
    const standings = G.players.map((p, i) => ({ i, name: p.name, total: scoreForPlayer(i).total }))
      .sort((a, b) => b.total - a.total);
    html += '<div class="panel-subtitle" style="margin:10px 0 6px">順位（現在）</div>' +
      standings.map((p, rank) =>
        '<div class="row"><span>' + (rank + 1) + '位　' +
        (p.i === G.current ? '<b style="color:var(--accent)">' + p.name + '</b>'
          : (p.i === G.view ? '<b>' + p.name + '</b>' : p.name)) +
        '</span><span>' + p.total + '</span></div>').join('');
  }
  html += '<div class="row"><span>手番</span><span>' + G.turn + '</span></div>';
  document.getElementById('score').innerHTML = html;
}

function setHint(msg) {
  const el = document.getElementById('hint');
  if (G.placingCard != null) {
    el.innerHTML = msg + ' <button class="small ghost" id="cancel-cube">キャンセル</button>';
    document.getElementById('cancel-cube').addEventListener('click', cancelPlaceCube);
  } else {
    el.textContent = msg;
  }
}

function showResult() {
  let body;
  if (isSolo()) {
    const s = computeScore();
    body =
      '<p>ゲーム得点 <b style="font-size:22px">' + s.total + '</b> 点</p>' +
      '<p>ソロ勝利点：<b style="font-size:20px">' + s.vp + '</b>' +
      '（得点 ' + s.scoreVp + '＋盤面 ' + s.boardVp + '＋精霊 ' + s.spiritVp + '）</p>' +
      '<ul>' +
        '<li>川 ' + s.terrain.parts.river + ' / 山 ' + s.terrain.parts.mountain +
        ' / 木(葉) ' + s.terrain.parts.leaf + '</li>' +
        '<li>畑 ' + s.terrain.parts.field + ' / 建物 ' + s.terrain.parts.building +
        ' / 動物 ' + s.animal + ' / 精霊 ' + s.spirit + '</li>' +
      '</ul>';
  } else {
    // マルチ：全員の内訳と順位、勝者
    const rows = G.players.map((p, i) => {
      const s = scoreForPlayer(i);
      return { name: p.name, s };
    }).sort((a, b) => {
      if (b.s.total !== a.s.total) return b.s.total - a.s.total;
      // 同点はキューブ配置数（動物完成度の目安）で決定
      return cubeCount(b) - cubeCount(a);
    });
    const top = rows[0].s.total;
    const winners = rows.filter(r => r.s.total === top).map(r => r.name).join('・');
    body = '<p>勝者：<b style="font-size:20px;color:var(--accent)">' + winners + '</b>（' + top + '点）</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<tr style="text-align:left;color:var(--muted)"><th>順位</th><th>プレイヤー</th>' +
      '<th>川</th><th>山</th><th>木</th><th>畑</th><th>建</th><th>動物</th><th>合計</th></tr>' +
      rows.map((r, i) => {
        const p = r.s.terrain.parts;
        return '<tr><td>' + (i + 1) + '</td><td>' + r.name + '</td><td>' + p.river + '</td><td>' +
          p.mountain + '</td><td>' + p.leaf + '</td><td>' + p.field + '</td><td>' + p.building +
          '</td><td>' + r.s.animal + '</td><td><b>' + r.s.total + '</b></td></tr>';
      }).join('') + '</table>';
  }
  openModal('<h2>ゲーム終了！</h2>' + body + '<button id="modal-new">もう一度（同じ設定）</button>');
  const mode = G.mode, cpu = G.cpuCount || 0;
  document.getElementById('modal-new').addEventListener('click', () => { closeModal(); newGame(mode, cpu); });
}
// 同点処理用：そのプレイヤーが盤に置いたキューブ数
function cubeCount(row) {
  const idx = G.players.findIndex(p => p.name === row.name);
  return Object.values(G.players[idx].cells).filter(c => c.cube).length;
}

// =========================================================================
// モーダル / 遊び方
// =========================================================================
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
}
function closeModal() { document.getElementById('modal').classList.add('hidden'); }

function showRules() {
  const legend = Object.entries(TOKENS).map(([k, v]) =>
    '<span><span class="sw" style="background:' + v.color + '"></span>' + v.label + '（' + k + '）</span>').join('');
  openModal(
    '<h2>遊び方</h2>' +
    '<div class="legend">' + legend + '</div>' +
    '<ul>' +
    '<li><b>人数</b>：1人（ソロ＝精霊＋勝利点あり）／2〜4人（同じ画面を回して交代。素点で勝敗）。</li>' +
    '<li><b>手番</b>：中央ボードのスペースを1つ選び、トークン3個を取得 → 自分の盤に配置。</li>' +
    '<li><b>配置ルール</b>：川/畑=平置き。山=最大3段。木(幹)=最大2段。葉=地面か幹の上。建物=山/建物/木(高さ1)の上（高さ2まで）。</li>' +
    '<li><b>動物カード</b>：手番に1枚まで取得（最大4枚保持）。条件パターンが盤上にできたら「キューブを置く」。全キューブ配置で完成。場は 1人=3枚／2〜4人=5枚。</li>' +
    '<li><b>精霊カード（ソロのみ）</b>：最初の手番の前に2枚から1枚選ぶ（または「精霊なし」）。ソロ勝利点は「なし=+2／グループ=+1／個別=+0」。</li>' +
    '<li><b>ターン終了</b>：中央スペースを補充（ソロは残りを破棄）。マルチは次の人へ。</li>' +
    '<li><b>得点</b>：山/葉は高さ、畑は連結グループ、建物は隣接色数、川は最長経路長。</li>' +
    '<li><b>終了</b>：誰かの盤の空きが2以下、または袋が尽きたら、そのラウンドを終えて集計。マルチは最高得点が勝ち（同点はキューブ数）。</li>' +
    '</ul>' +
    '<p style="color:var(--muted);font-size:12px">※ 本家イラストは使わないオリジナル実装。2〜4人は1台を回して遊ぶホットシート方式です。</p>'
  );
}

// 人数選択モーダル（Step1：合計人数 → Step2：CPU人数）
function showModePicker() {
  openModal(
    '<h2>新規ゲーム：合計人数を選択</h2>' +
    '<p style="color:var(--muted)">2〜4人は同じ画面を回して交代（＋CPUと対戦）できます。</p>' +
    '<div class="mode-picker">' +
    '<button data-mode="1">1人（ソロ）</button>' +
    '<button data-mode="2">2人</button>' +
    '<button data-mode="3">3人</button>' +
    '<button data-mode="4">4人</button>' +
    '</div>'
  );
  document.querySelectorAll('.mode-picker button').forEach(b =>
    b.addEventListener('click', () => {
      const mode = parseInt(b.getAttribute('data-mode'), 10);
      if (mode === 1) { closeModal(); newGame(1, 0); }
      else showCpuPicker(mode);
    }));
}

// CPU人数の選択（0〜mode-1。人間は最低1人）
function showCpuPicker(mode) {
  let btns = '';
  for (let cpu = 0; cpu <= mode - 1; cpu++) {
    const human = mode - cpu;
    const label = cpu === 0 ? '全員プレイヤー' : ('CPU ' + cpu + '人（人間' + human + '人）');
    btns += '<button data-cpu="' + cpu + '">' + label + '</button>';
  }
  openModal(
    '<h2>' + mode + '人プレイ：CPUの人数は？</h2>' +
    '<p style="color:var(--muted)">CPUの手番は自動で進みます。1人で複数人プレイを楽しめます。</p>' +
    '<div class="mode-picker vert">' + btns + '</div>' +
    '<p style="margin-top:10px"><button class="ghost small" id="cpu-back">← 人数選択に戻る</button></p>'
  );
  document.querySelectorAll('.mode-picker button').forEach(b =>
    b.addEventListener('click', () => { closeModal(); newGame(mode, parseInt(b.getAttribute('data-cpu'), 10)); }));
  document.getElementById('cpu-back').addEventListener('click', showModePicker);
}

// =========================================================================
// セーブ / ロード
// =========================================================================
const SAVE_KEY = 'harmonies_v6';
function save() {
  try {
    const copy = JSON.parse(JSON.stringify(G));
    // 別名参照/一時的なUI状態は保存しない（players[] が正）
    delete copy.cells; delete copy.cpuThinking;
    delete copy.selectedHand; delete copy.placingCard; delete copy.cubeAnchors;
    localStorage.setItem(SAVE_KEY, JSON.stringify(copy));
  } catch (e) { /* localStorage不可でも続行 */ }
}
function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    G = JSON.parse(raw);
    if (!G.players || !G.players.length) return false;
    if (G.view == null) G.view = G.current || 0;
    syncAliases();                    // G.cells を現在プレイヤーへ結び直す
    return true;
  } catch (e) { return false; }
}

// =========================================================================
// 起動
// =========================================================================
document.getElementById('btn-new').addEventListener('click', showModePicker);
document.getElementById('btn-rules').addEventListener('click', showRules);
document.getElementById('btn-endturn').addEventListener('click', endTurn);
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') closeModal();
});

if (load() && G && G.cells) {
  G.cpuThinking = false;
  renderAll();
  setHint(G.over ? 'ゲーム終了。新規ゲームで再開できます'
    : (isSolo() ? '再開しました。手番を続けよう' : P().name + 'の手番：続けよう'));
  scheduleCpuIfNeeded();   // 中断がCPUの番だった場合は自動再開
} else {
  showModePicker();
}
