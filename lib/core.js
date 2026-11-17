// 點唱機的核心：把各個來源接在一起。
//
// 能直接播放聲音的來源只有兩個：本地音樂庫（檔案）與 YT Music（yt-dlp）。
// Spotify、KKBOX、Apple Music 的音訊受保護，這裡只用它們的歌曲資料，
// 聲音走「對應播放」（找本地音樂庫或 YouTube 上的同一首），或請官方播放器自己播（遙控）。
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { CAPTURE_APPS, CAPTURE_LABELS, createCapture } from './capture.js';
import { createLibrary, AUDIO_TYPES } from './library.js';
import { pickBest } from './match.js';
import { createPlayers } from './players.js';
import { createRemote } from './remote.js';
import { createSecrets } from './secrets.js';
import { BILI_LIST, BILI_TRACK, createBilibili, listUrl, parseBilibiliLink, trackUrl } from './sources/bilibili.js';
import { createApple } from './sources/apple.js';
import { createKkbox } from './sources/kkbox.js';
import { createSpotify } from './sources/spotify.js';
import { createStore, readJson, writeJson, SOURCE_IDS, SOURCE_NAMES } from './store.js';
import { createYtdlp, LIST_ID, VIDEO_ID } from './ytdlp.js';

export const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const CATALOG = ['spotify', 'kkbox', 'apple']; // 有歌曲資料 API、聲音要靠對應播放的來源
const fail = (message, status = 400, code) => Object.assign(Error(message), { status, code });

export function parseYoutubeLink(text) {
  let url;
  try {
    url = new URL(String(text || '').trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') return VIDEO_ID.test(url.pathname.slice(1)) ? { kind: 'track', id: url.pathname.slice(1) } : null;
  if (!['youtube.com', 'music.youtube.com', 'm.youtube.com'].includes(host)) return null;
  const v = url.searchParams.get('v');
  const list = url.searchParams.get('list');
  if (url.pathname === '/watch' && VIDEO_ID.test(v || '')) return { kind: 'track', id: v };
  if (url.pathname === '/playlist' && LIST_ID.test(list || '')) return { kind: 'playlist', id: list };
  return null;
}

/** 用 FFmpeg 把太大的檔案轉成 Opus，讓它放得進 64 MiB。 */
function transcode(bin, file, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-v', 'error', '-nostdin', '-i', file, '-vn', '-map', '0:a:0', '-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], signal });
    const chunks = [];
    let total = 0;
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_AUDIO_BYTES) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', (error) => reject(error?.name === 'AbortError' ? error : fail('找不到 FFmpeg，無法轉檔', 500)));
    child.on('close', (code) => (code === 0 && total && total <= MAX_AUDIO_BYTES ? resolve(Buffer.concat(chunks)) : reject(fail(total > MAX_AUDIO_BYTES ? '這首歌轉檔後仍超過 64 MiB' : 'FFmpeg 轉檔失敗', 500))));
  });
}

export async function createCore({ dir, logger, env = process.env, overrides = {} } = {}) {
  const store = overrides.store || (await createStore(dir ? { dir } : {}));
  const config = () => store.config();
  const secrets = overrides.secrets || createSecrets({ file: join(store.dir, 'secrets.json') });
  const library = overrides.library || createLibrary({ file: join(store.dir, 'library.json'), getFolders: () => config().libraryFolders });
  const ytdlp = overrides.ytdlp || createYtdlp({ getConfig: config, cacheDir: store.cacheDir });
  const remote = overrides.remote || createRemote();
  const capture = overrides.capture || createCapture({ dataDir: store.dir, getConfig: config, logger });
  const sources = {
    spotify: overrides.spotify || createSpotify({ getConfig: config, secrets }),
    kkbox: overrides.kkbox || createKkbox({ getConfig: config, secrets }),
    apple: overrides.apple || createApple({ getConfig: config, secrets }),
    bilibili: overrides.bilibili || createBilibili({ deviceFile: join(store.dir, 'bilibili-device.json') }),
  };
  const players = overrides.players || createPlayers({ capture, sources, remote, getConfig: config });
  const matchFile = join(store.dir, 'matches.json');
  const matches = new Map(Object.entries(await readJson(matchFile, {})));
  let matchWrites = Promise.resolve();
  // 各來源目前能不能用（給同步的 available() 用），每次 status() 時更新。
  const usable = { local: false, ytmusic: false, bilibili: false, spotify: false, kkbox: false, apple: false };

  const enabled = (source) => config().enabledSources.includes(source);
  const need = (source) => {
    if (!SOURCE_IDS.includes(source)) throw fail('沒有這個來源');
    if (!enabled(source)) throw fail(SOURCE_NAMES[source] + ' 沒有啟用；請到「來源帳號」開啟', 409);
  };

  // Spotify 沒登入時的找歌：這台電腦的 Spotify 開著就用它自己的搜尋（沒開回 null，讓來源回報原因）。
  sources.spotify.desktopSearch = async (query, { limit = 10 } = {}) => {
    if (!capture.supported || !capture.spotifySearch || !(await capture.running().catch(() => ({}))).spotify) return null;
    const result = await capture.spotifySearch(query, limit);
    if (!result?.ok) throw fail({ 'not-running': 'Spotify 沒有在執行', 'no-search-page': 'Spotify 桌面版沒有在時間內開出搜尋結果（它縮小閒置時反應會比較慢）；請再試一次' }[result?.error] || '讀不到 Spotify 的搜尋結果（它的介面可能改版了）', 409);
    return result.tracks.map((t) => ({ id: t.id, title: String(t.title).slice(0, 200), artist: String(t.artist || '').slice(0, 200), album: '', duration: 0, url: 'https://open.spotify.com/track/' + t.id }));
  };

  async function refreshUsable() {
    void ytdlp.probe().catch(() => {});
    usable.local = enabled('local') && (await library.status()).count > 0;
    usable.ytmusic = enabled('ytmusic') && ytdlp.ready();
    usable.bilibili = enabled('bilibili') && ytdlp.ready();
    // Spotify 沒登入也能用貼連結的方式點歌（歌曲資料讀公開頁面），所以不要求登入。
    for (const id of CATALOG) usable[id] = enabled(id) && ytdlp.ready() && (id === 'spotify' || (await sources[id].configured().catch(() => false)));
    return usable;
  }

  // bilibili 的查詢先走網頁接口（一次請求拿完）。被限流時直接回報、不換路再打；
  // 其他失敗（接口改版、項目不公開等）才退回用 yt-dlp 讀，yt-dlp 也不行就回報原本的錯誤。
  async function viaBilibili(direct, fallback) {
    try {
      return await direct();
    } catch (error) {
      if (error?.rateLimited || error?.name === 'AbortError') throw error;
      if (!usable.bilibili) throw error;
      try {
        return await fallback();
      } catch (second) {
        throw second?.rateLimited ? second : error;
      }
    }
  }

  async function search(source, query, { signal, limit = 10 } = {}) {
    need(source);
    const q = String(query || '').trim().slice(0, 200);
    let rows;
    if (source === 'local') rows = (await library.search(q, { limit })).tracks;
    else if (!q) throw fail('請輸入歌名或歌手');
    else if (source === 'ytmusic') rows = await ytdlp.search(q, { signal, limit });
    else if (source === 'bilibili') rows = await viaBilibili(() => sources.bilibili.search(q, { signal, limit }), () => ytdlp.biliSearch(q, { signal, limit: Math.min(6, limit) }));
    else {
      // 搜尋內容是這個服務自己的連結：直接讀那首歌（或那張專輯、那個歌單的曲目），不用搜尋。
      const link = parseLink(q);
      if (link && link.source === source && link.kind === 'track') rows = [await sources[source].track(link.id, { signal })];
      else if (link && link.source === source && (link.kind === 'album' || link.kind === 'playlist')) rows = (await collection(source, link.kind, link.id, { signal })).tracks;
      else rows = await sources[source].search(q, { signal, limit });
    }
    return rows.slice(0, limit).map((r) => ({ source, id: r.id, title: r.title, artist: r.artist || '', album: r.album || '', duration: r.duration || 0, url: r.url || '' }));
  }

  async function meta(source, id, { signal } = {}) {
    need(source);
    if (source === 'local') {
      const t = await library.get(id);
      if (!t) throw fail('音樂庫裡沒有這首歌', 404);
      return { source, ...t };
    }
    if (source === 'ytmusic') {
      if (!VIDEO_ID.test(id || '')) throw fail('YouTube 影片 ID 格式不正確');
      return { source, id, title: '', artist: '', duration: 0, url: 'https://music.youtube.com/watch?v=' + id };
    }
    if (source === 'bilibili') {
      if (!BILI_TRACK.test(id || '')) throw fail('bilibili 編號格式不正確');
      // 音頻區的單曲（au…）查音頻區；影片（BV…）交給 yt-dlp。
      const row = id.startsWith('au') ? await sources.bilibili.audio(id, { signal }) : await viaBilibili(() => sources.bilibili.video(id, { signal }), () => ytdlp.biliInfo(id, { signal }));
      return { source, ...row, url: trackUrl(id) };
    }
    if (!CATALOG.includes(source)) throw fail('這個來源沒有歌曲資料接口');
    return { source, ...(await sources[source].track(id, { signal })) };
  }

  /**
   * 對應播放：找出和 target（歌名、歌手、長度）同一首、而且能直接播放的版本。
   * 找的地方與先後照設定的「播放方式優先順序」：youtube（到 YouTube 找）、local（在本地音樂庫找）。
   */
  async function matchTarget(target, { signal } = {}) {
    if (!String(target?.title || '').trim()) throw fail('需要歌名才能找對應的版本');
    const order = config().playPriority.filter((m) => (m === 'youtube' && enabled('ytmusic')) || (m === 'local' && enabled('local')));
    if (!order.length) throw fail('對應播放沒有可用的方式；請在「播放方式的優先順序」保留 YouTube 或本地音樂庫，並啟用對應的來源', 409);
    const query = [target.artist || (target.artists || []).join(' '), target.title].filter(Boolean).join(' ');
    for (const method of order) {
      if (method === 'local') {
        // 本地音樂庫比對得嚴一點：寧可去別處找，也不要播錯歌。
        const hit = pickBest(await library.candidates(), target, 0.78);
        if (hit) return { kind: 'local', id: hit.candidate.id, title: hit.candidate.title, artist: hit.candidate.artist, score: Math.round(hit.score * 100) / 100 };
      } else {
        const hit = pickBest(await ytdlp.search(query, { signal, limit: 8 }), target, 0.55);
        if (hit) return { kind: 'yt', id: hit.candidate.id, title: hit.candidate.title, artist: hit.candidate.artist, score: Math.round(hit.score * 100) / 100 };
      }
    }
    throw fail('找不到夠像的版本：' + query.slice(0, 80), 404, 'NO_MATCH');
  }

  /** 某個來源的一首歌，實際要播哪個檔案或哪支 YouTube 影片。 */
  async function resolve(source, id, { signal, refresh = false } = {}) {
    need(source);
    if (source === 'local') return { kind: 'local', id };
    if (source === 'ytmusic') {
      if (!VIDEO_ID.test(id || '')) throw fail('YouTube 影片 ID 格式不正確');
      return { kind: 'yt', id };
    }
    if (source === 'bilibili') {
      if (!BILI_TRACK.test(id || '')) throw fail('bilibili 編號格式不正確');
      return { kind: 'bili', id };
    }
    const key = source + ':' + id;
    const saved = matches.get(key);
    if (saved && !refresh && (saved.kind === 'yt' || (await library.get(saved.id)))) return saved;
    const target = await meta(source, id, { signal });
    const found = { ...(await matchTarget(target, { signal })), for: { title: target.title, artist: target.artist } };
    matches.set(key, found);
    if (matches.size > 5000) matches.delete(matches.keys().next().value);
    matchWrites = matchWrites.catch(() => {}).then(() => writeJson(matchFile, Object.fromEntries(matches)));
    return found;
  }

  async function fileOf(resolved, { signal } = {}) {
    if (resolved.kind === 'local') return library.pathOf(resolved.id);
    const file = resolved.kind === 'bili' ? await ytdlp.biliFetch(resolved.id, { signal }) : await ytdlp.fetch(resolved.id, { signal });
    return { ...file, type: AUDIO_TYPES[extname(file.path).toLowerCase()] || 'application/octet-stream' };
  }

  /** 給設定頁的播放器：回傳可以串流的檔案。 */
  async function audioFile(source, id, options) {
    const resolved = await resolve(source, id, options);
    return { ...(await fileOf(resolved, options)), resolved };
  }

  /** 給 Discord：回傳整段音訊（最多 64 MiB；太大的本地檔案用 FFmpeg 轉成 Opus）。 */
  async function audioBytes(source, id, { signal } = {}) {
    const file = await fileOf(await resolve(source, id, { signal }), { signal });
    if (file.size <= MAX_AUDIO_BYTES) return readFile(file.path, { signal });
    const bin = config().ffmpegPath || env.FFMPEG_BIN || 'ffmpeg';
    return transcode(bin, file.path, signal);
  }

  /** 認出貼上的連結是哪個服務的什麼東西。 */
  function parseLink(text) {
    for (const id of ['spotify', 'kkbox', 'apple']) {
      const hit = sources[id].parseLink(text);
      if (hit) return { source: id, ...hit };
    }
    const bili = parseBilibiliLink(text);
    if (bili) return { source: 'bilibili', ...bili };
    const yt = parseYoutubeLink(text);
    return yt ? { source: 'ytmusic', ...yt } : null;
  }

  /** 同 parseLink，但會先把 bilibili 的短網址（b23.tv）解析成完整連結。 */
  async function resolveLink(text, { signal } = {}) {
    const hit = parseLink(text);
    if (hit?.source === 'bilibili' && hit.kind === 'short') return { source: 'bilibili', ...(await sources.bilibili.resolveShort(hit.id, { signal })) };
    return hit;
  }

  async function playlists(source, { signal } = {}) {
    need(source);
    // bilibili：音頻區首頁的熱門歌單（公開的，不是個人收藏）。
    if (source === 'bilibili') return sources.bilibili.hitMenus({ signal });
    if (source !== 'spotify') throw fail('只有 Spotify 能列出你自己的歌單；其他服務請貼歌單連結');
    return sources.spotify.playlists({ signal });
  }

  /** 讀歌單或專輯的曲目。kind：playlist｜album。 */
  async function collection(source, kind, id, { signal, country } = {}) {
    need(source);
    let result;
    if (source === 'ytmusic') {
      if (kind !== 'playlist') throw fail('YT Music 只支援歌單連結');
      const list = await ytdlp.playlist(id, { signal });
      result = { title: list.title, tracks: list.entries };
    } else if (source === 'bilibili') {
      if (!BILI_LIST.test(id || '')) throw fail('bilibili 清單編號格式不正確');
      if (id.startsWith('am')) result = await sources.bilibili.menuSongs(id, { signal });
      else {
        const list = await viaBilibili(() => sources.bilibili.list(id, { signal }), () => ytdlp.biliList(listUrl(id), { signal }));
        result = { title: list.title, tracks: list.entries, note: list.skipped ? '略過了 ' + list.skipped + ' 支超過 30 分鐘的影片（太長的播不了）。' : '' };
      }
    } else if (CATALOG.includes(source)) {
      const fn = kind === 'album' ? sources[source].albumTracks : sources[source].playlistTracks;
      if (!fn) throw fail(SOURCE_NAMES[source] + ' 不支援這種連結');
      result = await fn(id, { signal, country });
    } else throw fail(SOURCE_NAMES[source] + ' 讀不到歌單內容');
    return { source, kind, id, title: result.title || '', note: result.note || '', tracks: result.tracks.map((r) => ({ source, id: r.id, title: r.title, artist: r.artist || '', album: r.album || '', duration: r.duration || 0, url: r.url || '' })) };
  }

  /** 在官方播放器打開一首歌（聲音在這台電腦，不進 Discord）。 */
  async function openInApp(source, { id, url }) {
    need(source);
    if (!config().remoteEnabled) throw fail('「在官方播放器打開」已在設定裡關閉', 409);
    let target = url;
    if (source === 'spotify') target = 'spotify:track:' + id;
    else if (source === 'ytmusic') target = 'https://music.youtube.com/watch?v=' + id;
    else if (source === 'bilibili') target = trackUrl(id);
    else if (source === 'kkbox' && !target) target = (await sources.kkbox.track(id)).url;
    else if (source === 'apple' && !target) target = (await sources.apple.track(id)).url;
    // 網址帶的追蹤參數不需要，也讓白名單好檢查。
    if (source === 'kkbox' || source === 'apple') target = String(target || '').split('#')[0];
    return remote.open(source, target);
  }

  // ---- 官方播放器：即時轉送（給 Discord 的即時來源用）----
  // 曲目 ID：
  //   app:<播放器>              轉送那個播放器現在播出來的聲音，直到被停止（不控制播放器）
  //   live:<播放器>:<曲目編號>   先叫播放器播這首歌再轉送；歌曲長度到了就自己結束，並把播放器暫停
  const OFFICIAL = ['spotify', 'kkbox', 'apple']; // 能可靠地「指定播哪一首」的播放器（三個都實測或有官方接口）

  /** 這個來源現在能不能走「官方播放器」這條路。回傳空字串表示可以，否則是原因。 */
  async function officialBlocked(source) {
    if (!OFFICIAL.includes(source)) return SOURCE_NAMES[source] + ' 不能直接指定播哪一首';
    if (!capture.supported) return '只支援 Windows';
    if (!config().captureEnabled) return '沒有開啟「擷取官方播放器的聲音」';
    if (!config().captureControl) return '沒有開啟「讓 Discord 的點歌可以控制我的播放器」';
    // 即時轉送擷取的是這台電腦的聲音，所以播放器一定要在這台電腦執行（Spotify 也一樣）。
    if (!(await capture.running().catch(() => ({})))[source]) return SOURCE_NAMES[source] + ' 沒有在執行';
    return '';
  }

  /**
   * 照優先順序決定某個來源要用哪種方式播放：official（官方播放器並即時轉送）或 file（下載得到的音訊）。
   * 直接可播的來源（本地音樂庫、YT Music、bilibili）一律是 file。
   */
  async function playMode(source) {
    if (!CATALOG.includes(source)) return 'file';
    for (const method of config().playPriority) {
      if (method === 'official') {
        if (!(await officialBlocked(source))) return 'official';
      } else if ((method === 'youtube' && enabled('ytmusic') && ytdlp.ready()) || (method === 'local' && enabled('local'))) return 'file';
    }
    return 'none';
  }

  /** 給 Discord 的搜尋：曲目編號帶著播放方式（live:… 表示用官方播放器）。 */
  async function searchForDiscord(source, query, { signal } = {}) {
    const rows = await search(source, query, { signal, limit: 10 });
    const mode = await playMode(source);
    if (mode === 'none') throw fail(SOURCE_NAMES[source] + ' 目前沒有可用的播放方式；請到點唱機的「播放方式的優先順序」確認', 409);
    return rows.map((r) => (mode === 'official' ? { id: 'live:' + r.id, title: r.title + '（用你的 ' + SOURCE_NAMES[source] + ' 播放並即時轉送）', artist: r.artist } : { id: r.id, title: r.title, artist: r.artist }));
  }

  async function liveSearch(query) {
    if (!config().captureEnabled || !capture.supported) throw fail('「擷取官方播放器的聲音」沒有開啟', 409);
    const running = await capture.running();
    const q = String(query || '').trim().toLowerCase();
    return Object.keys(CAPTURE_APPS)
      .filter((app) => running[app])
      .map((app) => ({ id: 'app:' + app, title: CAPTURE_LABELS[app] + ' 現在播放的聲音（即時轉送）', artist: '這台電腦的 ' + CAPTURE_LABELS[app] }));
  }

  /** 先叫官方播放器播某首歌，再把它的聲音即時轉送出去。 */
  async function liveOpenTrack(source, id, { signal } = {}) {
    need(source);
    const blocked = await officialBlocked(source);
    if (blocked) throw fail('不能用 ' + SOURCE_NAMES[source] + ' 官方播放器播放：' + blocked, 409);
    const track = await players.find(source, { id, signal });
    // 先開始擷取再叫播放器播放，才不會漏掉開頭。秒數上限只是保險，實際的結束時間在下面依「真的開始播」的時刻設定。
    const length = track.duration || 600;
    const session = await capture.open(source, { signal, quiet: config().captureQuiet, seconds: length + 40 });
    // 叫播放器開始播可能要好幾秒（Apple Music 要操作視窗，實測約 4 秒）。這段時間擷取到的是開始之前的聲音
    // （通常是靜音），先丟掉，不然送到 Discord 的開頭會多一段空白，之後也會一直慢那幾秒。
    const discard = () => {};
    session.stream.on('data', discard);
    try {
      await players.start(source, track, { signal });
    } catch (error) {
      await session.stop();
      throw error;
    } finally {
      session.stream.off('data', discard);
      session.stream.pause();
    }
    // 歌曲長度到了就結束（多留兩秒尾音），不要轉送到下一首。
    const ending = setTimeout(() => void session.stop(), (length + 2) * 1000);
    ending.unref?.();
    void session.done.then(() => clearTimeout(ending));
    // 轉送結束（播完、被停止或出錯）後把播放器暫停：是我們叫它播的，就由我們收尾。
    void session.done.then(() => players.control(source, 'pause')).catch(() => {});
    return session;
  }

  async function liveOpen(id, { signal } = {}) {
    let m;
    if ((m = /^app:(spotify|kkbox|apple)$/.exec(String(id || '')))) return capture.open(m[1], { signal, quiet: config().captureQuiet });
    if ((m = /^sp:([A-Za-z0-9]{22})$/.exec(String(id || '')))) return liveOpenTrack('spotify', m[1], { signal });
    throw fail('即時來源的曲目 ID 格式不正確');
  }

  async function status() {
    await refreshUsable();
    const [lib, secret, spotify, kkbox, apple] = [await library.status(), await secrets.status(), await sources.spotify.status(), await sources.kkbox.status(), await sources.apple.status()];
    return {
      ok: true,
      config: config(),
      dataDir: store.dir,
      library: lib,
      ytdlp: ytdlp.status(),
      secrets: { persistent: secret.persistent, error: secret.error },
      sources: {
        local: { enabled: enabled('local'), usable: usable.local, playable: 'direct' },
        ytmusic: { enabled: enabled('ytmusic'), usable: usable.ytmusic, playable: 'direct' },
        bilibili: { enabled: enabled('bilibili'), usable: usable.bilibili, playable: 'direct', ...(sources.bilibili.stats?.() || {}) },
        spotify: { enabled: enabled('spotify'), usable: usable.spotify, playable: 'match', ...spotify },
        kkbox: { enabled: enabled('kkbox'), usable: usable.kkbox, playable: 'match', ...kkbox },
        apple: { enabled: enabled('apple'), usable: usable.apple, playable: 'match', ...apple },
      },
      matches: matches.size,
      capture: { ...capture.status(), apps: CAPTURE_LABELS, defaults: CAPTURE_APPS },
    };
  }

  await library.load();
  void capture.recover().catch(() => {});
  await refreshUsable().catch(() => {});
  // yt-dlp 的偵測是非同步的；偵測完再更新一次。
  ytdlp
    .probe()
    .then(() => refreshUsable())
    .catch(() => {});

  return {
    store,
    secrets,
    library,
    ytdlp,
    sources,
    remote,
    capture,
    players,
    liveSearch,
    liveOpen,
    liveOpenTrack,
    searchForDiscord,
    playMode,
    officialBlocked,
    usable: () => usable,
    refreshUsable,
    enabled,
    search,
    meta,
    matchTarget,
    resolve,
    audioFile,
    audioBytes,
    fileOf,
    parseLink,
    resolveLink,
    playlists,
    collection,
    openInApp,
    status,
    async forgetMatch(source, id) {
      const had = matches.delete(source + ':' + id);
      if (had) matchWrites = matchWrites.catch(() => {}).then(() => writeJson(matchFile, Object.fromEntries(matches)));
      return had;
    },
    async dispose() {
      library.cancel();
      await capture.stopAll().catch(() => {});
      sources.spotify.dispose?.();
      await store.flush();
      await matchWrites.catch(() => {});
      logger?.debug?.('dsh-jukebox 已停止');
    },
  };
}
