// Apple Music：
//   搜尋、單曲、專輯 → Apple 公開的 iTunes Search API，不需要任何金鑰。
//   歌單（公開的 pl.… 歌單）→ Apple Music API，需要開發者權杖（付費的 Apple Developer 帳號）。
// 不取得、不解密 Apple Music 的音訊。
import { createPrivateKey, sign } from 'node:crypto';

const ITUNES = 'https://itunes.apple.com';
const MUSIC_API = 'https://api.music.apple.com/v1';

export function parseAppleLink(text) {
  const s = String(text || '');
  let m = /music\.apple\.com\/([a-z]{2})\/playlist\/[^/?#]*\/(pl\.[A-Za-z0-9_-]{6,80})/.exec(s);
  if (m) return { kind: 'playlist', id: m[2], country: m[1] };
  m = /music\.apple\.com\/([a-z]{2})\/(?:album|song)\/[^/?#]*\/(\d{5,14})(?:\?[^#]*?\bi=(\d{5,14}))?/.exec(s);
  if (!m) return null;
  if (m[3]) return { kind: 'track', id: m[3], country: m[1] };
  return { kind: /\/song\//.test(s) ? 'track' : 'album', id: m[2], country: m[1] };
}

const safeUrl = (url) => (/^https:\/\/music\.apple\.com\//.test(url || '') ? String(url).slice(0, 400) : '');
const itunesRow = (r) =>
  r && r.wrapperType === 'track' && r.kind === 'song' && r.trackId
    ? {
        id: String(r.trackId),
        title: String(r.trackName || '').slice(0, 200),
        artist: String(r.artistName || '').slice(0, 200),
        album: String(r.collectionName || '').slice(0, 200),
        duration: Math.round((Number(r.trackTimeMillis) || 0) / 1000),
        url: safeUrl(r.trackViewUrl),
      }
    : null;

/** 用 .p8 私鑰簽出開發者權杖（ES256 JWT，最長六個月；這裡簽十二小時）。 */
export function signDeveloperToken({ teamId, keyId, key, now = Date.now() }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const head = enc({ alg: 'ES256', kid: keyId }) + '.' + enc({ iss: teamId, iat, exp: iat + 43200 });
  const signature = sign('sha256', Buffer.from(head), { key: createPrivateKey(key), dsaEncoding: 'ieee-p1363' });
  return head + '.' + signature.toString('base64url');
}

export function createApple({ getConfig, secrets, fetchImpl = fetch, now = Date.now } = {}) {
  let signed = null; // { token, expiresAt }
  const country = () => getConfig().territory;

  async function itunes(path, query, signal) {
    const response = await fetchImpl(ITUNES + path + '?' + new URLSearchParams(query), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    if (!response.ok) throw Error(response.status === 403 || response.status === 429 ? 'Apple 暫時限制了請求次數，請稍後再試' : 'Apple 回應錯誤（' + response.status + '）');
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data?.results)) throw Error('Apple 回傳的格式看不懂');
    return data.results;
  }

  async function developerToken() {
    const direct = await secrets.get('appleToken');
    if (direct) return direct;
    if (signed && signed.expiresAt > now()) return signed.token;
    const [teamId, keyId, key] = [await secrets.get('appleTeamId'), await secrets.get('appleKeyId'), await secrets.get('appleKey')];
    if (!teamId || !keyId || !key) throw Object.assign(Error('讀 Apple Music 歌單需要開發者權杖；請到「來源帳號」填寫'), { code: 'NOT_CONFIGURED' });
    try {
      signed = { token: signDeveloperToken({ teamId, keyId, key, now: now() }), expiresAt: now() + 39600000 };
    } catch {
      throw Error('Apple 的私鑰（.p8 內容）格式不正確');
    }
    return signed.token;
  }

  return {
    id: 'apple',
    parseLink: parseAppleLink,
    async status() {
      const has = (await secrets.status()).has;
      return { hasDeveloperToken: has.appleToken || (has.appleTeamId && has.appleKeyId && has.appleKey) };
    },
    // 搜尋不需要金鑰，所以啟用就能用。
    configured: async () => true,
    reset() {
      signed = null;
    },
    async search(query, { signal, limit = 10 } = {}) {
      const rows = await itunes('/search', { term: String(query).slice(0, 200), media: 'music', entity: 'song', country: country(), limit: String(Math.min(25, limit)) }, signal);
      return rows.map(itunesRow).filter(Boolean);
    },
    async track(id, { signal, country: c } = {}) {
      if (!/^\d{5,14}$/.test(id || '')) throw Error('Apple Music 曲目 ID 格式不正確');
      const row = (await itunes('/lookup', { id, country: c || country(), entity: 'song' }, signal)).map(itunesRow).find(Boolean);
      if (!row) throw Error('Apple Music 沒有這首歌（或這個地區沒有上架）');
      return row;
    },
    async albumTracks(id, { signal, country: c } = {}) {
      if (!/^\d{5,14}$/.test(id || '')) throw Error('Apple Music 專輯 ID 格式不正確');
      const rows = await itunes('/lookup', { id, country: c || country(), entity: 'song', limit: '200' }, signal);
      return { title: String(rows.find((r) => r.wrapperType === 'collection')?.collectionName || '').slice(0, 200), tracks: rows.map(itunesRow).filter(Boolean) };
    },
    async playlistTracks(id, { signal, country: c, limit = 300 } = {}) {
      if (!/^pl\.[A-Za-z0-9_-]{6,80}$/.test(id || '')) throw Error('Apple Music 歌單 ID 格式不正確');
      const response = await fetchImpl(MUSIC_API + '/catalog/' + String(c || country()).toLowerCase() + '/playlists/' + id + '?include=tracks', {
        headers: { authorization: 'Bearer ' + (await developerToken()) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
      if (response.status === 401 || response.status === 403) throw Error('Apple 的開發者權杖無效或已過期');
      if (!response.ok) throw Error(response.status === 404 ? 'Apple Music 沒有這個歌單' : 'Apple Music 回應錯誤（' + response.status + '）');
      const data = await response.json().catch(() => ({}));
      const playlist = data.data?.[0];
      const tracks = (playlist?.relationships?.tracks?.data || [])
        .filter((t) => t?.type === 'songs' && /^\d{5,14}$/.test(t.id || ''))
        .map((t) => ({
          id: t.id,
          title: String(t.attributes?.name || '').slice(0, 200),
          artist: String(t.attributes?.artistName || '').slice(0, 200),
          album: String(t.attributes?.albumName || '').slice(0, 200),
          duration: Math.round((Number(t.attributes?.durationInMillis) || 0) / 1000),
          url: safeUrl(t.attributes?.url),
        }));
      return { title: String(playlist?.attributes?.name || '').slice(0, 200), tracks: tracks.slice(0, limit) };
    },
  };
}
