// Spotify：官方 Web API。只讀歌曲資料與歌單，以及遙控使用者自己的 Spotify 播放器（需要 Premium）。
// 不取得、不解密 Spotify 的音訊。
//
// 登入用「授權碼＋PKCE」：只需要 Client ID，不需要 Client Secret。
// 登入時在本機開一個只收一次回呼的暫時接口（127.0.0.1:<port>/callback），收到或五分鐘後關閉。
// 端點依 2026 年 2 月的 Web API 變更：歌單曲目在 /playlists/{id}/items，搜尋一次最多 10 筆。
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const API = 'https://api.spotify.com/v1';
const ACCOUNTS = 'https://accounts.spotify.com';
export const SPOTIFY_SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'user-read-playback-state', 'user-modify-playback-state'];
const ID = /^[A-Za-z0-9]{22}$/;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function parseSpotifyLink(text) {
  const m = /(?:open\.spotify\.com\/(?:intl-[a-z-]+\/)?|spotify:)(track|playlist|album)[/:]([A-Za-z0-9]{22})/.exec(String(text || ''));
  return m ? { kind: m[1], id: m[2] } : null;
}

const trackRow = (t) =>
  t && ID.test(t.id || '') && t.type !== 'episode'
    ? {
        id: t.id,
        title: String(t.name || '').slice(0, 200),
        artist: (t.artists || []).map((a) => a.name).filter(Boolean).join(', ').slice(0, 200),
        album: String(t.album?.name || '').slice(0, 200),
        duration: Math.round((Number(t.duration_ms) || 0) / 1000),
        url: 'https://open.spotify.com/track/' + t.id,
      }
    : null;

export function createSpotify({ getConfig, secrets, fetchImpl = fetch, listen = createServer, now = Date.now } = {}) {
  let access = null; // { token, expiresAt }
  let pending = null; // 進行中的登入
  let lastLogin = null; // { ok, error, at }

  const clientId = () => String(getConfig().spotifyClientId || '');
  const redirectUri = () => `http://127.0.0.1:${getConfig().spotifyLoginPort}/callback`;

  async function tokenRequest(params) {
    const response = await fetchImpl(ACCOUNTS + '/api/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId(), ...params }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) throw Error('Spotify 登入失敗' + (body.error_description ? '：' + String(body.error_description).slice(0, 120) : body.error ? '：' + String(body.error).slice(0, 60) : ''));
    access = { token: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 - 60000 };
    if (body.refresh_token) await secrets.set({ spotifyRefresh: body.refresh_token });
    return access.token;
  }

  async function token() {
    if (access && access.expiresAt > now()) return access.token;
    const refresh = await secrets.get('spotifyRefresh');
    if (!clientId() || !refresh) throw Object.assign(Error('還沒有登入 Spotify'), { code: 'NOT_CONFIGURED' });
    return tokenRequest({ grant_type: 'refresh_token', refresh_token: refresh });
  }

  async function call(path, { method = 'GET', body, signal, query } = {}) {
    const url = API + path + (query ? '?' + new URLSearchParams(query) : '');
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: 'Bearer ' + (await token()), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    });
    if (response.status === 204 || response.status === 202) return {};
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    if (response.status === 401) access = null;
    const reason = String(data?.error?.reason || '');
    const message =
      reason === 'PREMIUM_REQUIRED' || (response.status === 403 && /premium/i.test(data?.error?.message || ''))
        ? '遙控播放需要 Spotify Premium'
        : reason === 'NO_ACTIVE_DEVICE' || response.status === 404
          ? '找不到正在使用的 Spotify 播放器；請先在任一裝置打開 Spotify'
          : response.status === 429
            ? 'Spotify 暫時限制了請求次數，請稍後再試'
            : 'Spotify 回應錯誤（' + response.status + '）' + (data?.error?.message ? '：' + String(data.error.message).slice(0, 120) : '');
    throw Error(message);
  }

  // ---- 不用登入也讀得到的公開資料 ----
  // Spotify 的嵌入頁（open.spotify.com/embed/<類型>/<編號>，給網站嵌入播放器用的公開頁面）裡
  // 帶著歌名、歌手與長度（2026-11 實測：單曲、專輯、歌單都有）。只讀這些文字資料：
  // 不使用頁面裡的權杖，不呼叫需要登入的接口，也不取得音訊。沒有登入時用它來認出貼上的連結。
  const publicCache = new Map();
  const idOf = (uri) => /^spotify:track:([A-Za-z0-9]{22})$/.exec(String(uri || ''))?.[1] || '';
  async function publicEntity(kind, id, signal) {
    const key = kind + ':' + id;
    const hit = publicCache.get(key);
    if (hit && hit.until > now()) return hit.entity;
    let response;
    try {
      response = await fetchImpl('https://open.spotify.com/embed/' + kind + '/' + id, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
        redirect: 'error',
        headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' },
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw Error('連不上 Spotify 的公開頁面');
    }
    if (response.status === 404) throw Error('Spotify 沒有這個連結的內容');
    if (!response.ok) throw Error('Spotify 的公開頁面回應錯誤（' + response.status + '）');
    const html = await response.text();
    const raw = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    let entity = null;
    try {
      entity = JSON.parse(raw || 'null')?.props?.pageProps?.state?.data?.entity || null;
    } catch {}
    if (!entity) throw Error('Spotify 的公開頁面讀不到這個連結的資料（頁面格式可能改了）；登入 Spotify 後可以正常使用');
    if (publicCache.size > 200) publicCache.clear();
    publicCache.set(key, { entity, until: now() + 10 * 60 * 1000 });
    return entity;
  }
  async function publicTrack(id, signal) {
    const e = await publicEntity('track', id, signal);
    const title = String(e.name || e.title || '').slice(0, 200);
    if (!title) throw Error('Spotify 沒有這首歌');
    return {
      id,
      title,
      artist: (e.artists || []).map((a) => a?.name).filter(Boolean).join(', ').slice(0, 200),
      album: '',
      duration: Math.round((Number(e.duration) || 0) / 1000),
      url: 'https://open.spotify.com/track/' + id,
    };
  }
  async function publicList(kind, id, signal, limit = 300) {
    const e = await publicEntity(kind, id, signal);
    const album = kind === 'album' ? String(e.name || '').slice(0, 200) : '';
    const tracks = (e.trackList || [])
      .map((t) => ({ id: idOf(t?.uri), title: String(t?.title || '').slice(0, 200), artist: String(t?.subtitle || '').slice(0, 200), album, duration: Math.round((Number(t?.duration) || 0) / 1000) }))
      .filter((t) => t.id && t.title)
      .map((t) => ({ ...t, url: 'https://open.spotify.com/track/' + t.id }));
    // 公開頁面只帶前面一部分曲目（歌單實測是前 50 首）。
    return { title: String(e.name || e.title || '').slice(0, 200), tracks: tracks.slice(0, limit), note: kind === 'playlist' && tracks.length >= 50 ? '沒有登入 Spotify，只讀得到歌單的前 ' + tracks.length + ' 首。' : '' };
  }
  const loggedIn = async () => !!clientId() && !!(await secrets.get('spotifyRefresh'));

  function closePending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    try {
      pending.server.close();
    } catch {}
    pending = null;
  }

  return {
    id: 'spotify',
    parseLink: parseSpotifyLink,
    async status() {
      const has = (await secrets.status()).has;
      return { clientId: !!clientId(), loggedIn: !!has.spotifyRefresh, redirectUri: redirectUri(), loginPending: !!pending, lastLogin };
    },
    async configured() {
      return !!clientId() && !!(await secrets.get('spotifyRefresh'));
    },
    /** 開始登入：回傳要在瀏覽器打開的授權網址。 */
    async beginLogin() {
      if (!clientId()) throw Object.assign(Error('請先填 Spotify 的 Client ID 並儲存'), { status: 400 });
      closePending();
      const verifier = b64url(randomBytes(48));
      const state = b64url(randomBytes(16));
      const redirect = redirectUri();
      const server = listen((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const page = (text) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end('<!doctype html><meta charset="utf-8"><title>DSH 點唱機</title><body style="font-family:sans-serif;padding:40px"><h2>' + text + '</h2><p>可以關掉這個分頁，回到 DSH。</p>');
        };
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        // state 不對的回呼一律不理，也不結束這次登入。
        if (!pending || url.searchParams.get('state') !== state) return page('這個登入連結已經失效');
        const code = url.searchParams.get('code');
        const denied = url.searchParams.get('error');
        closePending();
        if (!code) {
          lastLogin = { ok: false, error: denied === 'access_denied' ? '你在 Spotify 頁面按了取消' : 'Spotify 沒有回傳授權碼', at: now() };
          return page('沒有完成登入');
        }
        tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }).then(
          () => {
            lastLogin = { ok: true, at: now() };
            page('Spotify 登入完成');
          },
          (error) => {
            lastLogin = { ok: false, error: String(error?.message || error).slice(0, 200), at: now() };
            page('登入失敗');
          },
        );
      });
      await new Promise((resolve, reject) => {
        server.once('error', (error) => reject(Object.assign(Error(error.code === 'EADDRINUSE' ? `本機的 ${getConfig().spotifyLoginPort} 埠被占用；請到設定換一個登入用的埠（Spotify 後台的 Redirect URI 也要跟著改）` : '無法開啟登入用的本機接口'), { status: 409 })));
        server.listen(getConfig().spotifyLoginPort, '127.0.0.1', resolve);
      });
      const timer = setTimeout(() => {
        lastLogin = { ok: false, error: '等了五分鐘沒有完成登入', at: now() };
        closePending();
      }, 300000);
      timer.unref?.();
      pending = { server, timer };
      lastLogin = null;
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      return {
        url: ACCOUNTS + '/authorize?' + new URLSearchParams({ client_id: clientId(), response_type: 'code', redirect_uri: redirect, state, scope: SPOTIFY_SCOPES.join(' '), code_challenge_method: 'S256', code_challenge: challenge }),
        redirectUri: redirect,
      };
    },
    async logout() {
      closePending();
      access = null;
      lastLogin = null;
      await secrets.set({ spotifyRefresh: '' });
    },
    dispose: closePending,

    async search(query, { signal, limit = 10 } = {}) {
      if (!(await loggedIn())) {
        // 沒登入：這台電腦的 Spotify 開著的話，用它自己的搜尋（desktopSearch 由 core 接上，沒開時回 null）。
        const rows = this.desktopSearch ? await this.desktopSearch(String(query).slice(0, 120), { signal, limit }) : null;
        if (rows) return rows;
        throw Object.assign(Error('還沒有登入 Spotify，而且這台電腦的 Spotify 沒有開著，所以不能用歌名搜尋；請打開 Spotify 桌面版，或貼 Spotify 的歌曲、專輯或歌單連結'), { status: 409, code: 'SPOTIFY_LINK_ONLY' });
      }
      const data = await call('/search', { signal, query: { q: String(query).slice(0, 200), type: 'track', limit: String(Math.min(10, limit)), market: getConfig().territory } });
      return (data.tracks?.items || []).map(trackRow).filter(Boolean);
    },
    async track(id, { signal } = {}) {
      if (!ID.test(id || '')) throw Error('Spotify 曲目 ID 格式不正確');
      if (!(await loggedIn())) return publicTrack(id, signal);
      const row = trackRow(await call('/tracks/' + id, { signal, query: { market: getConfig().territory } }));
      if (!row) throw Error('Spotify 沒有這首歌');
      return row;
    },
    /** 使用者自己的歌單（含「已按讚的歌曲」）。 */
    async playlists({ signal } = {}) {
      const data = await call('/me/playlists', { signal, query: { limit: '50' } });
      return [
        { id: 'liked', name: '已按讚的歌曲' },
        ...(data.items || []).filter((p) => p && ID.test(p.id || '')).map((p) => ({ id: p.id, name: String(p.name || '').slice(0, 200), count: p.items?.total ?? p.tracks?.total })),
      ];
    },
    async playlistTracks(id, { signal, limit = 300 } = {}) {
      const liked = id === 'liked';
      if (!liked && !ID.test(id || '')) throw Error('Spotify 歌單 ID 格式不正確');
      if (!liked && !(await loggedIn())) return publicList('playlist', id, signal, limit);
      const tracks = [];
      for (let offset = 0; offset < limit; offset += 50) {
        const data = await call(liked ? '/me/tracks' : '/playlists/' + id + '/items', { signal, query: { limit: '50', offset: String(offset), market: getConfig().territory } });
        const items = data.items || [];
        for (const item of items) {
          const row = trackRow(item.item || item.track);
          if (row) tracks.push(row);
        }
        if (items.length < 50 || !data.next) break;
      }
      return { tracks: tracks.slice(0, limit) };
    },
    async albumTracks(id, { signal } = {}) {
      if (!ID.test(id || '')) throw Error('Spotify 專輯 ID 格式不正確');
      if (!(await loggedIn())) return publicList('album', id, signal);
      const album = await call('/albums/' + id, { signal, query: { market: getConfig().territory } });
      return { title: String(album.name || '').slice(0, 200), tracks: (album.tracks?.items || []).map((t) => trackRow({ ...t, album: { name: album.name } })).filter(Boolean) };
    },

    // ---- 遙控使用者自己的 Spotify 播放器 ----
    remote: {
      async devices({ signal } = {}) {
        const data = await call('/me/player/devices', { signal });
        return (data.devices || []).map((d) => ({ id: String(d.id || ''), name: String(d.name || '').slice(0, 100), type: String(d.type || ''), active: !!d.is_active })).filter((d) => d.id);
      },
      async play(trackId, { deviceId, signal } = {}) {
        if (!ID.test(trackId || '')) throw Error('Spotify 曲目 ID 格式不正確');
        await call('/me/player/play', { method: 'PUT', signal, body: { uris: ['spotify:track:' + trackId] }, query: deviceId ? { device_id: String(deviceId).slice(0, 100) } : undefined });
        return { ok: true };
      },
      async pause({ signal } = {}) {
        await call('/me/player/pause', { method: 'PUT', signal });
        return { ok: true };
      },
      async resume({ signal } = {}) {
        await call('/me/player/play', { method: 'PUT', signal });
        return { ok: true };
      },
      async next({ signal } = {}) {
        await call('/me/player/next', { method: 'POST', signal });
        return { ok: true };
      },
      async previous({ signal } = {}) {
        await call('/me/player/previous', { method: 'POST', signal });
        return { ok: true };
      },
    },
  };
}
