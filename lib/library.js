// 本地音樂庫：掃描使用者指定的資料夾、讀檔案裡的歌名／歌手／專輯／長度、提供搜尋。
// 只讀檔案，不改動、不搬移、不刪除音樂檔。
import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, isAbsolute, sep } from 'node:path';
import { norm } from './match.js';
import { readJson, writeJson } from './store.js';

export const AUDIO_TYPES = Object.freeze({
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.ape': 'audio/x-ape',
});
const MAX_TRACKS = 50000;
const MAX_DEPTH = 12;

const idOf = (path) => createHash('sha1').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 20);
const inside = (root, file) => {
  const rel = relative(root, file);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};

async function defaultParse(file) {
  const { parseFile } = await import('music-metadata');
  const meta = await parseFile(file, { duration: false, skipCovers: true });
  const c = meta.common || {};
  return {
    title: c.title || '',
    artist: c.artist || (Array.isArray(c.artists) ? c.artists.join(', ') : '') || c.albumartist || '',
    album: c.album || '',
    trackNo: c.track?.no || 0,
    duration: Number.isFinite(meta.format?.duration) ? Math.round(meta.format.duration) : 0,
  };
}

/** 檔名當後備：「歌手 - 歌名」或「01. 歌名」。 */
export function fromFileName(file) {
  const stem = basename(file, extname(file)).replace(/^\d{1,3}[\s._-]+/, '').trim();
  const parts = stem.split(/\s[-–—]\s/);
  return parts.length >= 2 ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() } : { artist: '', title: stem };
}

export function createLibrary({ file, getFolders, parse = defaultParse, now = Date.now } = {}) {
  let tracks = new Map(); // id → track
  let scannedAt = 0;
  let loaded;
  let job = null; // { promise, progress, controller }
  let last = null;

  const load = () =>
    (loaded ||= (async () => {
      const stored = await readJson(file, { tracks: [] });
      scannedAt = Number(stored.scannedAt) || 0;
      for (const t of Array.isArray(stored.tracks) ? stored.tracks : []) if (t?.id && t.path) tracks.set(t.id, t);
    })());

  async function walk(dir, depth, out, signal) {
    if (depth > MAX_DEPTH || out.length >= MAX_TRACKS) return;
    signal.throwIfAborted();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_TRACKS) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1, out, signal);
      else if (entry.isFile() && AUDIO_TYPES[extname(entry.name).toLowerCase()]) out.push(full);
    }
  }

  async function run(progress, signal) {
    await load();
    const folders = getFolders();
    const files = [];
    const missing = [];
    for (const folder of folders) {
      try {
        const info = await lstat(folder);
        if (!info.isDirectory()) throw Error('不是資料夾');
        await walk(folder, 0, files, signal);
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        missing.push(folder);
      }
    }
    progress.total = files.length;
    const next = new Map();
    let index = 0;
    const worker = async () => {
      while (index < files.length) {
        signal.throwIfAborted();
        const path = files[index++];
        try {
          const info = await lstat(path);
          const id = idOf(path);
          const old = tracks.get(id);
          if (old && old.size === info.size && old.mtime === Math.round(info.mtimeMs)) next.set(id, old);
          else {
            let meta = {};
            try {
              meta = await parse(path);
            } catch {
              progress.unreadable += 1;
            }
            const fallback = fromFileName(path);
            next.set(id, {
              id,
              path,
              size: info.size,
              mtime: Math.round(info.mtimeMs),
              title: String(meta.title || fallback.title).slice(0, 200),
              artist: String(meta.artist || fallback.artist).slice(0, 200),
              album: String(meta.album || '').slice(0, 200),
              trackNo: Number(meta.trackNo) || 0,
              duration: Number(meta.duration) || 0,
            });
            progress.changed += 1;
          }
        } catch {
          progress.unreadable += 1;
        }
        progress.done += 1;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    tracks = next;
    scannedAt = now();
    await writeJson(file, { scannedAt, tracks: [...tracks.values()] });
    return { ok: true, count: tracks.size, changed: progress.changed, unreadable: progress.unreadable, missing, truncated: files.length >= MAX_TRACKS };
  }

  const haystack = (t) => norm([t.title, t.artist, t.album, basename(t.path)].join(' '));
  const view = (t) => ({ id: t.id, title: t.title, artist: t.artist, album: t.album, duration: t.duration, trackNo: t.trackNo, type: extname(t.path).slice(1).toLowerCase(), size: t.size });

  return {
    load,
    /** 開始掃描（已經在掃就回同一個工作）。 */
    scan() {
      if (job) return job.promise;
      const controller = new AbortController();
      const progress = { total: 0, done: 0, changed: 0, unreadable: 0, startedAt: now() };
      const promise = run(progress, controller.signal)
        .catch((error) => ({ ok: false, error: controller.signal.aborted ? '已取消' : String(error?.message || error).slice(0, 200) }))
        .then((result) => {
          last = { ...result, finishedAt: now() };
          job = null;
          return last;
        });
      job = { promise, progress, controller };
      return promise;
    },
    cancel() {
      job?.controller.abort();
      return !!job;
    },
    async status() {
      await load();
      return { count: tracks.size, scannedAt, scanning: job ? { ...job.progress } : null, last };
    },
    /** 搜尋；每個關鍵字都要出現在歌名、歌手、專輯或檔名裡。空字串＝全部。 */
    async search(query, { limit = 50, offset = 0 } = {}) {
      await load();
      const words = norm(query).split(' ').filter(Boolean);
      let rows = [...tracks.values()];
      if (words.length) {
        rows = rows
          .map((t) => ({ t, text: haystack(t), title: norm(t.title) }))
          .filter((r) => words.every((w) => r.text.includes(w)))
          .sort((a, b) => Number(words.every((w) => b.title.includes(w))) - Number(words.every((w) => a.title.includes(w))) || a.title.length - b.title.length)
          .map((r) => r.t);
      } else {
        rows.sort((a, b) => a.artist.localeCompare(b.artist, 'zh-Hant') || a.album.localeCompare(b.album, 'zh-Hant') || a.trackNo - b.trackNo || a.title.localeCompare(b.title, 'zh-Hant'));
      }
      return { total: rows.length, tracks: rows.slice(offset, offset + limit).map(view) };
    },
    /** 給「對應播放」用：所有曲目的精簡清單。 */
    async candidates() {
      await load();
      return [...tracks.values()].map((t) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration }));
    },
    async get(id) {
      await load();
      const t = tracks.get(String(id || ''));
      return t ? view(t) : null;
    },
    /** 曲目的實際檔案路徑。每次都重新確認它還在目前設定的資料夾裡。 */
    async pathOf(id) {
      await load();
      const t = tracks.get(String(id || ''));
      if (!t) throw Object.assign(Error('音樂庫裡沒有這首歌；可能需要重新掃描'), { status: 404 });
      let real;
      try {
        real = await realpath(t.path);
      } catch {
        throw Object.assign(Error('檔案不見了；請重新掃描音樂庫'), { status: 404 });
      }
      for (const folder of getFolders()) {
        try {
          const root = await realpath(folder);
          if (inside(root, real) || real.startsWith(root.endsWith(sep) ? root : root + sep)) return { path: real, type: AUDIO_TYPES[extname(real).toLowerCase()] || 'application/octet-stream', size: t.size };
        } catch {}
      }
      throw Object.assign(Error('這個檔案不在目前設定的音樂資料夾裡'), { status: 403 });
    },
  };
}
