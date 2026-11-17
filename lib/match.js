// 「對應播放」用的比對：把某個服務的一首歌（歌名、歌手、長度）對到本地音樂庫或 YouTube 上的同一首。
// 全部是純函式。

/** 比對用的正規化：全形轉半形、小寫、標點變空白。 */
export function norm(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// 版本標記：目標沒有而候選有（或相反）就扣分，避免把錄音室版對到現場版、翻唱或伴奏。
const VARIANTS = ['live', '現場', '演唱會', 'cover', '翻唱', 'karaoke', '伴奏', 'instrumental', 'remix', 'acoustic', 'demo', 'nightcore', 'sped up', 'slowed', '8d'];

/** 拿掉歌名裡不影響「是不是同一首」的附註。 */
export function cleanTitle(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\(\[（【〈《][^\)\]）】〉》]*(feat|ft\.|with|remaster|version|ver\.|official|mv|m\/v|lyric|audio|video|歌詞|官方|完整版|高音質|hd|4k|主題曲|插曲|片尾曲|片頭曲)[^\)\]）】〉》]*[\)\]）】〉》]/gi, ' ')
    .replace(/\s[-–—]\s.*(remaster|version|single|edit|mix).*$/i, ' ')
    .replace(/\b(feat|ft)\.?\s.+$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(text) {
  const s = text.replace(/ /g, '');
  if (s.length < 2) return s ? [s] : [];
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** 兩段文字的相似度（0～1，字元雙字組的 Dice 係數）。 */
export function similarity(a, b) {
  const x = bigrams(norm(a));
  const y = bigrams(norm(b));
  if (!x.length || !y.length) return 0;
  const counts = new Map();
  for (const g of x) counts.set(g, (counts.get(g) || 0) + 1);
  let hit = 0;
  for (const g of y) {
    const n = counts.get(g) || 0;
    if (n) {
      hit += 1;
      counts.set(g, n - 1);
    }
  }
  return (2 * hit) / (x.length + y.length);
}

const artistList = (value) =>
  (Array.isArray(value) ? value : String(value ?? '').split(/[,、;&／/]|\bfeat\.?\b|\bx\b/i))
    .map((a) => norm(a))
    .filter((a) => a.length >= 1);

/**
 * 候選與目標有多像（0～1）。
 * target：{ title, artist | artists, duration（秒，可沒有） }
 * candidate：{ title, artist, duration }
 */
export function matchScore(candidate, target) {
  const wantTitle = cleanTitle(target.title);
  const haveTitleRaw = String(candidate.title ?? '');
  const haveTitle = cleanTitle(haveTitleRaw);
  if (!norm(wantTitle) || !norm(haveTitle)) return 0;

  const wantArtists = artistList(target.artists || target.artist);
  const haveAll = norm(haveTitleRaw + ' ' + (candidate.artist ?? ''));
  // YouTube 的標題常是「歌手 - 歌名」，所以也比「標題去掉歌手名」之後的結果。
  let stripped = norm(haveTitle);
  for (const a of wantArtists) stripped = stripped.split(a).join(' ').replace(/\s+/g, ' ').trim();
  let title = Math.max(similarity(wantTitle, haveTitle), stripped ? similarity(wantTitle, stripped) : 0);
  const wantNorm = norm(wantTitle);
  if (wantNorm.length >= 2 && (' ' + norm(haveTitle) + ' ').includes(' ' + wantNorm + ' ')) title = Math.max(title, 0.9);
  else if (wantNorm.replace(/ /g, '').length >= 3 && norm(haveTitle).replace(/ /g, '').includes(wantNorm.replace(/ /g, ''))) title = Math.max(title, 0.8);

  let artist = 0.5; // 不知道歌手時不加不扣
  if (wantArtists.length) artist = wantArtists.some((a) => haveAll.includes(a)) ? 1 : 0;

  let duration = 0.5;
  const want = Number(target.duration);
  const have = Number(candidate.duration);
  if (want > 0 && have > 0) {
    const diff = Math.abs(want - have);
    duration = diff <= 3 ? 1 : diff <= 8 ? 0.8 : diff <= 20 ? 0.45 : diff <= 45 ? 0.15 : 0;
  }

  let score = title * 0.55 + artist * 0.25 + duration * 0.2;
  const wantText = norm(target.title);
  for (const v of VARIANTS) {
    const inWant = (' ' + wantText + ' ').includes(' ' + v + ' ') || (/[^\x00-\x7f]/.test(v) && wantText.includes(v));
    const inHave = (' ' + haveAll + ' ').includes(' ' + v + ' ') || (/[^\x00-\x7f]/.test(v) && haveAll.includes(v));
    if (inWant !== inHave) score -= 0.18;
  }
  return Math.max(0, Math.min(1, score));
}

/** 從候選裡挑最像的；沒有任何一個超過門檻就回 null。 */
export function pickBest(candidates, target, threshold = 0.6) {
  let best = null;
  for (const c of candidates) {
    const score = matchScore(c, target);
    if (score >= threshold && (!best || score > best.score)) best = { candidate: c, score };
  }
  return best;
}
