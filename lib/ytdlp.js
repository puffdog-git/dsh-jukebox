// YT Music 來源：用使用者電腦上的 yt-dlp 搜尋與下載音訊。
//
// yt-dlp 執行檔不隨插件附送。尋找順序：設定的路徑 → <DSH_HOME 或 ~/.dsh>/bin/yt-dlp → PATH。
// （Discord 賽博群友第一次 YouTube 點歌時會把 yt-dlp 下載到 ~/.dsh/bin，這裡可以直接沿用。）
// 這個模組只會連到自己組出來的 YouTube 網址（搜尋字串、影片 ID、歌單 ID），不接受任意網址。
import { execFile } from 'node:child_process';
import { readdir, rm, stat, utimes } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
export const LIST_ID = /^[A-Za-z0-9_-]{13,80}$/;
export const BV_ID = /^BV[A-Za-z0-9]{10}$/;
const MAX_BYTES = 64 * 1024 * 1024;
// bilibili 有一組 CDN 對「沒有帶 Range 的請求」一律回 HTTP 567（2026-11 實測），所以強制分段下載。
const BILI_ARGS = ['--http-chunk-size', '5M'];
const BASE_ARGS = ['--encoding', 'utf-8', '--ignore-config', '--no-warnings', '--no-progress', '--no-cache-dir', '--socket-timeout', '15'];

export function ytdlpCandidates({ configured = '', env = process.env, home = homedir(), platform = process.platform } = {}) {
  const list = [];
  if (configured) list.push(configured);
  list.push(join(env.DSH_HOME || join(home, '.dsh'), 'bin', 'yt-dlp'));
  if (platform !== 'win32') list.push(join(home, '.local/bin/yt-dlp'), '/usr/local/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp', '/usr/bin/yt-dlp');
  list.push('yt-dlp');
  return platform === 'win32' ? list.flatMap((c) => (/\.(exe|cmd|bat|com)$/i.test(c) ? [c] : [c + '.exe', c])) : list;
}

const entryRow = (row) => ({
  id: row.id,
  title: String(row.title || row.id).slice(0, 200),
  artist: String(row.uploader || row.channel || '').replace(/ - Topic$/, '').slice(0, 100),
  duration: Number.isFinite(row.duration) ? Math.round(row.duration) : 0,
});
const playable = (row) => row && VIDEO_ID.test(row.id || '') && row.live_status !== 'is_live' && !row.is_live && (!Number.isFinite(row.duration) || row.duration <= 1800);

export function createYtdlp({ getConfig = () => ({}), cacheDir, run = execFileAsync, env = process.env, home = homedir(), platform = process.platform, now = Date.now, retryDelayMs = 800 } = {}) {
  let state = { key: undefined, bin: '', version: '' };
  let probing;
  const downloads = new Map(); // videoId → promise
  const configured = () => String(getConfig()?.ytdlpPath || '').trim();

  async function probe(force = false) {
    const key = configured();
    if (!force && state.key === key && state.bin) return state;
    if (probing?.key === key) return probing.promise;
    const promise = (async () => {
      for (const candidate of ytdlpCandidates({ configured: key, env, home, platform })) {
        try {
          const { stdout } = await run(candidate, ['--version'], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
          const version = String(stdout || '').trim().split('\n')[0];
          if (version) return (state = { key, bin: candidate, version });
        } catch {}
      }
      return (state = { key, bin: '', version: '' });
    })().finally(() => {
      if (probing?.promise === promise) probing = undefined;
    });
    probing = { key, promise };
    return promise;
  }

  async function exec(args, { signal, timeoutMs = 60000 } = {}) {
    signal?.throwIfAborted();
    const found = await probe();
    if (!found.bin) throw Object.assign(Error('找不到 yt-dlp。請安裝 yt-dlp，或在「設定」填入 yt-dlp 執行檔的完整路徑。'), { code: 'NO_YTDLP' });
    try {
      const { stdout } = await run(found.bin, [...BASE_ARGS, ...args].map(String), { timeout: timeoutMs, cwd: tmpdir(), maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8', signal });
      return String(stdout || '');
    } catch (error) {
      signal?.throwIfAborted();
      // 不把 yt-dlp 的原始輸出整段丟回去，只留最後一行的重點。
      const detail = String(error?.stderr || '').trim().split('\n').pop()?.replace(/^ERROR:\s*/, '').slice(0, 160);
      // bilibili 的流量管制：短時間內請求太多會回 412，通常幾分鐘後恢復；重試只會更糟。
      if (/HTTP Error 412/.test(String(error?.stderr || ''))) throw Object.assign(Error('bilibili 暫時限制了這台電腦的請求（HTTP 412）；請過幾分鐘再試'), { rateLimited: true, status: 429 });
      throw Object.assign(Error(error?.killed ? '來源回應逾時' : '讀取失敗' + (detail ? '：' + detail : '')), { timedOut: !!error?.killed });
    }
  }

  async function flat(url, limit, signal) {
    const output = await exec(['--flat-playlist', '--playlist-end', limit, '--dump-single-json', '--skip-download', url], { signal, timeoutMs: 45000 });
    let data;
    try {
      data = JSON.parse(output);
    } catch {
      throw Error('YouTube 回傳的格式看不懂');
    }
    return { title: String(data.title || '').slice(0, 200), entries: (Array.isArray(data.entries) ? data.entries : []).filter(playable).map(entryRow) };
  }

  const infoCache = new Map();
  /** 單一影片的歌名、歌手、長度。 */
  async function info(id, { signal } = {}) {
    if (!VIDEO_ID.test(id || '')) throw Error('需要有效的 YouTube 影片 ID');
    if (infoCache.has(id)) return infoCache.get(id);
    const output = await exec(['--no-playlist', '--skip-download', '--dump-single-json', 'https://music.youtube.com/watch?v=' + id], { signal, timeoutMs: 30000 });
    let d;
    try {
      d = JSON.parse(output);
    } catch {
      throw Error('YouTube 回傳的格式看不懂');
    }
    const row = {
      id,
      title: String(d.track || d.title || id).slice(0, 200),
      artist: String((Array.isArray(d.artists) && d.artists.join(', ')) || d.artist || d.uploader || d.channel || '').replace(/ - Topic$/, '').slice(0, 100),
      duration: Number.isFinite(d.duration) ? Math.round(d.duration) : 0,
    };
    infoCache.set(id, row);
    if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value);
    return row;
  }

  async function pruneCache() {
    const limit = (Number(getConfig()?.cacheMaxMb) || 1024) * 1024 * 1024;
    const rows = [];
    for (const name of await readdir(cacheDir).catch(() => [])) {
      if (!/^(yt-[A-Za-z0-9_-]{11}|bili-BV[A-Za-z0-9]{10}|bili-au\d{1,12})\.[a-z0-9]+$/.test(name)) continue;
      const info = await stat(join(cacheDir, name)).catch(() => null);
      if (info?.isFile()) rows.push({ name, size: info.size, at: info.mtimeMs });
    }
    rows.sort((a, b) => b.at - a.at);
    let total = 0;
    for (const row of rows) {
      total += row.size;
      if (total > limit) await rm(join(cacheDir, row.name), { force: true }).catch(() => {});
    }
  }

  async function cached(id, prefix = 'yt-') {
    for (const name of await readdir(cacheDir).catch(() => [])) {
      if (name.startsWith(prefix + id + '.') &&!/\.(part|ytdl|tmp)$/i.test(name)) {
        const file = join(cacheDir, name);
        const info = await stat(file).catch(() => null);
        if (info?.isFile() && info.size) return { path: file, size: info.size };
      }
    }
    return null;
  }

  return {
    probe,
    status: () => ({ found: !!state.bin, version: state.version }),
    ready() {
      if (state.key !== configured() && !probing) void probe().catch(() => {});
      return state.key === configured() && !!state.bin;
    },
    info,
    /**
     * 搜尋：YT Music 的「歌曲」分類（官方音源，排前面）加上一般 YouTube 搜尋。
     * YT Music 的搜尋結果只有歌名，所以前幾筆會再各查一次歌手與長度。
     */
    async search(query, { signal, limit = 8 } = {}) {
      const q = String(query || '').trim().slice(0, 200);
      if (!q) throw Error('請輸入歌名或歌手');
      const [music, plain] = await Promise.allSettled([
        flat('https://music.youtube.com/search?' + new URLSearchParams({ q }) + '#songs', 4, signal),
        flat('https://www.youtube.com/results?' + new URLSearchParams({ search_query: q }), limit, signal),
      ]);
      signal?.throwIfAborted();
      if (music.status === 'rejected' && plain.status === 'rejected') throw plain.reason;
      const songs = music.status === 'fulfilled' ? music.value.entries.slice(0, 4) : [];
      const detailed = await Promise.all(songs.map((row) => info(row.id, { signal }).catch(() => row)));
      signal?.throwIfAborted();
      const out = [];
      for (const row of [...detailed, ...(plain.status === 'fulfilled' ? plain.value.entries : [])]) if (!out.some((r) => r.id === row.id)) out.push(row);
      return out.slice(0, limit);
    },
    /** 讀公開歌單的曲目。 */
    async playlist(listId, { signal, limit = 200 } = {}) {
      if (!LIST_ID.test(listId || '')) throw Error('歌單 ID 格式不正確');
      return flat('https://music.youtube.com/playlist?list=' + listId, limit, signal);
    },
    /** 下載音訊到快取資料夾，回傳檔案路徑。同一首同時只下載一次。 */
    fetch(id, { signal } = {}) {
      if (!VIDEO_ID.test(id || '')) return Promise.reject(Error('需要有效的 YouTube 影片 ID'));
      return download('yt-', id, ['--no-playlist', 'https://www.youtube.com/watch?v=' + id], 'YouTube', signal);
    },

    // ---- bilibili（公開影片的音訊；同樣經由 yt-dlp）----
    biliInfo,
    /** bilibili 搜尋。搜尋結果只有影片編號，所以每一筆都再查一次標題、UP 主與長度。 */
    async biliSearch(query, { signal, limit = 6 } = {}) {
      const q = String(query || '').trim().slice(0, 200);
      if (!q) throw Error('請輸入歌名或歌手');
      const output = await exec(['--flat-playlist', '--dump-single-json', '--skip-download', 'bilisearch' + Math.min(8, limit) + ':' + q], { signal, timeoutMs: 45000 });
      let data;
      try {
        data = JSON.parse(output);
      } catch {
        throw Error('bilibili 回傳的格式看不懂');
      }
      const refs = (Array.isArray(data.entries) ? data.entries : []).map((e) => String(e?.id || '')).filter((id) => /^\d{1,20}$/.test(id) || BV_ID.test(id)).slice(0, limit);
      let limited = null;
      // 一次只查兩筆：查得太密集會被 bilibili 的流量管制擋下（HTTP 412）。
      const rows = await gentle(refs, (ref) => biliInfo(BV_ID.test(ref) ? ref : 'av' + ref, { signal }).catch((error) => ((limited ||= error?.rateLimited ? error : null), null)));
      signal?.throwIfAborted();
      // 每一筆都被流量管制擋下時，要說明原因，不要回「沒有結果」。
      if (limited && !rows.some(Boolean)) throw limited;
      return rows.filter((r) => r && (!r.duration || r.duration <= 1800)).filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i);
    },
    /** 讀 bilibili 的合集、系列或收藏夾（最多 30 支）。清單裡只有影片編號，所以逐筆再查標題（一次兩筆）。 */
    async biliList(url, { signal, limit = 30 } = {}) {
      if (!/^https:\/\/(www|space)\.bilibili\.com\/[A-Za-z0-9/?=&_-]{3,120}$/.test(url || '')) throw Error('bilibili 清單網址格式不正確');
      const output = await exec(['--flat-playlist', '--playlist-end', limit, '--dump-single-json', '--skip-download', url], { signal, timeoutMs: 45000 });
      let data;
      try {
        data = JSON.parse(output);
      } catch {
        throw Error('bilibili 回傳的格式看不懂');
      }
      const ids = (Array.isArray(data.entries) ? data.entries : []).map((e) => String(e?.id || '').slice(0, 12)).filter((id, i, all) => BV_ID.test(id) && all.indexOf(id) === i).slice(0, limit);
      // 查不到標題的那一筆先用編號當標題，仍然可以播。被流量管制後就不再查剩下的。
      let limited = false;
      const entries = await gentle(ids, (id) => {
        signal?.throwIfAborted();
        const plain = { id, title: id, artist: '', duration: 0 };
        return limited ? plain : biliInfo(id, { signal }).catch((error) => ((limited ||= !!error?.rateLimited), plain));
      });
      signal?.throwIfAborted();
      return { title: String(data.title || '').slice(0, 200), entries };
    },
    biliFetch(id, { signal } = {}) {
      // 音頻區的單曲（au…）直接交給 yt-dlp 的音頻區網址。
      if (/^au\d{1,12}$/.test(id || '')) return download('bili-', id, [...BILI_ARGS, 'https://www.bilibili.com/audio/' + id], 'bilibili', signal);
      if (!BV_ID.test(id || '')) return Promise.reject(Error('需要有效的 bilibili 影片編號（BV 開頭）'));
      // 多分 P 的影片只取第一段。
      return download('bili-', id, [...BILI_ARGS, '--playlist-items', '1', 'https://www.bilibili.com/video/' + id], 'bilibili', signal);
    },
  };

  /** 依序處理清單，同時最多兩個在進行。 */
  async function gentle(items, work) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: 2 }, async () => {
        while (next < items.length) {
          const i = next++;
          out[i] = await work(items[i]);
        }
      }),
    );
    return out;
  }

  /** 單一 bilibili 影片的標題、UP 主、長度。ref：BV 編號或 av 編號。 */
  async function biliInfo(ref, { signal } = {}) {
    if (!BV_ID.test(ref || '') && !/^av\d{1,20}$/.test(ref || '')) throw Error('需要有效的 bilibili 影片編號');
    if (infoCache.has(ref)) return infoCache.get(ref);
    const output = await exec(['--playlist-items', '1', '--skip-download', '--dump-single-json', 'https://www.bilibili.com/video/' + ref], { signal, timeoutMs: 30000 });
    let d;
    try {
      d = JSON.parse(output);
    } catch {
      throw Error('bilibili 回傳的格式看不懂');
    }
    if (Array.isArray(d.entries)) d = d.entries[0] || {};
    // 多分 P 時 yt-dlp 的編號會是「BV…_p1」，只留 BV 的部分。
    const id = String(d.id || '').slice(0, 12);
    if (!BV_ID.test(id)) throw Error('bilibili 沒有這支影片');
    const row = { id, title: String(d.title || id).slice(0, 200), artist: String(d.uploader || '').slice(0, 100), duration: Number.isFinite(d.duration) ? Math.round(d.duration) : 0 };
    infoCache.set(ref, row);
    infoCache.set(id, row);
    if (infoCache.size > 500) infoCache.delete(infoCache.keys().next().value);
    return row;
  }

  /** 下載音訊到快取資料夾，回傳檔案路徑。同一首同時只下載一次。 */
  async function download(prefix, id, tail, label, signal) {
    const hit = await cached(id, prefix);
    if (hit) {
      const t = new Date(now());
      await utimes(hit.path, t, t).catch(() => {});
      return hit;
    }
    const key = prefix + id;
    let job = downloads.get(key);
    if (!job) {
      // 下載不綁在單一呼叫者的取消訊號上：別人可能也在等同一首。
      job = (async () => {
        // 影音網站的 CDN 偶爾會回錯誤，重新取一次位址通常就好，所以最多試三次。
        const started = now();
        for (let attempt = 1; ; attempt++) {
          try {
            await exec(['--max-filesize', '64M', '--match-filter', '!is_live & duration <=? 1800', '-f', 'bestaudio/best', '-o', join(cacheDir, prefix + id + '.%(ext)s'), ...tail], { timeoutMs: 100000 });
            break;
          } catch (error) {
            if (error?.rateLimited) throw error;
            if (attempt >= 3 || error?.timedOut || error?.code === 'NO_YTDLP' || now() - started > 40000) throw Error(label + ' ' + error.message);
            await new Promise((r) => setTimeout(r, retryDelayMs));
          }
        }
        const file = await cached(id, prefix);
        if (!file) throw Error(label + ' 沒有產生可播放的音訊（可能是直播、超過 30 分鐘、需要登入或沒有可用格式）');
        if (file.size > MAX_BYTES) {
          await rm(file.path, { force: true });
          throw Error('這首歌的音訊超過 64 MiB');
        }
        void pruneCache().catch(() => {});
        return file;
      })().finally(() => downloads.delete(key));
      downloads.set(key, job);
    }
    if (!signal) return job;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : Error('已取消'));
      signal.addEventListener('abort', abort, { once: true });
      job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
