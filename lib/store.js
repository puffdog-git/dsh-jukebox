// 設定與資料的存放。資料在套件目錄之外，更新插件不會被換掉。
//
// 位置：環境變數 DSH_JUKEBOX_DATA（絕對路徑，測試用）→ <DSH_HOME 或 ~/.dsh>/data/dsh-jukebox
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const DATA_ENV = 'DSH_JUKEBOX_DATA';
export const SOURCE_IDS = ['local', 'ytmusic', 'bilibili', 'spotify', 'kkbox', 'apple'];
export const SOURCE_NAMES = {
  local: '本地音樂庫',
  ytmusic: 'YT Music',
  bilibili: 'bilibili',
  spotify: 'Spotify',
  kkbox: 'KKBOX',
  apple: 'Apple Music',
};
export const MATCH_ORDERS = ['local-first', 'youtube-only'];
// 播放方式：official＝用官方播放器播並即時轉送、platform＝那個平台自己可下載的音訊、youtube＝到 YouTube 找同一首、local＝在本地音樂庫找同一首。
export const PLAY_METHODS = ['official', 'platform', 'youtube', 'local'];

function priority(value, legacyOrder, fallback) {
  if (Array.isArray(value)) {
    const out = value.filter((m, i) => PLAY_METHODS.includes(m) && value.indexOf(m) === i);
    return out.length ? out : [...DEFAULT_PRIORITY];
  }
  // 從舊設定「對應播放先找哪裡」轉過來。
  if (legacyOrder === 'youtube-only') return ['official', 'platform', 'youtube'];
  if (legacyOrder === 'local-first' && !fallback) return ['official', 'platform', 'local', 'youtube'];
  return [...(fallback || DEFAULT_PRIORITY)];
}
const DEFAULT_PRIORITY = ['official', 'platform', 'youtube', 'local'];

export const DEFAULT_CONFIG = Object.freeze({
  libraryFolders: [],
  enabledSources: ['local', 'ytmusic'],
  matchOrder: 'local-first',
  territory: 'TW',
  ytdlpPath: '',
  ffmpegPath: '',
  cacheMaxMb: 1024,
  discordEnabled: true,
  toolsEnabled: true,
  remoteEnabled: true,
  spotifyClientId: '',
  spotifyLoginPort: 43917,
  captureEnabled: false,
  captureQuiet: true,
  captureControl: false,
  captureProcessNames: {},
  playerControlEnabled: false,
  playPriority: ['official', 'platform', 'youtube', 'local'],
});

const int = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const list = (value, limit, each) => {
  const items = Array.isArray(value) ? value : String(value ?? '').split(/\n/);
  const out = [];
  for (const raw of items) {
    const item = each(String(raw ?? '').trim());
    if (item && !out.includes(item) && out.length < limit) out.push(item);
  }
  return out;
};
const pathText = (value) => {
  const text = String(value ?? '').trim();
  return text.length <= 400 && !/[\0\r\n]/.test(text) ? text : '';
};

// 各播放器的程式名稱（不含 .exe）。只收已知的四個播放器，名稱只能是一般檔名字元；留空表示用預設。
function processNames(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const app of ['spotify', 'kkbox', 'apple']) {
    const name = String(value[app] ?? '').trim().replace(/\.exe$/i, '');
    if (/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(name)) out[app] = name;
  }
  return out;
}

/** 把任意輸入整理成合法設定；不合法的值退回目前值或預設值。 */
export function normalizeConfig(input = {}, base = DEFAULT_CONFIG) {
  const pick = (key) => (input[key] === undefined ? base[key] : input[key]);
  return {
    // 只收絕對路徑；資料夾存不存在在掃描時才檢查。
    libraryFolders: list(pick('libraryFolders'), 10, (p) => (pathText(p) && isAbsolute(p) ? resolve(p) : '')),
    enabledSources: list(pick('enabledSources'), SOURCE_IDS.length, (s) => (SOURCE_IDS.includes(s) ? s : '')),
    matchOrder: MATCH_ORDERS.includes(pick('matchOrder')) ? pick('matchOrder') : base.matchOrder,
    territory: /^[A-Za-z]{2}$/.test(String(pick('territory') || '')) ? String(pick('territory')).toUpperCase() : base.territory,
    ytdlpPath: pathText(pick('ytdlpPath')),
    ffmpegPath: pathText(pick('ffmpegPath')),
    cacheMaxMb: int(pick('cacheMaxMb'), 100, 20000, base.cacheMaxMb),
    discordEnabled: pick('discordEnabled') !== false,
    toolsEnabled: pick('toolsEnabled') !== false,
    remoteEnabled: pick('remoteEnabled') !== false,
    spotifyClientId: /^[A-Za-z0-9]{0,64}$/.test(String(pick('spotifyClientId') ?? '').trim()) ? String(pick('spotifyClientId') ?? '').trim() : base.spotifyClientId,
    spotifyLoginPort: int(pick('spotifyLoginPort'), 1024, 65535, base.spotifyLoginPort),
    // 擷取官方播放器的聲音：預設關閉。
    captureEnabled: pick('captureEnabled') === true,
    captureQuiet: pick('captureQuiet') !== false,
    // 讓 Discord 的點歌可以叫官方播放器開始播（舊名稱 captureSpotifyControl 沿用它的值）。
    captureControl: (input.captureControl ?? input.captureSpotifyControl ?? base.captureControl) === true,
    // 讓 DSH 對話裡的 AI 可以控制官方播放器。
    playerControlEnabled: pick('playerControlEnabled') === true,
    // 播放方式的優先順序：只留認得的、不重複；清單裡沒有的表示不使用；全部拿掉就回到預設。
    playPriority: priority(input.playPriority, input.matchOrder, base.playPriority),
    captureProcessNames: processNames(pick('captureProcessNames')),
  };
}

export function resolveDataDir({ env = process.env, home = homedir() } = {}) {
  const override = String(env[DATA_ENV] || '').trim();
  if (override) {
    if (!isAbsolute(override)) throw Error(DATA_ENV + ' 必須是絕對路徑');
    return resolve(override);
  }
  return join(env.DSH_HOME || join(home, '.dsh'), 'data', 'dsh-jukebox');
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    // 檔案壞了：留著原檔給人看，這次用預設值。
    await rename(file, file + '.corrupt-' + Date.now()).catch(() => {});
    return fallback;
  }
}

export async function writeJson(file, value) {
  const temp = file + '.tmp-' + process.pid;
  await writeFile(temp, JSON.stringify(value), 'utf8');
  await rename(temp, file);
}

export async function createStore({ dir = resolveDataDir() } = {}) {
  await mkdir(join(dir, 'cache'), { recursive: true });
  const file = join(dir, 'config.json');
  let config = normalizeConfig(await readJson(file, {}));
  let writes = Promise.resolve();
  return {
    dir,
    cacheDir: join(dir, 'cache'),
    config: () => config,
    async setConfig(patch) {
      config = normalizeConfig(patch && typeof patch === 'object' ? patch : {}, config);
      writes = writes.catch(() => {}).then(() => writeJson(file, config));
      await writes;
      return config;
    },
    flush: () => writes.catch(() => {}),
  };
}
