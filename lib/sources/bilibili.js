// bilibili：
//   影片（BV…）的搜尋與資料、各種清單（合集、系列、收藏夾）→ bilibili 的網頁接口（見 bilibili-web.js）；
//     接口失敗（不是被限流）時，核心會退回用 yt-dlp 讀。
//   音頻區（bilibili.com/audio，au… 單曲與 am… 歌單）→ 音頻區自己的公開查詢接口。
//   下載音訊一律交給 yt-dlp（見 ytdlp.js）。所有查詢都經過同一條排隊的請求層。
// 都是公開內容，不需要帳號；需要登入或大會員的內容讀不到。
// 2026-11 實測：音頻區的搜尋接口固定回空結果，所以「搜尋」只找影片。
const AUDIO_API = 'https://www.bilibili.com/audio/music-service-c/web';
import { BILI_UA as UA, createBilibiliWeb } from './bilibili-web.js';

export const BILI_TRACK = /^(BV[A-Za-z0-9]{10}|au\d{1,12})$/;
export const BILI_LIST = /^(am\d{1,12}|ml\d{1,16}|up-\d{1,16}|(season|series|fav)-\d{1,16}-\d{1,16})$/;

/** 認出 bilibili 的連結。短網址（b23.tv）回 kind:'short'，要先解析成完整網址。 */
export function parseBilibiliLink(text) {
  let url;
  try {
    url = new URL(String(text || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^(www|m)\./, '');
  const path = url.pathname.replace(/^\/zh-[A-Za-z]+\//, '/').replace(/\/$/, '');
  let m;
  if (host === 'b23.tv') return (m = /^\/([A-Za-z0-9]{4,20})$/.exec(path)) ? { kind: 'short', id: m[1] } : null;
  if (host === 'bilibili.com') {
    if ((m = /^\/video\/(BV[A-Za-z0-9]{10})$/.exec(path))) return { kind: 'track', id: m[1] };
    if ((m = /^\/audio\/au(\d{1,12})$/.exec(path))) return { kind: 'track', id: 'au' + m[1] };
    if ((m = /^\/audio\/am(\d{1,12})$/.exec(path))) return { kind: 'playlist', id: 'am' + m[1] };
    if ((m = /^\/(?:list|medialist\/play|medialist\/detail)\/ml(\d{1,16})$/.exec(path))) return { kind: 'playlist', id: 'ml' + m[1] };
    // bilibili.com/list/<UP 主編號>：那位 UP 主的全部投稿（最新的在前）。
    if ((m = /^\/(?:list|medialist\/play)\/(\d{1,16})$/.exec(path))) return { kind: 'playlist', id: 'up-' + m[1] };
    return null;
  }
  if (host === 'space.bilibili.com') {
    const sid = url.searchParams.get('sid');
    const fid = url.searchParams.get('fid');
    if ((m = /^\/(\d{1,16})\/lists\/(\d{1,16})$/.exec(path))) return { kind: 'playlist', id: (url.searchParams.get('type') === 'series' ? 'series-' : 'season-') + m[1] + '-' + m[2] };
    if ((m = /^\/(\d{1,16})\/channel\/(collectiondetail|seriesdetail)$/.exec(path)) && /^\d{1,16}$/.test(sid || '')) return { kind: 'playlist', id: (m[2] === 'seriesdetail' ? 'series-' : 'season-') + m[1] + '-' + sid };
    if ((m = /^\/(\d{1,16})\/favlist$/.exec(path)) && /^\d{1,16}$/.test(fid || '')) return { kind: 'playlist', id: 'fav-' + m[1] + '-' + fid };
    // UP 主空間的「投稿」分頁，和 bilibili.com/list/<編號> 是同一份清單。
    if ((m = /^\/(\d{1,16})\/(?:video|upload\/video)$/.exec(path))) return { kind: 'playlist', id: 'up-' + m[1] };
  }
  return null;
}

/** 清單 ID 換成交給 yt-dlp 的網址（am… 歌單不走這裡）。 */
export function listUrl(id) {
  let m;
  if ((m = /^ml(\d{1,16})$/.exec(id))) return 'https://www.bilibili.com/list/ml' + m[1];
  if ((m = /^up-(\d{1,16})$/.exec(id))) return 'https://www.bilibili.com/list/' + m[1];
  if ((m = /^(season|series|fav)-(\d{1,16})-(\d{1,16})$/.exec(id))) {
    if (m[1] === 'fav') return `https://space.bilibili.com/${m[2]}/favlist?fid=${m[3]}`;
    return `https://space.bilibili.com/${m[2]}/lists/${m[3]}?type=${m[1]}`;
  }
  return '';
}

export const trackUrl = (id) => (/^au\d{1,12}$/.test(id) ? 'https://www.bilibili.com/audio/' + id : /^BV[A-Za-z0-9]{10}$/.test(id) ? 'https://www.bilibili.com/video/' + id : '');

const songRow = (s) =>
  s && Number.isSafeInteger(s.id) && s.id > 0
    ? { id: 'au' + s.id, title: String(s.title || '').slice(0, 200), artist: String(s.author || s.uname || '').slice(0, 100), duration: Number(s.duration) || 0, url: 'https://www.bilibili.com/audio/au' + s.id }
    : null;

export function createBilibili({ fetchImpl = fetch, deviceFile = '', web = createBilibiliWeb({ fetchImpl, deviceFile }) } = {}) {
  // 音頻區的查詢也走同一條排隊的請求層（間隔、被擋後冷卻）。
  async function api(path, query, signal) {
    let data;
    try {
      data = await web.request(AUDIO_API + path + '?' + new URLSearchParams(query), { signal, referer: 'https://www.bilibili.com/audio/home' });
    } catch (error) {
      if (error?.rateLimited) throw error;
      throw Object.assign(Error(error?.biliCode === 4511001 ? '這首音頻找不到或已下架' : error?.biliCode !== undefined ? 'bilibili 音頻區沒有這個項目' : error.message), { status: 404 });
    }
    if (!data) throw Object.assign(Error('bilibili 音頻區沒有這個項目'), { status: 404 });
    return data;
  }

  return {
    id: 'bilibili',
    parseLink: parseBilibiliLink,
    /** 影片搜尋、單支影片資料、清單：見 bilibili-web.js。 */
    search: (keyword, options) => web.search(keyword, options),
    video: (bvid, options) => web.video(bvid, options),
    list: (id, options) => web.list(id, options),
    stats: () => web.stats(),
    /** 音頻區單曲的資料。id：au… */
    async audio(id, { signal } = {}) {
      const m = /^au(\d{1,12})$/.exec(id || '');
      if (!m) throw Error('音頻編號格式不正確');
      const row = songRow(await api('/song/info', { sid: m[1] }, signal));
      if (!row) throw Error('這首音頻找不到或已下架');
      return row;
    },
    /** 音頻區歌單的曲目。id：am… */
    async menuSongs(id, { signal, limit = 200 } = {}) {
      const m = /^am(\d{1,12})$/.exec(id || '');
      if (!m) throw Error('歌單編號格式不正確');
      const info = await api('/menu/info', { sid: m[1] }, signal).catch(() => ({}));
      const tracks = [];
      for (let pn = 1; tracks.length < limit && pn <= 10; pn++) {
        const page = await api('/song/of-menu', { sid: m[1], pn: String(pn), ps: '100' }, signal);
        for (const s of page.data || []) {
          const row = songRow(s);
          if (row) tracks.push(row);
        }
        if (pn >= (Number(page.pageCount) || 1)) break;
      }
      return { title: String(info.title || '').slice(0, 200), tracks: tracks.slice(0, limit) };
    },
    /** 音頻區首頁的熱門歌單。 */
    async hitMenus({ signal } = {}) {
      const page = await api('/menu/hit', { pn: '1', ps: '30' }, signal);
      return (page.data || []).filter((x) => Number.isSafeInteger(x?.menuId) && x.menuId > 0).map((x) => ({ id: 'am' + x.menuId, name: String(x.title || '').slice(0, 200) }));
    },
    /** 短網址（b23.tv）解析成完整網址；只接受轉到 bilibili 自己的網域。 */
    async resolveShort(code, { signal } = {}) {
      if (!/^[A-Za-z0-9]{4,20}$/.test(code || '')) throw Error('短網址格式不正確');
      const response = await fetchImpl('https://b23.tv/' + code, { redirect: 'manual', headers: { 'user-agent': UA }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
      const location = response.headers?.get?.('location') || '';
      const hit = parseBilibiliLink(location);
      if (!hit || hit.kind === 'short') throw Error('這個短網址不是影片、音頻或清單');
      return hit;
    },
  };
}
