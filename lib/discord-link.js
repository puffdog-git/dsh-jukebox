// 把點唱機的來源登記成「Discord 賽博群友」的音樂來源。
//
// Discord 插件提供的入口（兩個是同一個東西）：
//   globalThis.__DSH_DISCORD_PYSELF_LAB__.registerMusicProvider(provider)
//   ctx 服務 discordMusic 的 register(provider)
// provider：{ id, name, available(), search(query,{signal}) → [{id,title,artist}], load(id,{signal}) → 音訊位元組 }
// Discord 那邊的限制：load 要在 120 秒內回傳、最多 64 MiB。
//
// 兩個插件誰先載入都可以：這裡定時檢查，Discord 插件出現、重新載入或設定改了就重新登記。
import { SOURCE_NAMES } from './store.js';

export const DISCORD_SOURCES = ['local', 'ytmusic', 'bilibili', 'spotify', 'kkbox', 'apple'];
export const providerId = (source) => 'jukebox-' + source;
const LIVE_CAPABLE = ['spotify', 'kkbox', 'apple'];

export function findDiscordHost(ctx, root = globalThis) {
  const lab = root.__DSH_DISCORD_PYSELF_LAB__;
  if (typeof lab?.registerMusicProvider === 'function') return { key: lab, register: (p) => lab.registerMusicProvider(p), version: lab.version || '' };
  let service;
  try {
    service = ctx?.get?.('discordMusic');
  } catch {}
  if (typeof service?.register === 'function') return { key: service, register: (p) => service.register(p), version: '' };
  return null;
}

export function makeProvider(core, source) {
  return {
    id: providerId(source),
    name: '點唱機：' + SOURCE_NAMES[source] + (['local', 'ytmusic', 'bilibili'].includes(source) ? '' : '（依你設定的播放方式）'),
    available: () => !!core.usable()[source],
    // 搜尋結果的曲目編號帶著播放方式：依點唱機的「播放方式的優先順序」，
    // 可以用官方播放器時是 live:<編號>（邊收邊播），否則是一般編號（下載得到的音訊）。
    search: (query, { signal } = {}) => core.searchForDiscord(source, query, { signal }),
    load: (id, { signal } = {}) => {
      if (String(id).startsWith('live:')) throw Error('這首歌要用官方播放器即時播放，需要 Discord 賽博群友 1.0.8 以上');
      return core.audioBytes(source, String(id), { signal });
    },
    // 只有能「指定播哪一首」的官方播放器來源才宣告即時播放的能力；
    // 其他來源不宣告，Discord 的來源清單才不會把它們也標成即時。
    ...(LIVE_CAPABLE.includes(source)
      ? {
          isLiveTrack: (id) => String(id).startsWith('live:'),
          openLive: async (id, { signal } = {}) => ({ stream: (await core.liveOpenTrack(source, String(id).slice(5), { signal })).stream }),
        }
      : {}),
  };
}

export const LIVE_PROVIDER = 'jukebox-live';

/**
 * 即時來源：轉送官方播放器現在播出來的聲音。Discord 那邊看到 openLive 就會邊收邊播（1.0.7 起支援）。
 * 舊版 Discord 插件不認得 openLive，只會呼叫 load，所以 load 要明確說明原因。
 */
export function makeLiveProvider(core) {
  return {
    id: LIVE_PROVIDER,
    name: '點唱機：官方播放器的聲音（即時轉送）',
    available: () => core.capture.supported && core.store.config().captureEnabled,
    search: (query) => core.liveSearch(query),
    load: async () => {
      throw Error('這是即時來源，需要 Discord 賽博群友 1.0.7 以上才能播放');
    },
    openLive: async (id, { signal } = {}) => ({ stream: (await core.liveOpen(String(id), { signal })).stream }),
  };
}

export function createDiscordLink({ core, ctx, isOn, root = globalThis, logger } = {}) {
  let hostKey = null;
  let registered = new Map(); // source → 取消登記的函式
  let lastError = '';
  let version = '';

  function clear() {
    for (const dispose of registered.values()) {
      try {
        dispose?.();
      } catch {}
    }
    registered = new Map();
  }

  function sync() {
    const host = isOn() ? findDiscordHost(ctx, root) : null;
    if (!host) {
      clear();
      hostKey = null;
      return;
    }
    if (host.key !== hostKey) {
      // Discord 插件重新載入了：舊的登記跟著舊實例一起消失，不需要（也不應該）去動它。
      registered = new Map();
      hostKey = host.key;
      version = host.version;
    }
    const wanted = DISCORD_SOURCES.filter((s) => core.enabled(s));
    // 即時來源只在使用者開啟擷取時登記。
    if (core.capture?.supported && core.store.config().captureEnabled) wanted.push('live');
    for (const [source, dispose] of registered) {
      if (wanted.includes(source)) continue;
      try {
        dispose?.();
      } catch {}
      registered.delete(source);
    }
    for (const source of wanted) {
      if (registered.has(source)) continue;
      try {
        registered.set(source, host.register(source === 'live' ? makeLiveProvider(core) : makeProvider(core, source)));
        lastError = '';
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 160);
        logger?.warn?.('dsh-jukebox：登記 Discord 音樂來源失敗：' + lastError);
      }
    }
  }

  const timer = setInterval(() => {
    try {
      sync();
    } catch {}
  }, 10000);
  timer.unref?.();

  return {
    sync,
    status: () => ({ found: !!hostKey, version, registered: [...registered.keys()].map(providerId), error: lastError }),
    dispose() {
      clearInterval(timer);
      clear();
      hostKey = null;
    },
  };
}
