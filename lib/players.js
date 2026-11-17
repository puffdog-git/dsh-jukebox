// 控制這台電腦上的官方播放器：看狀態、暫停／繼續／上下首、依歌名播放。
//
// 各播放器能用的控制方式不同（2026-11 在這台電腦實測或查證）：
//   Spotify      這台電腦的 Spotify 開著時：用它自己的連結 spotify:track:<編號> 播放（實測免費版也可以，約 3 秒開始播），
//                暫停／繼續／上下首用 Windows 的系統媒體控制（實測可用）。找歌：登入了用官方搜尋接口；沒登入就讀
//                Spotify 桌面版自己的搜尋結果（它會公開介面元件，縮小時也讀得到；見 capture/spotify-search.ps1）。
//                這台電腦沒開 Spotify 時才用官方接口遙控別的裝置（需要 Premium）。
//   KKBOX        依歌名播放：先找到歌曲編號，再用 KKBOX 自己的連結 kkbox://song/<編號>#play（實測可用）。
//                開始播放之後 KKBOX 會出現在 Windows 的系統媒體控制裡（讀得到曲名，暫停／繼續實測可用）；
//                還沒播過時那裡看不到它，這時暫停／繼續／上下首改用媒體鍵（也實測可用）。
//   Apple Music  沒有能直接播歌的連結（實測：打開歌曲連結不會開始播）。它的視窗元件可以讀也可以下指令，
//                所以用使用者介面自動化：搜尋 → 歌曲結果 → 專輯頁的那一列 →「更多」選單的「播放「歌名」」。
//                實測可以播出聲音（需要有訂閱；剛訂閱時要重開 Apple Music 才會生效）。
// 暫停／繼續／上下首的順序：Windows 系統媒體控制（能指定播放器）→ 媒體鍵；Spotify 不在這台電腦執行時用它的接口。
// 媒體鍵和鍵盤上的一樣，由系統決定哪個播放器收到；同時開著好幾個播放器時可能控制到別的。
import { CAPTURE_APPS, CAPTURE_LABELS } from './capture.js';

export const PLAYERS = Object.keys(CAPTURE_APPS);
export const PLAYER_ACTIONS = ['pause', 'resume', 'next', 'previous'];
// 系統媒體控制的來源程式名稱裡會出現的字。
const SESSION_HINT = { spotify: 'spotify', kkbox: 'kkbox', apple: 'applemusic' };
const fail = (message, status = 409, code) => Object.assign(Error(message), { status, code });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPlayers({ capture, sources, remote, getConfig, wait = sleep } = {}) {
  const need = (player) => {
    if (!PLAYERS.includes(player)) throw fail('沒有這個播放器；可以用的是 ' + PLAYERS.join('、'), 400);
    if (!capture.supported) throw fail('控制官方播放器只支援 Windows');
  };
  const label = (player) => CAPTURE_LABELS[player];
  const spotifyReady = () => sources.spotify.configured().catch(() => false);

  async function sessionOf(player) {
    const sessions = await capture.mediaSessions('list').catch(() => []);
    return sessions.find((s) => String(s.app || '').toLowerCase().includes(SESSION_HINT[player])) || null;
  }

  /**
   * 叫播放器做事時，它的視窗常會跳到最前面（實測：KKBOX 的播放連結、Apple Music 的選單都會）。
   * 這裡先記下使用者原本在用的視窗，做完再把焦點還回去。
   */
  async function keepFocus(work, player, { needsWindow = false } = {}) {
    const before = await capture.foreground().catch(() => 0);
    // 播放器原本縮小在工作列的話，做完把它縮回去（實測：播放連結會把 Spotify 從縮小叫出來）。
    const wasMinimized = player && capture.windowState ? (await capture.windowState(player).catch(() => 'none')) === 'minimized' : false;
    // 有些播放器縮小時介面元件不能操作（Apple Music 實測：縮小時叫不出選單）：先把它放到所有視窗的最底層。
    if (needsWindow && wasMinimized && capture.showBehind) {
      await capture.showBehind(player).catch(() => {});
      await wait(500);
    }
    try {
      return await work();
    } finally {
      if (wasMinimized) {
        await wait(600);
        if ((await capture.windowState(player).catch(() => 'none')) === 'normal') await capture.minimize(player).catch(() => {});
      }
      if (before) {
        await wait(wasMinimized ? 0 : 400);
        const now = await capture.foreground().catch(() => 0);
        if (now && now !== before) await capture.restoreForeground(before).catch(() => {});
      }
      await capture.healForeground?.().catch(() => {});
    }
  }
  const APPLE_ERRORS = {
    'not-running': 'Apple Music 沒有在執行；請先打開它',
    'no-search-box': '在 Apple Music 的視窗裡找不到搜尋框',
    'no-suggestion': 'Apple Music 沒有出現搜尋建議；可能還在載入或沒有登入',
    'no-song-result': 'Apple Music 的搜尋結果裡沒有歌曲',
    'no-track-row': '在 Apple Music 的專輯頁裡找不到那一首',
    'no-play-item': '在 Apple Music 的選單裡找不到播放那一首的項目',
  };

  /** 每個播放器的狀態：有沒有開、現在播什麼（讀得到的話）、能用哪些控制。 */
  async function status() {
    if (!capture.supported) return { supported: false, players: {} };
    const [running, sessions, spotify] = [await capture.running(), await capture.mediaSessions('list').catch(() => []), await spotifyReady()];
    const players = {};
    for (const player of PLAYERS) {
      const session = sessions.find((s) => String(s.app || '').toLowerCase().includes(SESSION_HINT[player]));
      players[player] = {
        name: label(player),
        running: !!running[player],
        // 依歌名播放：api＝官方接口、link＝播放器自己的連結、window＝自動操作它的視窗、
        // none＝播放器沒開（Spotify 沒開又沒登入時）。Spotify 開著時不用登入：用它自己的搜尋找歌、用播放連結播。
        playByName: player === 'spotify' ? (running.spotify ? 'link' : spotify ? 'api' : 'none') : player === 'kkbox' ? 'link' : player === 'apple' ? 'window' : 'none',
        control: player === 'spotify' && spotify && !running.spotify ? 'api' : session ? 'session' : player === 'apple' ? 'window' : 'mediakey',
        nowPlaying: session ? { title: session.title || '', artist: session.artist || '', state: String(session.status || '').toLowerCase() } : null,
      };
    }
    return { supported: true, players };
  }

  /** 暫停／繼續／下一首／上一首。 */
  async function control(player, action) {
    need(player);
    if (!PLAYER_ACTIONS.includes(action)) throw fail('不支援這個動作；可以用的是 ' + PLAYER_ACTIONS.join('、'), 400);
    const here = !!(await capture.running())[player];
    // Spotify 不在這台電腦執行：用官方接口遙控別的裝置。
    if (player === 'spotify' && !here && (await spotifyReady())) {
      await sources.spotify.remote[action]();
      return { ok: true, player, action, via: 'api' };
    }
    if (!here) throw fail(label(player) + ' 沒有在執行；請先打開它', 409, 'NOT_RUNNING');
    const current = await sessionOf(player);
    if (current) {
      const done = await capture.mediaSessions({ pause: 'pause', resume: 'play', next: 'next', previous: 'previous' }[action], SESSION_HINT[player]);
      if (done.some((s) => s.done)) {
        // 播放器裡沒有載入任何歌時，系統媒體控制會收下指令但什麼都不會發生（實測過這種情況）：照實說。
        const empty = action !== 'pause' && String(current.status || '').toLowerCase() === 'stopped' && !current.title;
        return { ok: true, player, action, via: 'session', ...(empty ? { note: label(player) + ' 裡目前沒有載入任何歌，這個動作可能沒有效果；請先在播放器裡播一首歌' } : {}) };
      }
    }
    // Apple Music 沒有系統媒體控制時，直接按它視窗自己的按鈕：媒體鍵由系統決定給誰，可能控制到別的播放器（實測）。
    const button = player === 'apple' && capture.appleMusicButton ? (name) => capture.appleMusicButton(name) : null;
    const via = button ? 'window' : 'mediakey';
    const press = async (name) => {
      if (!button) return void (await capture.key(name === 'toggle' ? 'play_pause' : name));
      const result = await button(name);
      if (!result.ok) throw fail(result.error === 'disabled' ? 'Apple Music 裡沒有可以' + (name === 'toggle' ? '播放' : '切換') + '的歌' : '在 Apple Music 的視窗裡找不到播放控制鍵', 409, 'WINDOW_OPERATION_FAILED');
    };
    // 「播放／暫停」是切換式的：先聽一下現在有沒有聲音，避免把暫停變成播放。
    const audible = (await capture.level(player, 1)).heard;
    // 媒體鍵由系統決定給誰。這個播放器沒有在出聲時，鍵很可能落到別的程式（實測落到過別的播放器與瀏覽器的影片），所以不送。
    if (!button && !audible && action !== 'pause') throw fail(label(player) + ' 目前沒有在播放，而且系統媒體控制裡看不到它，沒辦法只對它下這個指令；請先在它裡面播一首歌', 409, 'NOT_PLAYING');
    if (action === 'pause' || action === 'resume') {
      if ((action === 'pause') !== audible) return { ok: true, player, action, via, already: true };
      await press('toggle');
      await wait(900);
      const after = (await capture.level(player, 1)).heard;
      return { ok: true, player, action, via, verified: after === (action === 'resume') };
    }
    await press(action);
    return { ok: true, player, action, via };
  }

  /**
   * 用連結叫播放器播歌之後，有時它只把歌載入、停在暫停（KKBOX 實測：前一首是暫停狀態時會這樣）。
   * 這裡等系統媒體控制顯示那首歌；如果是暫停就補送一次「播放」。
   */
  async function nudge(player, track, signal) {
    for (let attempt = 0; attempt < 8; attempt++) {
      await wait(500);
      signal?.throwIfAborted();
      const session = await sessionOf(player);
      if (!session || String(session.title || '').trim() !== String(track.title || '').trim()) continue;
      const state = String(session.status || '').toLowerCase();
      if (state === 'playing') return;
      if (state === 'paused' || state === 'stopped') {
        await capture.mediaSessions('play', SESSION_HINT[player]).catch(() => {});
        return;
      }
    }
  }

  /** 找到要播的那首歌的資料（不播放）。 */
  async function find(player, { query, id, signal } = {}) {
    need(player);
    const source = sources[player];
    if (id) return source.track(String(id), { signal });
    const q = String(query || '').trim();
    if (!q) throw fail('請給歌名（可以加歌手）', 400);
    // 給的是這個播放器自己的歌曲連結：直接用，不用搜尋（Spotify 沒登入時只能這樣）。
    const link = source.parseLink?.(q);
    if (link?.kind === 'track') return source.track(link.id, { signal });
    const rows = await source.search(q, { signal, limit: 5 });
    if (!rows.length) throw fail(label(player) + ' 找不到「' + q.slice(0, 60) + '」', 404, 'NOT_FOUND');
    return rows[0];
  }

  /** 叫播放器開始播某首歌（已經知道歌曲資料）。不等它真的出聲。 */
  async function start(player, track, { signal } = {}) {
    need(player);
    const here = !!(await capture.running())[player];
    if (player === 'spotify') {
      // 這台電腦的 Spotify 開著：用它自己的連結播放（免費版也可以），聲音一定在這台電腦。
      if (here) {
        // 那首歌就在 Spotify 現在顯示的頁面上（通常是剛搜尋完的結果頁）：直接按那一列的播放鈕，
        // 不開連結就不會把它從縮小叫出來（實測）。不在頁面上、或按了沒開始播，才改用播放連結。
        if (capture.spotifyPlayOnPage) {
          const pressed = await capture.spotifyPlayOnPage(track.id).catch(() => ({ ok: false }));
          if (pressed?.ok) {
            await wait(700);
            // 按下去之後 Spotify 有時會拿走前景卻仍然是縮小的（實測），這時把前景還給畫面上的視窗。
            await capture.healForeground?.().catch(() => {});
            const session = await sessionOf(player);
            if (session && String(session.status || '').toLowerCase() === 'playing' && String(session.title || '').trim() === String(track.title || '').trim()) return 'page';
          }
        }
        await keepFocus(() => remote.open('spotify', 'spotify:track:' + track.id), 'spotify');
        await nudge(player, track, signal);
        return 'link';
      }
      await sources.spotify.remote.play(track.id, { signal });
      return 'api';
    }
    if (!here) throw fail(label(player) + ' 沒有在執行；請先打開它', 409, 'NOT_RUNNING');
    if (player === 'kkbox') {
      await keepFocus(() => remote.open('kkbox', sources.kkbox.playLink(track.id)), 'kkbox');
      await nudge(player, track, signal);
      return 'link';
    }
    if (player === 'apple') {
      const result = await keepFocus(() => capture.appleMusicPlay([track.artist, track.title].filter(Boolean).join(' '), track.title), 'apple', { needsWindow: true });
      if (!result.ok) throw fail(APPLE_ERRORS[result.error] || '操作 Apple Music 的視窗時出錯', 409, 'WINDOW_OPERATION_FAILED');
      return 'window';
    }
    throw fail(label(player) + ' 不能直接指定播哪一首', 409, 'NEEDS_WINDOW_OPERATION');
  }

  /** 依歌名（或曲目編號）在官方播放器播放，並確認有沒有真的出聲。 */
  async function play(player, options = {}) {
    const track = await find(player, options);
    const via = await start(player, track, options);
    let started = null;
    // 經官方接口播放時 Spotify 可能在別的裝置上，這台電腦聽不到，所以不用聲音判斷。
    if (via !== 'api') {
      started = false;
      for (let attempt = 0; attempt < 5 && !started; attempt++) {
        await wait(attempt ? 800 : 1500);
        options.signal?.throwIfAborted();
        started = (await capture.level(player, 1)).heard;
      }
    }
    return {
      ok: true,
      player,
      via,
      started,
      track: { id: track.id, title: track.title, artist: track.artist || '', duration: track.duration || 0 },
      ...(started === false ? { note: via === 'window' ? '已在 Apple Music 裡按下播放，但幾秒內沒有聽到聲音；沒有訂閱的話目錄裡的歌播不了，剛訂閱的話請重開 Apple Music' : '已送出播放要求，但幾秒內沒有聽到聲音；請確認播放器已登入而且沒有靜音' } : {}),
    };
  }

  return { status, control, find, start, play, label, enabled: () => !!getConfig().playerControlEnabled };
}
