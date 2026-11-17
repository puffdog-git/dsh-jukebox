// 即時擷取官方播放器的聲音（只有 Windows）。
//
// 只擷取使用者在設定裡列出的播放器程式（預設：Spotify、KKBOX、Apple Music），
// 不擷取整台電腦的聲音，也不擷取麥克風。這不是解密：擷取的是播放器已經播出來的聲音。
// 擷取工具是 lib/capture/ProcessLoopback.cs，第一次使用時用 Windows 內建的 C# 編譯器編譯，
// 放在 <資料夾>/bin/。輸出：48000 Hz／雙聲道／16 位元 PCM。
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'capture', 'ProcessLoopback.cs');
import { cleanEnv } from './remote.js';

const SESSIONS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'capture', 'media-sessions.ps1');
const APPLE_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'capture', 'apple-music-play.ps1');
const APPLE_CONTROL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'capture', 'apple-music-control.ps1');
const SPOTIFY_SEARCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'capture', 'spotify-search.ps1');
const SPOTIFY_PLAY_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'capture', 'spotify-play.ps1');
const MEDIA_KEYS = ['play_pause', 'next', 'previous', 'stop'];
const SESSION_ACTIONS = ['list', 'pause', 'play', 'toggle', 'next', 'previous', 'stop'];
export const CAPTURE_APPS = Object.freeze({ spotify: 'Spotify', kkbox: 'KKBOX', apple: 'AppleMusic' });
// 實際播出聲音的程序和主程式不同名的播放器（2026-11 實測：Apple Music 的聲音由 AMPLibraryAgent 播出，
// 而且它不是 AppleMusic.exe 的子程序）。偵測「有沒有開」用主程式，擷取與調小音量用這裡的名稱。
export const CAPTURE_AUDIO = Object.freeze({ apple: 'AMPLibraryAgent' });
export const CAPTURE_LABELS = Object.freeze({ spotify: 'Spotify', kkbox: 'KKBOX', apple: 'Apple Music' });
export const validProcessName = (name) => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(String(name || ''));
const fail = (message, status = 409, code) => Object.assign(Error(message), { status, code });

/** 把擷取工具印在標準錯誤的訊息換成給人看的說明。 */
export function captureError(text, label) {
  const line = String(text || '').trim().split('\n').pop() || '';
  if (/NOT_RUNNING/.test(line)) return label + ' 沒有在執行；請先打開它';
  if (/EXITED/.test(line)) return label + ' 已經關閉';
  if (/0x(80070057|88890008|80004002|80040154)/i.test(line) || /activate/.test(line)) return '這個版本的 Windows 不支援只擷取單一程式的聲音（需要 Windows 10 2004 以上）';
  return '擷取工具沒有啟動成功' + (line ? '（' + line.slice(0, 60) + '）' : '');
}

export function createCapture({ dataDir, getConfig, platform = process.platform, env = process.env, run = execFileAsync, spawnImpl = spawn, logger } = {}) {
  const supported = platform === 'win32';
  const marker = join(dataDir, 'capture-active.json');
  let building;
  let active = null; // { app, child, stop }

  const processName = (app) => {
    const custom = getConfig().captureProcessNames?.[app];
    return validProcessName(custom) ? custom : CAPTURE_APPS[app];
  };
  // 擷取與調小音量要對準「真正播出聲音的程序」。使用者自己改過名稱就用他的。
  const audioName = (app) => {
    const custom = getConfig().captureProcessNames?.[app];
    return validProcessName(custom) ? custom : CAPTURE_AUDIO[app] || CAPTURE_APPS[app];
  };
  const need = (app) => {
    if (!supported) throw fail('擷取官方播放器的聲音只支援 Windows');
    if (!CAPTURE_APPS[app]) throw fail('沒有這個播放器', 400);
  };

  /** 編譯擷取工具（已經編譯過同一份原始碼就直接用）。 */
  function ensureBuilt() {
    return (building ||= (async () => {
      const source = await readFile(SOURCE);
      const exe = join(dataDir, 'bin', 'jukebox-capture-' + createHash('sha256').update(source).digest('hex').slice(0, 10) + '.exe');
      try {
        await access(exe);
        return exe;
      } catch {}
      await mkdir(dirname(exe), { recursive: true });
      const root = env.WINDIR || env.SystemRoot || 'C:\\Windows';
      const temp = exe + '.tmp-' + process.pid + '.exe';
      let lastError = '';
      for (const folder of ['Framework64', 'Framework']) {
        const csc = join(root, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe');
        try {
          await run(csc, ['-nologo', '-optimize+', '-platform:x64', '-target:exe', '-out:' + temp, SOURCE], { windowsHide: true, timeout: 60000 });
          await rename(temp, exe);
          return exe;
        } catch (error) {
          lastError = error?.code === 'ENOENT' ? '' : String(error?.stdout || error?.message || '').trim().split('\n')[0].slice(0, 120);
          await rm(temp, { force: true }).catch(() => {});
        }
      }
      throw fail('擷取工具編譯失敗：找不到 Windows 內建的 C# 編譯器（.NET Framework 4）' + (lastError ? '，或編譯出錯：' + lastError : ''), 500);
    })().catch((error) => {
      building = null;
      throw error;
    }));
  }

  /** 把播放器在音量混音器的音量調回 100%（擷取被強制中斷時的補救）。 */
  async function restoreVolume(app) {
    try {
      const exe = await ensureBuilt();
      await run(exe, ['unmute', audioName(app)], { windowsHide: true, timeout: 10000 });
    } catch {}
    await rm(marker, { force: true }).catch(() => {});
  }

  return {
    supported,
    /** 上次如果是在「調小音量」途中被強制結束，啟動時補救一次。 */
    async recover() {
      if (!supported) return;
      let stored;
      try {
        stored = JSON.parse(await readFile(marker, 'utf8'));
      } catch {
        return;
      }
      if (CAPTURE_APPS[stored?.app]) await restoreVolume(stored.app);
    },
    /** 哪些播放器正在執行。 */
    async running() {
      if (!supported) return {};
      const exe = await ensureBuilt();
      const names = Object.keys(CAPTURE_APPS).map(processName);
      const { stdout } = await run(exe, ['list', ...names], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
      const found = new Set(String(stdout || '').split('\n').map((line) => line.split('\t')[0].trim()).filter(Boolean));
      return Object.fromEntries(Object.keys(CAPTURE_APPS).map((app) => [app, found.has(processName(app))]));
    },
    status: () => ({ supported, active: active ? { app: active.app, since: active.since } : null }),
    /**
     * 開始擷取。回傳 { stream, stop, done }；stream 是 PCM 的可讀串流。
     * 同時只能有一個擷取。quiet：擷取期間讓播放器在喇叭上幾乎聽不到。
     */
    async open(app, { signal, seconds = 0, quiet = false } = {}) {
      need(app);
      if (!getConfig().captureEnabled) throw fail('「擷取官方播放器的聲音」沒有開啟；請到點唱機的設定開啟');
      signal?.throwIfAborted();
      if (active) throw fail('已經有一個擷取在進行（' + CAPTURE_LABELS[active.app] + '）；請先停止它');
      const exe = await ensureBuilt();
      signal?.throwIfAborted();
      if (active) throw fail('已經有一個擷取在進行');
      const label = CAPTURE_LABELS[app];
      const args = ['capture', audioName(app), ...(seconds > 0 ? [String(Math.ceil(seconds))] : []), ...(quiet ? ['--mute'] : []), '--watch-stdin'];
      const child = spawnImpl(exe, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const entry = { app, child, since: Date.now(), quiet, clean: false };
      active = entry;
      let stderr = '';
      let stopping = false;
      child.stderr.setEncoding('utf8');
      child.stdin.on('error', () => {});
      child.stdout.on('error', () => {});
      const done = new Promise((resolve) => {
        child.once('error', () => resolve(-1));
        child.once('close', (code) => resolve(code));
      }).then(async (code) => {
        if (active === entry) active = null;
        // 工具正常結束時會自己把音量還原；被強制結束的話由這裡補救。
        if (quiet && code !== 0 && code !== 3) await restoreVolume(app);
        else await rm(marker, { force: true }).catch(() => {});
        return code;
      });
      /** 請工具收尾（還原音量）後結束；兩秒內沒結束才強制關掉。 */
      const stop = () => {
        if (stopping) return done;
        stopping = true;
        try {
          child.stdin.end();
        } catch {}
        const timer = setTimeout(() => child.kill(), 2000);
        timer.unref?.();
        return done.finally(() => clearTimeout(timer));
      };
      signal?.addEventListener('abort', stop, { once: true });
      // 接收端把串流關掉（例如 Discord 停止播放）時也要收尾。
      child.stdout.once('close', stop);
      if (quiet) await writeFile(marker, JSON.stringify({ app, at: Date.now() }), 'utf8').catch(() => {});
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(fail('擷取工具啟動逾時', 500)), 12000);
          child.stderr.on('data', (text) => {
            stderr += text;
            if (/READY/.test(stderr)) {
              clearTimeout(timer);
              resolve();
            }
          });
          done.then(() => {
            clearTimeout(timer);
            reject(fail(captureError(stderr, label), 409, /NOT_RUNNING/.test(stderr) ? 'NOT_RUNNING' : 'CAPTURE_FAILED'));
          });
        });
      } catch (error) {
        await stop();
        throw error;
      }
      logger?.debug?.('dsh-jukebox：開始擷取 ' + label);
      return { stream: child.stdout, stop, done, app };
    },
    /** 試擷取幾秒，回報有沒有聲音（給設定頁的「測試」用）。不保存聲音。 */
    async test(app, { seconds = 3, quiet = false } = {}) {
      const session = await this.open(app, { seconds, quiet });
      let peak = 0;
      let sum = 0;
      let count = 0;
      let rest = Buffer.alloc(0);
      for await (const chunk of session.stream) {
        const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
        const usable = data.length - (data.length % 2);
        for (let i = 0; i < usable; i += 2) {
          const v = Math.abs(data.readInt16LE(i));
          if (v > peak) peak = v;
          sum += v * v;
          count += 1;
        }
        rest = data.subarray(usable);
      }
      await session.done;
      return { ok: true, seconds: Math.round((count / 2 / 48000) * 10) / 10, peak: Math.round((peak / 32767) * 100), level: Math.round((Math.sqrt(sum / Math.max(1, count)) / 32767) * 1000) / 10, heard: peak > 60 };
    },
    /** 目前在最前面的視窗（代號）。拿不到就回 0。 */
    async foreground() {
      if (!supported) return 0;
      const exe = await ensureBuilt();
      const { stdout } = await run(exe, ['fg'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      const handle = Number(String(stdout || '').trim());
      return Number.isSafeInteger(handle) && handle > 0 ? handle : 0;
    },
    /** 某個播放器的主視窗現在是不是縮小的：'minimized'｜'normal'｜'none'。 */
    async windowState(app) {
      if (!supported || !CAPTURE_APPS[app]) return 'none';
      const exe = await ensureBuilt();
      const { stdout } = await run(exe, ['win', processName(app)], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).catch(() => ({ stdout: '' }));
      return String(stdout || '').trim().toLowerCase() || 'none';
    },
    /** 把縮小的播放器叫出來但不啟用，放到所有視窗的最底層。回傳現在是不是顯示著。 */
    async showBehind(app) {
      if (!supported || !CAPTURE_APPS[app]) return false;
      const exe = await ensureBuilt();
      const { stdout } = await run(exe, ['win', processName(app), 'behind'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).catch(() => ({ stdout: '' }));
      return /NORMAL/.test(String(stdout || ''));
    },
    /** 把某個播放器的主視窗縮回工作列（不改變目前在前面的視窗）。 */
    async minimize(app) {
      if (!supported || !CAPTURE_APPS[app]) return false;
      const exe = await ensureBuilt();
      const { stdout } = await run(exe, ['win', processName(app), 'minimize'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).catch(() => ({ stdout: '' }));
      return /MINIMIZED/.test(String(stdout || ''));
    },
    /** 前景落在已經縮小的視窗上時（沒有任何視窗拿到鍵盤），交給畫面上最上層的視窗。回傳有沒有處理。 */
    async healForeground() {
      if (!supported) return false;
      const exe = await ensureBuilt();
      const { stdout } = await run(exe, ['fg', 'heal'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).catch(() => ({ stdout: '' }));
      return /HEALED/.test(String(stdout || ''));
    },
    /** 把先前記下的視窗帶回最前面。 */
    async restoreForeground(handle) {
      if (!supported || !Number.isSafeInteger(handle) || handle <= 0) return false;
      const exe = await ensureBuilt();
      const { stdout } = await run(exe, ['fg', String(handle)], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).catch(() => ({ stdout: '' }));
      return !/NOT_RESTORED/.test(String(stdout || ''));
    },
    /**
     * 在 Apple Music 的視窗裡搜尋並按下播放（用 Windows 的使用者介面自動化對元件下指令，不動滑鼠）。
     * 回傳 { ok, picked } 或 { ok:false, error }。
     */
    async appleMusicPlay(query, title = '') {
      if (!supported) throw fail('只支援 Windows');
      const clean = (value) => String(value || '').replace(/['\r\n\0]/g, ' ').trim().slice(0, 120);
      const script = "& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 -LiteralPath '" + APPLE_SCRIPT.replace(/'/g, "''") + "'))) '" + clean(query) + "' '" + clean(title) + "'";
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 40000, encoding: 'utf8' }).catch((error) => ({ stdout: String(error?.stdout || '') }));
      try {
        return JSON.parse(String(stdout || '').trim());
      } catch {
        return { ok: false, error: 'no-response' };
      }
    },
    /**
     * 用 Spotify 桌面版自己的搜尋找歌（讀它的介面元件，不用登入、不動滑鼠、做完把視窗狀態還原）。
     * 回傳 { ok, tracks:[{id,title,artist}] } 或 { ok:false, error }。
     */
    async spotifySearch(query, limit = 10) {
      if (!supported) throw fail('只支援 Windows');
      const clean = String(query || '').replace(/['"`$\r\n\0]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      const script = "& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 -LiteralPath '" + SPOTIFY_SEARCH_SCRIPT.replace(/'/g, "''") + "'))) '" + clean + "' " + Math.max(1, Math.min(20, Number(limit) || 10));
      // 腳本會打開 Spotify 的搜尋連結：不要把 DSH 的 Electron／Node 環境變數傳下去（見 remote.js 的 cleanEnv）。
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 40000, encoding: 'utf8', env: cleanEnv() }).catch((error) => ({ stdout: String(error?.stdout || '') }));
      try {
        const result = JSON.parse(String(stdout || '').trim());
        // PowerShell 只有一筆時會輸出成物件而不是陣列。
        if (result?.ok) result.tracks = [].concat(result.tracks || []).filter((t) => /^[A-Za-z0-9]{22}$/.test(t?.id || '') && t.title);
        return result;
      } catch {
        return { ok: false, error: 'no-response' };
      }
    },
    /**
     * 在 Spotify 目前顯示的頁面上按某一首歌的播放鈕（不開連結，所以不會把它從縮小叫出來）。
     * 回傳 { ok, button } 或 { ok:false, error }；error 是 not-on-page 時由呼叫端改用播放連結。
     */
    async spotifyPlayOnPage(trackId) {
      if (!supported) throw fail('只支援 Windows');
      if (!/^[A-Za-z0-9]{22}$/.test(String(trackId || ''))) return { ok: false, error: 'bad-id' };
      const script = "& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 -LiteralPath '" + SPOTIFY_PLAY_SCRIPT.replace(/'/g, "''") + "'))) '" + trackId + "'";
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, encoding: 'utf8' }).catch((error) => ({ stdout: String(error?.stdout || '') }));
      try {
        return JSON.parse(String(stdout || '').trim());
      } catch {
        return { ok: false, error: 'no-response' };
      }
    },
    /** 按 Apple Music 視窗自己的播放控制鍵（toggle／next／previous）。回傳 { ok, label } 或 { ok:false, error }。 */
    async appleMusicButton(action) {
      if (!supported) throw fail('只支援 Windows');
      if (!['toggle', 'next', 'previous'].includes(action)) throw fail('沒有這個按鈕', 400);
      const script = "& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 -LiteralPath '" + APPLE_CONTROL_SCRIPT.replace(/'/g, "''") + "'))) '" + action + "'";
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, encoding: 'utf8' }).catch((error) => ({ stdout: String(error?.stdout || '') }));
      try {
        return JSON.parse(String(stdout || '').trim());
      } catch {
        return { ok: false, error: 'no-response' };
      }
    },
    /** 送一個媒體鍵（和鍵盤上的媒體鍵相同；由系統決定哪個播放器收到）。 */
    async key(name) {
      if (!supported) throw fail('媒體鍵只支援 Windows');
      if (!MEDIA_KEYS.includes(name)) throw fail('沒有這個媒體鍵', 400);
      const exe = await ensureBuilt();
      await run(exe, ['key', name], { windowsHide: true, timeout: 10000 });
      return { ok: true };
    },
    /** 聽某個播放器一小段時間，回報有沒有聲音。不保存聲音，也不占用「同時只能一個擷取」的名額。 */
    async level(app, seconds = 1) {
      need(app);
      const exe = await ensureBuilt();
      return new Promise((resolve) => {
        const child = spawnImpl(exe, ['capture', audioName(app), String(Math.max(1, Math.min(5, Math.ceil(seconds))))], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        let peak = 0;
        let rest = Buffer.alloc(0);
        child.stdout.on('data', (chunk) => {
          const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
          const usable = data.length - (data.length % 2);
          for (let i = 0; i < usable; i += 2) {
            const v = Math.abs(data.readInt16LE(i));
            if (v > peak) peak = v;
          }
          rest = data.subarray(usable);
        });
        child.once('error', () => resolve({ heard: false, peak: 0 }));
        child.once('close', () => resolve({ heard: peak > 60, peak: Math.round((peak / 32767) * 100) }));
      });
    },
    /**
     * Windows 的系統媒體控制：列出各播放器的工作階段（曲名、歌手、播放狀態），或對名稱符合的那個送動作。
     * 播放器要開始播放之後才會出現在這裡（KKBOX 桌面版實測如此）。
     */
    async mediaSessions(action = 'list', match = '') {
      if (!supported) return [];
      if (!SESSION_ACTIONS.includes(action) || !/^[a-z]{0,20}$/.test(match)) throw fail('系統媒體控制的參數不正確', 400);
      const script = "& ([scriptblock]::Create((Get-Content -Raw -Encoding UTF8 -LiteralPath '" + SESSIONS_SCRIPT.replace(/'/g, "''") + "'))) '" + action + "' '" + match + "'";
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
      let parsed;
      try {
        parsed = JSON.parse(String(stdout || '').trim());
      } catch {
        throw fail('讀不到系統媒體控制的狀態', 500);
      }
      if (!parsed.ok) throw fail('系統媒體控制沒有回應', 500);
      return Array.isArray(parsed.sessions) ? parsed.sessions : [];
    },
    /** 停掉進行中的擷取（先請它收尾並還原音量）。 */
    async stopAll() {
      const entry = active;
      if (!entry) return false;
      try {
        entry.child.stdin.end();
      } catch {}
      await new Promise((resolve) => {
        const timer = setTimeout(() => entry.child.kill(), 2000);
        timer.unref?.();
        entry.child.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        if (entry.child.exitCode !== null) {
          clearTimeout(timer);
          resolve();
        }
      });
      return true;
    },
  };
}
