// 「在官方播放器打開」：請作業系統用預設的程式打開某個服務的歌曲連結。
// 聲音由官方播放器在這台電腦播放，不會進 Discord 語音房。
// 只接受下面白名單裡的網址格式，不經過 shell。
import { execFile } from 'node:child_process';

const RULES = {
  spotify: (v) => (/^spotify:(track|album|playlist):[A-Za-z0-9]{22}$/.test(v) ? v : ''),
  // KKBOX 的網頁連結，或桌面版自己的播放連結（kkbox://song/<編號>#play）。
  kkbox: (v) => (/^https:\/\/www\.kkbox\.com\/[a-z]{2}\/[a-z]{2}\/(song|album|playlist)\/[A-Za-z0-9_-]{8,40}$/.test(v) || /^kkbox:\/\/song\/[A-Za-z0-9_-]{8,40}#play$/.test(v) ? v : ''),
  apple: (v) => (/^https:\/\/music\.apple\.com\/[a-z]{2}\/(album|song|playlist)\/[^\s"'<>\\^|`{}]{1,300}$/.test(v) ? v : ''),
  bilibili: (v) => (/^https:\/\/www\.bilibili\.com\/(video\/BV[A-Za-z0-9]{10}|audio\/au\d{1,12})$/.test(v) ? v : ''),
  ytmusic: (v) => (/^https:\/\/music\.youtube\.com\/(watch\?v=[A-Za-z0-9_-]{11}|playlist\?list=[A-Za-z0-9_-]{13,80})$/.test(v) ? v : ''),
};

/** 檢查並回傳可以打開的網址；不合格回空字串。 */
export function openTarget(source, value) {
  return RULES[source]?.(String(value || '').trim()) || '';
}

/**
 * 交給被打開的程式的環境變數。
 * DSH 的宿主是用 ELECTRON_RUN_AS_NODE 啟動的；這個變數會被子程序繼承，
 * 而 KKBOX 這類 Electron 做的播放器一讀到它就會把自己當成 Node 執行、不處理播放連結
 * （2026-11 實測：從 DSH 裡開 kkbox:// 連結沒有反應，從一般程式開就正常）。
 * 所以打開播放器前把 Electron／Node 的這類變數拿掉。
 */
export function cleanEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) if (!/^(ELECTRON_|NODE_OPTIONS$|NODE_PATH$|NODE_CHANNEL_FD$|NODE_UNIQUE_ID$)/i.test(key)) out[key] = value;
  return out;
}

export function createRemote({ platform = process.platform, run = execFile } = {}) {
  return {
    open(source, value) {
      const target = openTarget(source, value);
      if (!target) throw Object.assign(Error('這個連結的格式不在允許範圍內'), { status: 400 });
      const [bin, args] = platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', target]] : platform === 'darwin' ? ['open', [target]] : ['xdg-open', [target]];
      return new Promise((resolve, reject) => {
        run(bin, args, { windowsHide: true, timeout: 15000, env: cleanEnv() }, (error) => (error ? reject(Error('無法在這台電腦打開官方播放器')) : resolve({ ok: true, opened: target })));
      });
    },
  };
}
