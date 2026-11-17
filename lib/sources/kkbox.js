// KKBOX：只讀歌曲資料與公開的分享歌單，不取得、不解密 KKBOX 的音訊。
//   有填金鑰 → 官方 Open API（用戶端憑證），搜尋可回多筆、可讀分享歌單與專輯。
//   沒填金鑰 → KKBOX 公開網站的搜尋頁，只拿得到最符合的那一首（2026-11 實測）。
// 叫 KKBOX 程式播放指定的歌：kkbox://song/<編號>#play（KKBOX 桌面版自己支援的連結，實測可用）。
const TOKEN_URL = 'https://account.kkbox.com/oauth2/token';
const API = 'https://api.kkbox.com/v1.1';
const ID = /^[A-Za-z0-9_-]{8,40}$/;

export function parseKkboxLink(text) {
  const m = /kkbox\.com\/[a-z]{2}\/[a-z]{2}\/(song|playlist|album)\/([A-Za-z0-9_-]{8,40})/.exec(String(text || ''));
  return m ? { kind: m[1] === 'song' ? 'track' : m[1], id: m[2] } : null;
}

const trackRow = (t, album) =>
  t && ID.test(t.id || '')
    ? {
        id: t.id,
        title: String(t.name || '').slice(0, 200),
        artist: String((t.album || album)?.artist?.name || '').slice(0, 200),
        album: String((t.album || album)?.name || '').slice(0, 200),
        duration: Math.round((Number(t.duration) || 0) / 1000),
        url: /^https:\/\/www\.kkbox\.com\//.test(t.url || '') ? t.url : '',
      }
    : null;

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#039': "'" };
const text = (value) => String(value ?? '').replace(/&(amp|lt|gt|quot|#0?39);/g, (_, name) => ENTITY[name]).trim().slice(0, 200);

/** 從 KKBOX 網站的搜尋頁取出歌曲（頁面裡的 <song-li> 區塊）。 */
export function parseKkboxSearchPage(html) {
  const rows = [];
  for (const block of String(html || '').split('<song-li ').slice(1)) {
    const id = /data-id="([A-Za-z0-9_-]{8,40})"/.exec(block)?.[1];
    if (!id) continue;
    const body = block.slice(0, block.indexOf('</song-li>') >= 0 ? block.indexOf('</song-li>') : 4000);
    const slot = (name) => text(new RegExp('slot="' + name + '"[^>]*\\btitle="([^"]*)"').exec(body)?.[1] || new RegExp('<a[^>]*\\btitle="([^"]*)"[^>]*slot="' + name + '"').exec(body)?.[1]);
    const [m, s] = (/data-duration="(\d{1,3}):(\d{2})"/.exec(body) || []).slice(1).map(Number);
    rows.push({ id, title: slot('song-name'), artist: slot('artist-name'), album: slot('album-name'), duration: Number.isFinite(m) ? m * 60 + s : 0, url: 'https://www.kkbox.com/tw/tc/song/' + id });
  }
  return rows.filter((r) => r.title);
}

/** 叫 KKBOX 程式播放某首歌的連結。 */
export const kkboxPlayLink = (id) => (ID.test(id || '') ? 'kkbox://song/' + id + '#play' : '');

export function createKkbox({ getConfig, secrets, fetchImpl = fetch, now = Date.now } = {}) {
  let access = null;
  const seen = new Map(); // 搜尋看過的歌：編號 → 資料（沒有金鑰時查單曲用）
  const hasKeys = async () => !!(await secrets.get('kkboxId')) && !!(await secrets.get('kkboxSecret'));

  // KKBOX 網站查得太頻繁會被擋（2026-11 實測：連續查幾次後改回 HTTP 202 的空白驗證頁）。
  // 所以同一個關鍵字十分鐘內用快取；被擋時說明原因並停五分鐘，不重試。
  const searched = new Map(); // 關鍵字 → { at, rows }
  let webBlockedUntil = 0;
  const blocked = () => Object.assign(Error('KKBOX 網站暫時擋下了搜尋（查得太頻繁）；請過幾分鐘再試，或到「來源帳號」填 KKBOX 金鑰改用官方接口'), { rateLimited: true, status: 429 });

  async function webSearch(query, signal) {
    const q = String(query).trim().slice(0, 100);
    const hit = searched.get(q);
    if (hit && now() - hit.at < 600000) return hit.rows;
    if (now() < webBlockedUntil) throw blocked();
    const territory = String(getConfig().territory || 'TW').toLowerCase();
    const region = ['tw', 'hk', 'jp', 'sg', 'my'].includes(territory) ? territory : 'tw';
    const response = await fetchImpl('https://www.kkbox.com/' + region + '/tc/search?' + new URLSearchParams({ q }), {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    const html = response.ok ? await response.text() : '';
    // 202（驗證頁）、403、429，或狀態正常但內容幾乎是空的：都當成被擋。
    if ([202, 403, 429].includes(response.status) || (response.ok && html.length < 2000)) {
      webBlockedUntil = now() + 300000;
      throw blocked();
    }
    if (!response.ok) throw Error('KKBOX 網站回應錯誤（' + response.status + '）');
    const rows = parseKkboxSearchPage(html);
    searched.set(q, { at: now(), rows });
    if (searched.size > 100) searched.delete(searched.keys().next().value);
    for (const row of rows) {
      seen.set(row.id, row);
      if (seen.size > 500) seen.delete(seen.keys().next().value);
    }
    return rows;
  }

  async function token() {
    if (access && access.expiresAt > now()) return access.token;
    const [id, secret] = [await secrets.get('kkboxId'), await secrets.get('kkboxSecret')];
    if (!id || !secret) throw Object.assign(Error('還沒有填 KKBOX 的 Client ID 與 Secret'), { code: 'NOT_CONFIGURED' });
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64') },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw Error('KKBOX 金鑰驗證失敗；請確認 Client ID 與 Secret');
    access = { token: body.access_token, expiresAt: now() + Math.min(Number(body.expires_in) || 3600, 86400) * 1000 - 60000 };
    return access.token;
  }

  async function call(path, query, signal) {
    const response = await fetchImpl(API + path + '?' + new URLSearchParams({ territory: getConfig().territory, ...query }), {
      headers: { authorization: 'Bearer ' + (await token()) },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 401) access = null;
    throw Error(response.status === 404 ? 'KKBOX 沒有這個項目（或這個地區沒有上架）' : 'KKBOX 回應錯誤（' + response.status + '）');
  }

  return {
    id: 'kkbox',
    parseLink: parseKkboxLink,
    async status() {
      const has = (await secrets.status()).has;
      return { hasKeys: has.kkboxId && has.kkboxSecret };
    },
    // 搜尋不一定要金鑰（沒有時用公開網站），所以啟用就能用。
    configured: async () => true,
    hasKeys,
    playLink: kkboxPlayLink,
    reset() {
      access = null;
    },
    /** 只驗證金鑰能不能換到權杖。 */
    async test() {
      access = null;
      await token();
      return { ok: true };
    },
    async search(query, { signal, limit = 10 } = {}) {
      if (!(await hasKeys())) return (await webSearch(query, signal)).slice(0, limit);
      const data = await call('/search', { q: String(query).slice(0, 200), type: 'track', limit: String(Math.min(20, limit)) }, signal);
      return (data.tracks?.data || []).map((t) => trackRow(t)).filter(Boolean);
    },
    async track(id, { signal } = {}) {
      if (!ID.test(id || '')) throw Error('KKBOX 曲目 ID 格式不正確');
      if (seen.has(id)) return seen.get(id);
      if (!(await hasKeys())) throw Object.assign(Error('沒有填 KKBOX 金鑰時，只能播放剛搜尋到的歌；請先搜尋'), { code: 'NOT_CONFIGURED' });
      const row = trackRow(await call('/tracks/' + id, {}, signal));
      if (!row) throw Error('KKBOX 沒有這首歌');
      return row;
    },
    async playlistTracks(id, { signal, limit = 300 } = {}) {
      if (!ID.test(id || '')) throw Error('KKBOX 歌單 ID 格式不正確');
      const info = await call('/shared-playlists/' + id, {}, signal).catch(() => ({}));
      const tracks = [];
      for (let offset = 0; offset < limit; offset += 100) {
        const data = await call('/shared-playlists/' + id + '/tracks', { limit: '100', offset: String(offset) }, signal);
        const rows = data.data || [];
        for (const t of rows) {
          const row = trackRow(t);
          if (row) tracks.push(row);
        }
        if (rows.length < 100) break;
      }
      return { title: String(info.title || '').slice(0, 200), tracks: tracks.slice(0, limit) };
    },
    async albumTracks(id, { signal } = {}) {
      if (!ID.test(id || '')) throw Error('KKBOX 專輯 ID 格式不正確');
      const album = await call('/albums/' + id, {}, signal);
      const data = await call('/albums/' + id + '/tracks', { limit: '100' }, signal);
      return { title: String(album.name || '').slice(0, 200), tracks: (data.data || []).map((t) => trackRow(t, album)).filter(Boolean) };
    },
  };
}
