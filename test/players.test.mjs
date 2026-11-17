// 官方播放器控制、播放方式的優先順序、技能。全部用假的擷取與來源，不碰真的播放器。
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createCore } from '../lib/core.js';
import { makeProvider } from '../lib/discord-link.js';
import { createPlayers } from '../lib/players.js';
import { createSecrets } from '../lib/secrets.js';
import { createSkillProvider, parseSkill, JUKEBOX_SKILLS } from '../lib/skills.js';
import { normalizeConfig } from '../lib/store.js';
import { openTarget } from '../lib/remote.js';

function fakeCapture({ running = { spotify: false, kkbox: true, apple: false }, sessions = [], audible = false } = {}) {
  const state = { audible, keys: [], sessionActions: [], opened: [], levels: 0, streams: [], front: 111, restored: [], apple: [], appleResult: { ok: true, picked: 'x' } };
  return {
    state,
    supported: true,
    running: async () => running,
    mediaSessions: async (action = 'list', match = '') => {
      if (action === 'list') return sessions;
      state.sessionActions.push([action, match]);
      return sessions.filter((s) => s.app.toLowerCase().includes(match)).map((s) => ({ ...s, done: true }));
    },
    level: async () => (state.levels++, { heard: state.audible, peak: state.audible ? 30 : 0 }),
    // 媒體鍵的播放／暫停是切換式的。
    key: async (name) => (state.keys.push(name), name === 'play_pause' && (state.audible = !state.audible), { ok: true }),
    open: async (app, options) => {
      state.opened.push([app, options]);
      let resolveDone;
      const done = new Promise((r) => (resolveDone = r));
      const stream = new PassThrough();
      state.streams.push(stream);
      return { app, stream, done, stop: async () => resolveDone(0), finish: () => resolveDone(0) };
    },
    // 前景視窗：操作播放器時它會跳到前面（這裡用 front 模擬），做完要還原。
    foreground: async () => state.front,
    restoreForeground: async (handle) => (state.restored.push(handle), (state.front = handle), true),
    appleMusicPlay: async (query, title) => (state.apple.push([query, title]), (state.front = 999), state.appleResult),
    status: () => ({ supported: true, active: null }),
    recover: async () => {},
    stopAll: async () => false,
  };
}
const track = { id: 'Kn9Aw92cKmKv6tCogT', title: '告白氣球', artist: '周杰倫', duration: 215, url: 'https://www.kkbox.com/tw/tc/song/Kn9Aw92cKmKv6tCogT' };
function fakeSources({ spotifyReady = false } = {}) {
  const calls = [];
  return {
    calls,
    spotify: { configured: async () => spotifyReady, search: async () => [{ id: 'S'.repeat(22), title: 'Song', artist: 'A', duration: 200 }], track: async (id) => ({ id, title: 'Song', artist: 'A', duration: 200 }), remote: Object.fromEntries(['play', 'pause', 'resume', 'next', 'previous'].map((n) => [n, async (...a) => (calls.push(['spotify', n, a[0]]), { ok: true })])) },
    kkbox: { search: async (q) => (calls.push(['kkbox-search', q]), q === '找不到' ? [] : [track]), track: async () => track, playLink: (id) => 'kkbox://song/' + id + '#play' },
    apple: { search: async () => [{ id: '1', title: 'A', artist: 'B', url: 'https://music.apple.com/tw/album/x/1?i=1#frag' }], track: async () => ({}) },
  };
}
const noWait = async () => {};

test('播放方式的優先順序：設定的整理與從舊設定轉換', () => {
  assert.deepEqual(normalizeConfig({}).playPriority, ['official', 'platform', 'youtube', 'local']);
  assert.deepEqual(normalizeConfig({ playPriority: ['local', 'x', 'local', 'youtube'] }).playPriority, ['local', 'youtube']);
  assert.deepEqual(normalizeConfig({ playPriority: [] }).playPriority, ['official', 'platform', 'youtube', 'local'], '全部拿掉就回到預設');
  assert.deepEqual(normalizeConfig({ matchOrder: 'youtube-only' }).playPriority, ['official', 'platform', 'youtube']);
  // 之後只改別的設定時，順序維持原樣。
  const saved = normalizeConfig({ playPriority: ['local', 'youtube'] });
  assert.deepEqual(normalizeConfig({ territory: 'JP' }, saved).playPriority, ['local', 'youtube']);
  assert.equal(normalizeConfig({ captureSpotifyControl: true }).captureControl, true, '舊名稱的值沿用');
  assert.equal(normalizeConfig({}).playerControlEnabled, false);
  assert.equal(normalizeConfig({}).captureControl, false);
});

test('播放器狀態：有沒有開、現在播什麼、能不能依歌名播放', async () => {
  const capture = fakeCapture({ sessions: [{ app: 'Spotify.exe', status: 'Playing', title: 'Now', artist: 'X' }], running: { spotify: true, kkbox: true, apple: false } });
  const players = createPlayers({ capture, sources: fakeSources({ spotifyReady: true }), remote: {}, getConfig: () => ({}), wait: noWait });
  const s = (await players.status()).players;
  assert.deepEqual([s.spotify.playByName, s.kkbox.playByName, s.apple.playByName], ['link', 'link', 'window']);
  assert.deepEqual(Object.keys(s), ['spotify', 'kkbox', 'apple'], '只有這三個播放器');
  assert.deepEqual(s.spotify.nowPlaying, { title: 'Now', artist: 'X', state: 'playing' });
  assert.equal(s.kkbox.nowPlaying, null);
  assert.deepEqual([s.spotify.control, s.kkbox.control], ['session', 'mediakey'], 'Spotify 在這台電腦執行時用系統媒體控制');
  const away = createPlayers({ capture: fakeCapture(), sources: fakeSources({ spotifyReady: true }), remote: {}, getConfig: () => ({}), wait: noWait });
  const remoteOnly = (await away.status()).players.spotify;
  assert.deepEqual([remoteOnly.playByName, remoteOnly.control], ['api', 'api'], 'Spotify 不在這台電腦執行時用官方接口');
  const loggedOut = createPlayers({ capture, sources: fakeSources(), remote: {}, getConfig: () => ({}), wait: noWait });
  assert.equal((await loggedOut.status()).players.spotify.playByName, 'link', '沒登入但 Spotify 開著：用它自己的搜尋與播放連結');
  assert.equal((await loggedOut.status()).players.spotify.control, 'session', '沒登入時 Spotify 改用系統媒體控制');
});

test('暫停／繼續：Spotify 不在這台電腦時走接口；有系統媒體控制就指定播放器；否則用媒體鍵而且不會把暫停變成播放', async () => {
  const sources = fakeSources({ spotifyReady: true });
  const api = createPlayers({ capture: fakeCapture(), sources, remote: {}, getConfig: () => ({}), wait: noWait });
  assert.equal((await api.control('spotify', 'next')).via, 'api');
  assert.deepEqual(sources.calls.at(-1).slice(0, 2), ['spotify', 'next']);
  // 這台電腦的 Spotify 開著：用系統媒體控制，不呼叫接口。
  const localCapture = fakeCapture({ running: { spotify: true }, sessions: [{ app: 'SpotifyAB.SpotifyMusic', status: 'Playing' }] });
  const local = createPlayers({ capture: localCapture, sources, remote: {}, getConfig: () => ({}), wait: noWait });
  const before = sources.calls.length;
  assert.equal((await local.control('spotify', 'pause')).via, 'session');
  assert.deepEqual([localCapture.state.sessionActions, sources.calls.length], [[['pause', 'spotify']], before]);

  const withSession = fakeCapture({ sessions: [{ app: 'com.kkbox.electron-app', status: 'Playing' }] });
  const viaSession = createPlayers({ capture: withSession, sources: fakeSources(), remote: {}, getConfig: () => ({}), wait: noWait });
  assert.equal((await viaSession.control('kkbox', 'pause')).via, 'session');
  assert.deepEqual(withSession.state.sessionActions, [['pause', 'kkbox']]);
  assert.deepEqual(withSession.state.keys, []);

  const capture = fakeCapture({ audible: true });
  const keys = createPlayers({ capture, sources: fakeSources(), remote: {}, getConfig: () => ({}), wait: noWait });
  const paused = await keys.control('kkbox', 'pause');
  assert.deepEqual([paused.via, paused.verified, capture.state.audible], ['mediakey', true, false]);
  const again = await keys.control('kkbox', 'pause');
  assert.equal(again.already, true);
  assert.deepEqual(capture.state.keys, ['play_pause'], '已經暫停時不再送切換鍵');
  // 沒有在出聲、系統媒體控制裡也看不到它：媒體鍵會落到別的程式，所以繼續／上下首都不送。
  await assert.rejects(keys.control('kkbox', 'resume'), (e) => e.code === 'NOT_PLAYING');
  await assert.rejects(keys.control('kkbox', 'next'), (e) => e.code === 'NOT_PLAYING');
  assert.deepEqual(capture.state.keys, ['play_pause']);
  capture.state.audible = true;
  await keys.control('kkbox', 'next');
  assert.equal(capture.state.keys.at(-1), 'next');
  await assert.rejects(keys.control('apple', 'pause'), (e) => e.code === 'NOT_RUNNING');
  await assert.rejects(keys.control('kkbox', 'explode'), /不支援這個動作/);
  await assert.rejects(keys.control('winamp', 'pause'), /沒有這個播放器/);
});

test('依歌名播放：KKBOX 用自己的連結並確認有聲音；不支援的播放器直接拒絕', async () => {
  const opened = [];
  const capture = fakeCapture();
  const remote = { open: async (source, target) => (opened.push([source, target]), (capture.state.audible = true), (capture.state.front = 222), { ok: true }) };
  const players = createPlayers({ capture, sources: fakeSources(), remote, getConfig: () => ({}), wait: noWait });
  const result = await players.play('kkbox', { query: '周杰倫 告白氣球' });
  assert.deepEqual(opened, [['kkbox', 'kkbox://song/Kn9Aw92cKmKv6tCogT#play']]);
  assert.deepEqual([result.via, result.started, result.track.title], ['link', true, '告白氣球']);
  assert.deepEqual(capture.state.restored, [111], 'KKBOX 跳到前面之後，把焦點還給原本的視窗');
  assert.equal(capture.state.front, 111);
  assert.equal(openTarget('kkbox', opened[0][1]), opened[0][1], '這個連結在允許打開的白名單裡');
  assert.equal(openTarget('kkbox', 'kkbox://song/abc#play;calc'), '');
  // 沒出聲：照實回報。
  const silent = createPlayers({ capture: fakeCapture(), sources: fakeSources(), remote: { open: async () => ({ ok: true }) }, getConfig: () => ({}), wait: noWait });
  const quiet = await silent.play('kkbox', { query: 'x' });
  assert.equal(quiet.started, false);
  assert.match(quiet.note, /沒有聽到聲音/);
  await assert.rejects(players.play('kkbox', { query: '找不到' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(players.play('kkbox', { query: '' }), /請給歌名/);
  await assert.rejects(players.play('amazon', { query: 'x' }), /沒有這個播放器/);
  // Apple Music：自動操作它的視窗；做完同樣把焦點還回去；沒出聲時說明可能是沒有訂閱。
  const appleCapture = fakeCapture({ running: { spotify: false, kkbox: false, apple: true } });
  const apple = createPlayers({ capture: appleCapture, sources: { ...fakeSources(), apple: { search: async () => [{ id: '1', title: '晴天', artist: '周杰倫', duration: 270 }] } }, remote, getConfig: () => ({}), wait: noWait });
  const viaWindow = await apple.play('apple', { query: '晴天' });
  assert.deepEqual(appleCapture.state.apple, [['周杰倫 晴天', '晴天']]);
  assert.deepEqual([viaWindow.via, viaWindow.started, appleCapture.state.restored, appleCapture.state.front], ['window', false, [111], 111]);
  assert.match(viaWindow.note, /沒有訂閱/);
  appleCapture.state.appleResult = { ok: false, error: 'no-song-result' };
  await assert.rejects(apple.play('apple', { query: '晴天' }), (e) => e.code === 'WINDOW_OPERATION_FAILED' && /沒有歌曲/.test(e.message));
  assert.equal(appleCapture.state.front, 111, '操作失敗也會把焦點還回去');
  assert.equal((await players.status()).players.spotify.playByName, 'none', 'Spotify 沒登入也沒開：沒有直接的方法');
  // Spotify 登入後走接口，不用聲音判斷（可能在別的裝置播）。
  const sources = fakeSources({ spotifyReady: true });
  const sp = createPlayers({ capture: fakeCapture(), sources, remote, getConfig: () => ({}), wait: noWait });
  const played = await sp.play('spotify', { query: 'song' });
  assert.deepEqual([played.via, played.started], ['api', null]);
  assert.deepEqual(sources.calls.at(-1).slice(0, 2), ['spotify', 'play']);
  // 這台電腦的 Spotify 開著：用它自己的連結播放（免費版也可以），並用聲音確認。
  const hereCapture = fakeCapture({ running: { spotify: true } });
  const links = [];
  const here = createPlayers({ capture: hereCapture, sources, remote: { open: async (s, t) => (links.push([s, t]), (hereCapture.state.audible = true), { ok: true }) }, getConfig: () => ({}), wait: noWait });
  const calls = sources.calls.length;
  const viaLink = await here.play('spotify', { query: 'song' });
  assert.deepEqual([viaLink.via, viaLink.started, links, sources.calls.length], ['link', true, [['spotify', 'spotify:track:' + 'S'.repeat(22)]], calls]);
  assert.equal(openTarget('spotify', links[0][1]), links[0][1]);
});

async function priorityCore(config, { ytRows = [], running = { kkbox: true } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jukebox-priority-'));
  const capture = fakeCapture({ running: { spotify: false, kkbox: false, apple: false, ...running } });
  const opened = [];
  const core = await createCore({
    dir,
    overrides: {
      secrets: createSecrets({ platform: 'linux' }),
      capture,
      ytdlp: { probe: async () => ({}), ready: () => true, status: () => ({ found: true, version: 't' }), search: async () => ytRows, fetch: async () => ({ path: 'x', size: 1 }) },
      library: { load: async () => {}, status: async () => ({ count: 1 }), candidates: async () => [{ id: 'local1', title: '告白氣球', artist: '周杰倫', duration: 215 }], get: async (id) => (id === 'local1' ? { id } : null), cancel: () => false, search: async () => ({ tracks: [], total: 0 }) },
      kkbox: { parseLink: () => null, configured: async () => true, status: async () => ({}), search: async () => [track], track: async () => track, playLink: (id) => 'kkbox://song/' + id + '#play' },
      remote: { open: async (source, target) => (opened.push([source, target]), { ok: true }) },
    },
  });
  await core.store.setConfig({ enabledSources: ['local', 'ytmusic', 'kkbox'], ...config });
  await core.refreshUsable();
  return { core, capture, opened };
}
const yt = [{ id: 'yyyyyyyyyyy', title: '告白氣球', artist: '周杰倫', duration: 215 }];

test('優先順序：對應播放照設定的先後找 YouTube 與本地音樂庫', async () => {
  const a = await priorityCore({}, { ytRows: yt });
  assert.equal((await a.core.resolve('kkbox', track.id)).kind, 'yt', '預設：YouTube 在本地音樂庫前面');
  const b = await priorityCore({ playPriority: ['official', 'platform', 'local', 'youtube'] }, { ytRows: yt });
  assert.equal((await b.core.resolve('kkbox', track.id)).kind, 'local');
  const c = await priorityCore({ playPriority: ['local'] }, { ytRows: yt });
  assert.equal((await c.core.resolve('kkbox', track.id)).kind, 'local');
  const d = await priorityCore({ playPriority: ['youtube'] }, { ytRows: [] });
  await assert.rejects(d.core.resolve('kkbox', track.id), (e) => e.code === 'NO_MATCH');
  const e = await priorityCore({ playPriority: ['official'] });
  await assert.rejects(e.core.resolve('kkbox', track.id), /沒有可用的方式/);
  for (const x of [a, b, c, d, e]) await x.core.dispose();
});

test('優先順序：官方播放器排第一而且可用時，Discord 的搜尋結果是即時播放；不可用時自動落到下一種', async () => {
  // 沒開擷取：落到對應播放。
  const off = await priorityCore({}, { ytRows: yt });
  assert.match(await off.core.officialBlocked('kkbox'), /擷取/);
  const offProvider = makeProvider(off.core, 'kkbox');
  const offRows = await offProvider.search('告白氣球');
  assert.equal(offRows[0].id, track.id);
  assert.equal(offProvider.isLiveTrack(offRows[0].id), false);
  // 開了擷取與控制、播放器開著：用官方播放器。
  const on = await priorityCore({ captureEnabled: true, captureControl: true }, { ytRows: yt });
  assert.equal(await on.core.playMode('kkbox'), 'official');
  const provider = makeProvider(on.core, 'kkbox');
  const rows = await provider.search('告白氣球');
  assert.equal(rows[0].id, 'live:' + track.id);
  assert.match(rows[0].title, /用你的 KKBOX 播放並即時轉送/);
  assert.equal(provider.isLiveTrack(rows[0].id), true);
  await assert.rejects(async () => provider.load(rows[0].id), /即時播放/);
  // 即時播放：先開始擷取、再叫 KKBOX 播，長度到了自己結束；結束後把播放器暫停。
  const opened = await provider.openLive(rows[0].id, {});
  assert.ok(opened.stream);
  assert.deepEqual(on.capture.state.opened[0][0], 'kkbox');
  assert.equal(on.capture.state.opened[0][1].seconds, 255, '秒數上限只是保險（歌曲長度加四十秒）');
  // 叫播放器開始播之前擷取到的聲音不會留到之後：交出去的串流是暫停的、沒有殘留的丟棄用監聽。
  assert.equal(on.capture.state.streams[0].listenerCount('data'), 0);
  assert.equal(on.capture.state.streams[0].isPaused(), true);
  assert.deepEqual(on.opened, [['kkbox', 'kkbox://song/' + track.id + '#play']]);
  on.capture.state.audible = true;
  await on.core.capture.stopAll();
  // 模擬轉送結束。
  const session = await on.core.liveOpenTrack('kkbox', track.id);
  on.capture.state.audible = true;
  await session.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(on.capture.state.keys.includes('play_pause'), true, '轉送結束後暫停播放器');
  assert.equal(on.capture.state.audible, false);
  // 播放器沒開：落到對應播放。
  const closed = await priorityCore({ captureEnabled: true, captureControl: true }, { ytRows: yt, running: { kkbox: false } });
  assert.match(await closed.core.officialBlocked('kkbox'), /沒有在執行/);
  assert.equal(await closed.core.playMode('kkbox'), 'file');
  // 使用者把官方播放器排到後面：先用對應播放。
  const later = await priorityCore({ captureEnabled: true, captureControl: true, playPriority: ['youtube', 'official'] }, { ytRows: yt });
  assert.equal(await later.core.playMode('kkbox'), 'file');
  // 直接可播的來源不受影響。
  assert.equal(await on.core.playMode('ytmusic'), 'file');
  // 直接可播的來源不宣告即時播放的能力（Discord 的來源清單才不會把它們標成即時）。
  assert.equal('openLive' in makeProvider(on.core, 'ytmusic'), false);
  assert.equal('openLive' in makeProvider(on.core, 'local'), false);
  assert.equal(typeof makeProvider(on.core, 'apple').openLive, 'function');
  // 不能直接指定歌曲的播放器不能走官方播放器；Apple Music 可以，但這裡它沒開。
  assert.match(await on.core.officialBlocked('ytmusic'), /不能直接指定/);
  assert.match(await on.core.officialBlocked('apple'), /沒有在執行/);
  for (const x of [off, on, closed, later]) await x.core.dispose();
});

test('技能：內容讀得到、中繼資料正確；沒開啟時不提供', async () => {
  let on = true;
  const provider = createSkillProvider({ signal: undefined }, { isOn: () => on });
  const listed = await provider.list();
  assert.deepEqual(listed.candidates.map((c) => c.name), JUKEBOX_SKILLS);
  assert.equal(listed.candidates[0].provider, 'dsh-jukebox');
  const full = await provider.get(listed.candidates[0]);
  assert.match(full.content, /jukebox_player_play/);
  assert.match(full.content, /最多重試一次/);
  assert.doesNotMatch(full.content, /Amazon/);
  on = false;
  assert.deepEqual((await provider.list()).candidates, []);
  assert.equal(await provider.get(listed.candidates[0]), undefined);
  assert.throws(() => parseSkill('no frontmatter', 'x'), /缺少/);
  assert.throws(() => parseSkill('---\nname: x\ndescription: d\nextra: 1\n---\nbody', 'x'), /不正確/);
});

test('Apple Music 沒有系統媒體控制時按它視窗自己的按鈕，不送媒體鍵', async () => {
  const capture = fakeCapture({ running: { apple: true }, audible: true });
  const pressed = [];
  capture.appleMusicButton = async (name) => (pressed.push(name), name === 'toggle' && (capture.state.audible = !capture.state.audible), { ok: true, label: 'x' });
  const players = createPlayers({ capture, sources: fakeSources(), remote: {}, getConfig: () => ({}), wait: noWait });
  assert.equal((await players.status()).players.apple.control, 'window');
  const paused = await players.control('apple', 'pause');
  assert.deepEqual([paused.via, paused.verified], ['window', true]);
  assert.equal((await players.control('apple', 'next')).via, 'window');
  assert.deepEqual([pressed, capture.state.keys], [['toggle', 'next'], []]);
  capture.appleMusicButton = async () => ({ ok: false, error: 'disabled' });
  await assert.rejects(players.control('apple', 'previous'), (e) => e.code === 'WINDOW_OPERATION_FAILED' && /沒有可以/.test(e.message));
});

test('播放器裡沒有載入歌曲時，系統媒體控制的動作附上說明', async () => {
  const capture = fakeCapture({ sessions: [{ app: 'com.kkbox.electron-app', status: 'Stopped', title: '' }] });
  const players = createPlayers({ capture, sources: fakeSources(), remote: {}, getConfig: () => ({}), wait: noWait });
  assert.match((await players.control('kkbox', 'resume')).note, /沒有載入任何歌/);
  assert.equal((await players.control('kkbox', 'pause')).note, undefined);
});

test('用連結播放後停在暫停：補送一次播放', async () => {
  const sessions = [{ app: 'com.kkbox.electron-app', status: 'Paused', title: '告白氣球' }];
  const capture = fakeCapture({ sessions });
  const players = createPlayers({ capture, sources: fakeSources(), remote: { open: async () => ({ ok: true }) }, getConfig: () => ({}), wait: noWait });
  await players.start('kkbox', track);
  assert.deepEqual(capture.state.sessionActions, [['play', 'kkbox']]);
  sessions[0].status = 'Playing';
  await players.start('kkbox', track);
  assert.equal(capture.state.sessionActions.length, 1, '已經在播就不再送');
});


test('Spotify 沒登入：給歌曲連結或歌名都能播（用它自己的連結）', async () => {
  const capture = fakeCapture({ running: { spotify: true } });
  const links = [];
  const id = 'S'.repeat(22);
  const sources = fakeSources();
  sources.spotify.parseLink = (text) => {
    const m = /open\.spotify\.com\/track\/([A-Za-z0-9]{22})/.exec(text);
    return m ? { kind: 'track', id: m[1] } : null;
  };
  const players = createPlayers({ capture, sources, remote: { open: async (s, t) => (links.push([s, t]), (capture.state.audible = true), { ok: true }) }, getConfig: () => ({}), wait: noWait });
  const played = await players.play('spotify', { query: 'https://open.spotify.com/track/' + id + '?si=abc' });
  assert.deepEqual([played.via, played.started, links], ['link', true, [['spotify', 'spotify:track:' + id]]]);
  // 給歌名：交給來源自己的搜尋（沒登入時來源會用 Spotify 桌面版的搜尋），拿到的第一首用連結播。
  const byName = await players.play('spotify', { query: '周杰倫 晴天' });
  assert.deepEqual([byName.via, byName.track.title, links.length], ['link', 'Song', 2]);
});
