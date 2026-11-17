// bilibili 網頁接口的請求層。目標是「少打、慢打、被擋就停」，降低被流量管制（HTTP 412／風控碼）的機會：
//
//   1. 一次請求拿完整結果：搜尋、影片資料、合集都用回傳標題／UP 主／長度的接口，不逐筆查。
//   2. 固定的匿名裝置編號（buvid3／buvid4）：向 bilibili 要一次、存檔，之後都帶同一組，和瀏覽器一樣。
//   3. WBI 簽名：網頁端搜尋等接口要求的簽名（金鑰向 nav 接口取，快取一小時）。
//   4. 所有請求排成一列，兩次之間至少隔 0.5 秒；搜尋與清單結果快取五分鐘。
//   5. 被擋（412、-352、-412、v_voucher）時等 2.5 秒只重試一次；還是被擋，那個接口就進入五分鐘冷卻：冷卻期間直接回報，不再送請求。
//      冷卻是各接口分開算的：實測搜尋被擋時，音頻區與影片資料仍然正常。
//
// 這裡刻意不做「被擋就換一組裝置編號」或假造操作參數那一類規避風控的事。
// 不需要帳號，也不使用任何人的登入狀態。接口路徑參考 bilibili 網頁端的公開行為。
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

export const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const API = 'https://api.bilibili.com';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const RISK_CODES = [-352, -412, -509, -799];
const BV = /^BV[A-Za-z0-9]{10}$/;

/** WBI 的混合金鑰：兩個檔名接起來，照固定的表重排後取前 32 個字。 */
export function wbiMixinKey(imgUrl, subUrl) {
  const stem = (url) => String(url || '').split('/').pop().split('.')[0];
  const raw = stem(imgUrl) + stem(subUrl);
  if (raw.length < 64) return '';
  return MIXIN.map((i) => raw[i]).join('').slice(0, 32);
}

/** 參數加上時間戳、排序、去掉特殊字元後算簽名，回傳完整的查詢字串。 */
export function wbiSign(params, mixinKey, nowSeconds = Math.floor(Date.now() / 1000)) {
  const all = { ...params, wts: nowSeconds };
  const query = Object.keys(all)
    .sort()
    .map((key) => encodeURIComponent(key) + '=' + encodeURIComponent(String(all[key]).replace(/[!'()*]/g, '')))
    .join('&');
  return query + '&w_rid=' + createHash('md5').update(query + mixinKey).digest('hex');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
/** 搜尋結果的標題帶有標示關鍵字的 HTML 標籤與字元實體，整理成純文字。 */
export function plainTitle(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name) => ENTITIES[name])
    .trim()
    .slice(0, 200);
}

/** 「4:30」「1:02:03」或秒數 → 秒。 */
export function durationSeconds(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : 0;
  const parts = String(value || '').split(':').map((p) => Number(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((total, p) => total * 60 + p, 0);
}

const limited = (minutes) => Object.assign(Error('bilibili 暫時限制了這台電腦的請求；約 ' + minutes + ' 分鐘後再試'), { rateLimited: true, status: 429 });

export function createBilibiliWeb({ fetchImpl = fetch, deviceFile = '', now = Date.now, minIntervalMs = 500, cooldownMs = 300000, retryDelayMs = 2500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let chain = Promise.resolve();
  let lastAt = 0;
  const blockedUntil = new Map(); // 接口路徑 → 冷卻到什麼時候
  let lastBlock = null;
  let device = null; // { buvid3, buvid4 }
  let deviceLoaded = false;
  let mixin = null; // { key, at }
  const cache = new Map(); // key → { at, value }
  const stats = { requests: 0, limited: 0, cached: 0, retried: 0 };

  const remember = (key, value) => {
    cache.set(key, { at: now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  };
  const recall = (key, ttl = 300000) => {
    const hit = cache.get(key);
    if (!hit || now() - hit.at > ttl) return undefined;
    stats.cached += 1;
    return hit.value;
  };
  const block = (path, reason) => {
    stats.limited += 1;
    blockedUntil.set(path, now() + cooldownMs);
    lastBlock = { path, reason, at: now() };
    return limited(Math.ceil(cooldownMs / 60000));
  };
  const cooling = () => [...blockedUntil.values()].some((until) => now() < until);
  const cookie = () => (device?.buvid3 ? 'buvid3=' + device.buvid3 + (device.buvid4 ? '; buvid4=' + device.buvid4 : '') : '');

  /** 排隊送出一個請求並解析 JSON。raw：不檢查業務碼（給 nav 用，未登入時它的碼不是 0）。 */
  function request(url, { signal, referer = 'https://www.bilibili.com', raw = false } = {}) {
    // 送一次。被擋時回傳 { blocked: 原因 }，其他情況回傳 { value } 或丟出一般錯誤。
    const once = async (path) => {
      const wait = lastAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastAt = now();
      stats.requests += 1;
      const value = cookie();
      const response = await fetchImpl(url, {
        headers: { 'user-agent': BILI_UA, referer, accept: 'application/json, text/plain, */*', ...(value ? { cookie: value } : {}) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
      if (response.status === 412 || response.status === 429) return { blocked: 'HTTP ' + response.status };
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // 狀態 200 但回的是網頁（驗證頁或「請求過於頻繁」）：一樣當成被擋。
        if (/^\s*</.test(text)) return { blocked: 'HTTP ' + response.status + ' 回網頁' };
        throw Error('bilibili 回傳的格式看不懂');
      }
      if (raw) return { value: body };
      if (RISK_CODES.includes(body?.code) || body?.data?.v_voucher) return { blocked: body?.data?.v_voucher ? 'v_voucher' : 'code ' + body.code };
      if (!response.ok || body?.code !== 0) throw Object.assign(Error(body?.code === -404 || body?.code === 62002 ? 'bilibili 沒有這個項目（可能已刪除或不公開）' : 'bilibili 回應錯誤（' + (body?.code ?? response.status) + '）'), { status: 404, biliCode: body?.code });
      return { value: body.data };
    };
    const run = async () => {
      signal?.throwIfAborted();
      const path = new URL(url).pathname;
      const until = blockedUntil.get(path) || 0;
      if (now() < until) throw limited(Math.max(1, Math.ceil((until - now()) / 60000)));
      let outcome = await once(path);
      if (outcome.blocked) {
        // 匿名請求偶爾會被拒絕一次（實測過）：等 2.5 秒用同一組裝置編號再試一次，還是被擋才進入冷卻。
        stats.retried += 1;
        await sleep(retryDelayMs);
        signal?.throwIfAborted();
        outcome = await once(path);
      }
      if (outcome.blocked) throw block(path, outcome.blocked);
      return outcome.value;
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  }

  /** 取得（或讀回存檔的）匿名裝置編號。拿不到也照常繼續，只是比較容易被擋。 */
  async function ensureDevice(signal) {
    if (device?.buvid3) return;
    if (!deviceLoaded) {
      deviceLoaded = true;
      if (deviceFile) {
        try {
          const stored = JSON.parse(await readFile(deviceFile, 'utf8'));
          if (/^[A-Za-z0-9-]{20,80}$/.test(stored?.buvid3 || '')) device = { buvid3: stored.buvid3, buvid4: /^[A-Za-z0-9%-]{10,120}$/.test(stored.buvid4 || '') ? stored.buvid4 : '' };
        } catch {}
      }
      if (device?.buvid3) return;
    }
    try {
      const data = await request(API + '/x/frontend/finger/spi', { signal });
      if (/^[A-Za-z0-9-]{20,80}$/.test(data?.b_3 || '')) {
        device = { buvid3: data.b_3, buvid4: /^[A-Za-z0-9%-]{10,120}$/.test(data.b_4 || '') ? data.b_4 : '' };
        if (deviceFile) await writeFile(deviceFile, JSON.stringify({ ...device, at: now() }), 'utf8').catch(() => {});
      }
    } catch (error) {
      if (error?.rateLimited) throw error;
    }
  }

  async function mixinKey(signal) {
    if (mixin && now() - mixin.at < 3600000) return mixin.key;
    const body = await request(API + '/x/web-interface/nav', { signal, raw: true });
    const key = wbiMixinKey(body?.data?.wbi_img?.img_url, body?.data?.wbi_img?.sub_url);
    if (!key) throw Error('拿不到 bilibili 的簽名金鑰');
    mixin = { key, at: now() };
    return key;
  }

  async function signed(path, params, options = {}) {
    await ensureDevice(options.signal);
    const key = await mixinKey(options.signal);
    return request(API + path + '?' + wbiSign(params, key, Math.floor(now() / 1000)), options);
  }

  /** UP 主的名稱（一個請求，快取一小時）。查不到就回空字串；被限流則照常回報。 */
  async function upName(mid, signal) {
    const key = 'up:' + mid;
    const hit = recall(key, 3600000);
    if (hit !== undefined) return hit;
    try {
      const data = await request(API + '/x/web-interface/card?' + new URLSearchParams({ mid: String(mid) }), { signal, referer: 'https://space.bilibili.com/' + mid });
      return remember(key, String(data?.card?.name || '').slice(0, 100));
    } catch (error) {
      if (error?.rateLimited) throw error;
      return '';
    }
  }

  const archiveRow = (a, artist = '') =>
    a && BV.test(a.bvid || '') ? { id: a.bvid, title: plainTitle(a.title) || a.bvid, artist: String(a.upper?.name || a.owner?.name || a.author || artist || '').slice(0, 100), duration: durationSeconds(a.duration) } : null;

  return {
    request,
    stats: () => ({ ...stats, coolingDown: cooling(), hasDevice: !!device?.buvid3, lastBlock }),
    /** 影片搜尋：一次請求，結果直接帶標題、UP 主與長度。 */
    async search(keyword, { signal, limit = 10 } = {}) {
      const q = String(keyword || '').trim().slice(0, 100);
      if (!q) throw Error('請輸入歌名或歌手');
      const key = 'search:' + q;
      let rows = recall(key);
      if (!rows) {
        const data = await signed('/x/web-interface/wbi/search/type', { search_type: 'video', keyword: q, page: 1 }, { signal });
        rows = (Array.isArray(data?.result) ? data.result : []).map((r) => archiveRow(r)).filter(Boolean);
        // 空結果不快取：bilibili 偶爾會對正常的查詢回空清單（實測），下一次再查通常就有了。
        if (rows.length) remember(key, rows);
      }
      return rows.filter((r) => !r.duration || r.duration <= 1800).slice(0, limit);
    },
    /** 單支影片的標題、UP 主、長度。 */
    async video(bvid, { signal } = {}) {
      if (!BV.test(bvid || '')) throw Error('bilibili 影片編號格式不正確');
      const key = 'video:' + bvid;
      const hit = recall(key, 3600000);
      if (hit) return hit;
      await ensureDevice(signal);
      const data = await request(API + '/x/web-interface/view?' + new URLSearchParams({ bvid }), { signal });
      const row = archiveRow(data);
      if (!row) throw Error('bilibili 沒有這支影片');
      return remember(key, row);
    },
    /** 合集（season）、系列（series）、收藏夾（fav／ml）、UP 主的全部投稿（up）：一頁請求就帶回每支影片的標題。最多 30 支。
     *  合集與系列另外查一次擁有者的名稱當歌手（合集裡若有別人的影片，也會顯示成擁有者）。 */
    async list(id, { signal, limit = 30 } = {}) {
      const key = 'list:' + id;
      const hit = recall(key);
      if (hit) return hit;
      let m;
      let title = '';
      let rows = [];
      let owner = ''; // 合集與系列的接口不帶 UP 主名稱，要另外查擁有者
      if ((m = /^season-(\d{1,16})-(\d{1,16})$/.exec(id))) {
        const data = await signed('/x/polymer/web-space/seasons_archives_list', { mid: m[1], season_id: m[2], sort_reverse: false, page_num: 1, page_size: limit }, { signal, referer: 'https://space.bilibili.com/' + m[1] });
        title = data?.meta?.name || '';
        rows = data?.archives || [];
        owner = m[1];
      } else if ((m = /^series-(\d{1,16})-(\d{1,16})$/.exec(id))) {
        await ensureDevice(signal);
        const data = await request(API + '/x/series/archives?' + new URLSearchParams({ mid: m[1], series_id: m[2], only_normal: 'true', sort: 'desc', pn: '1', ps: String(limit) }), { signal, referer: 'https://space.bilibili.com/' + m[1] });
        rows = data?.archives || [];
        owner = m[1];
        // 系列的名稱在另一個接口；查不到就留空，不影響曲目。
        if (rows.length) title = (await request(API + '/x/series/series?' + new URLSearchParams({ series_id: m[2] }), { signal, referer: 'https://space.bilibili.com/' + m[1] }).catch((error) => (error?.rateLimited ? Promise.reject(error) : null)))?.meta?.name || '';
      } else if ((m = /^(?:fav-\d{1,16}-|ml)(\d{1,16})$/.exec(id))) {
        await ensureDevice(signal);
        // 收藏夾一頁最多 20 筆，所以讀兩頁。
        for (let pn = 1; pn <= 2 && rows.length < limit; pn++) {
          const data = await request(API + '/x/v3/fav/resource/list?' + new URLSearchParams({ media_id: m[1], pn: String(pn), ps: '20', platform: 'web' }), { signal });
          title = data?.info?.title || title;
          rows = rows.concat(data?.medias || []);
          if (!data?.has_more) break;
        }
      } else if ((m = /^up-(\d{1,16})$/.exec(id))) {
        await ensureDevice(signal);
        // UP 主的全部投稿（bilibili.com/list/<編號> 那一頁用的接口），最新的在前；一頁 20 筆，讀兩頁。
        let oid = '';
        for (let page = 0; page < 2 && rows.length < limit; page++) {
          const data = await request(API + '/x/v2/medialist/resource/list?' + new URLSearchParams({ mobi_app: 'web', type: '1', biz_id: m[1], oid, otype: '2', ps: '20', direction: 'false', desc: 'true', sort_field: '1', tid: '0', with_current: 'false' }), { signal, referer: 'https://www.bilibili.com/list/' + m[1] });
          const batch = (data?.media_list || []).map((x) => ({ bvid: x.bv_id, title: x.title, duration: x.duration, upper: x.upper, id: x.id }));
          rows = rows.concat(batch);
          if (!data?.has_more || !batch.length) break;
          oid = String(batch.at(-1).id || '');
          if (!oid) break;
        }
        const name = rows.find((r) => r.upper?.name)?.upper.name || '';
        title = name ? name + ' 的投稿' : 'UP 主的投稿';
      } else throw Error('bilibili 清單編號格式不正確');
      const artist = owner && rows.length ? await upName(owner, signal) : '';
      const all = rows.map((r) => archiveRow(r, artist)).filter(Boolean).slice(0, limit);
      // 超過 30 分鐘的影片播不了（下載時會被擋下），清單裡先拿掉，並回報略過了幾支。
      const entries = all.filter((r) => !r.duration || r.duration <= 1800);
      return remember(key, { title: plainTitle(title), entries, skipped: all.length - entries.length });
    },
  };
}
