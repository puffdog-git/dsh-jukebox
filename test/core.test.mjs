// 音樂庫、金鑰、各來源（假的 fetch）、核心流程與 Discord 登記。全部不連網。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCore } from '../lib/core.js';
import { createDiscordLink, findDiscordHost } from '../lib/discord-link.js';
import { createLibrary } from '../lib/library.js';
import { createSecrets } from '../lib/secrets.js';
import { createApple } from '../lib/sources/apple.js';
import { createKkbox } from '../lib/sources/kkbox.js';
import { createSpotify } from '../lib/sources/spotify.js';
import { createYtdlp } from '../lib/ytdlp.js';

const temp = () => mkdtemp(join(tmpdir(), 'jukebox-test-'));
const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

async function musicDir() {
  const dir = await temp();
  await mkdir(join(dir, 'music', 'sub'), { recursive: true });
  await writeFile(join(dir, 'music', '周杰倫 - 晴天.mp3'), 'aaaa');
  await writeFile(join(dir, 'music', 'sub', '02. 彩虹.flac'), 'bbbbbb');
  await writeFile(join(dir, 'music', 'notes.txt'), 'x');
  return dir;
}
const fakeParse = async (file) => (file.endsWith('.flac') ? { title: '彩虹', artist: '周杰倫', album: '我很忙', duration: 264, trackNo: 2 } : Promise.reject(Error('no tags')));

test('音樂庫：掃描、沿用沒變的檔案、搜尋、路徑檢查', async () => {
  const dir = await musicDir();
  let folders = [join(dir, 'music')];
  let parsed = 0;
  const lib = createLibrary({ file: join(dir, 'library.json'), getFolders: () => folders, parse: (f) => (parsed++, fakeParse(f)) });
  const first = await lib.scan();
  assert.equal(first.ok, true);
  assert.equal(first.count, 2, '只收音樂檔');
  assert.equal(first.unreadable, 1, '讀不出標籤的檔案仍然收錄，改用檔名');
  const all = (await lib.search('')).tracks;
  assert.deepEqual(all.map((t) => t.title).sort(), ['彩虹', '晴天']);
  assert.equal((await lib.search('周杰倫 晴天')).tracks[0].artist, '周杰倫');
  assert.equal((await lib.search('不存在')).total, 0);
  // 第二次掃描不重讀沒變的檔案。
  parsed = 0;
  assert.equal((await lib.scan()).changed, 0);
  assert.equal(parsed, 0);
  // 重新載入後還在。
  const again = createLibrary({ file: join(dir, 'library.json'), getFolders: () => folders, parse: fakeParse });
  assert.equal((await again.status()).count, 2);
  const id = all[0].id;
  assert.match((await lib.pathOf(id)).type, /^audio\//);
  // 資料夾從設定拿掉後，舊的曲目 ID 不能再讀到檔案。
  folders = [];
  await assert.rejects(lib.pathOf(id), /不在目前設定/);
  await assert.rejects(lib.pathOf('nope'), /沒有這首歌/);
  // 存檔裡不該被外部看到的東西：view 不含路徑。
  assert.equal('path' in all[0], false);
});

test('金鑰：加密後存檔、狀態只回報有沒有填、可清除', async () => {
  const dir = await temp();
  const file = join(dir, 'secrets.json');
  const protect = async (b) => Buffer.from(b.toString('utf8').split('').reverse().join(''));
  const unprotect = protect;
  const s = createSecrets({ file, platform: 'win32', protect, unprotect });
  await s.set({ kkboxId: 'my-id', kkboxSecret: 'my-secret' });
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('my-secret'), '檔案裡沒有明文');
  assert.deepEqual((await s.status()).has.kkboxSecret, true);
  assert.ok(!JSON.stringify(await s.status()).includes('my-secret'));
  const reloaded = createSecrets({ file, platform: 'win32', protect, unprotect });
  assert.equal(await reloaded.get('kkboxSecret'), 'my-secret');
  await reloaded.set({ kkboxId: '', kkboxSecret: '' });
  await assert.rejects(readFile(file, 'utf8'), /ENOENT/);
  await assert.rejects(s.set({ kkboxId: 'x'.repeat(500) }), /太長/);
  // 解不開時回報錯誤，不當掉。
  await s.set({ kkboxId: 'a' });
  const broken = createSecrets({ file, platform: 'win32', protect, unprotect: async () => Promise.reject(Error('no')) });
  assert.match((await broken.status()).error, /解不開/);
});

test('Spotify：用更新權杖換存取權杖、搜尋、歌單走新的 /items 端點', async () => {
  const secrets = createSecrets({ platform: 'linux' });
  await secrets.set({ spotifyRefresh: 'refresh-1' });
  const calls = [];
  const track = (id, name) => ({ id, name, type: 'track', duration_ms: 200000, artists: [{ name: 'A' }], album: { name: 'Al' } });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.authorization, body: init.body ? String(init.body) : '' });
    if (String(url).includes('/api/token')) return json({ access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-2' });
    if (String(url).includes('/search')) return json({ tracks: { items: [track('1'.repeat(22), 'Song'), { id: 'bad' }] } });
    if (String(url).includes('/playlists/' + 'p'.repeat(22) + '/items')) return json({ items: [{ item: track('2'.repeat(22), 'In list') }, { item: { id: '3'.repeat(22), type: 'episode' } }] });
    if (String(url).includes('/me/player/play')) return json({ error: { status: 403, reason: 'PREMIUM_REQUIRED', message: 'Premium required' } }, 403);
    return json({}, 404);
  };
  const sp = createSpotify({ getConfig: () => ({ spotifyClientId: 'client', spotifyLoginPort: 43917, territory: 'TW' }), secrets, fetchImpl });
  const rows = await sp.search('song');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].duration, 200);
  assert.match(calls[0].body, /grant_type=refresh_token/);
  assert.ok(!calls[0].body.includes('client_secret'));
  assert.equal(calls[1].auth, 'Bearer access-1');
  assert.match(calls[1].url, /limit=10/);
  assert.equal(await secrets.get('spotifyRefresh'), 'refresh-2', '換到新的更新權杖要存起來');
  const list = await sp.playlistTracks('p'.repeat(22));
  assert.deepEqual(list.tracks.map((t) => t.title), ['In list']);
  await assert.rejects(sp.remote.play('1'.repeat(22)), /Premium/);
  await assert.rejects(sp.track('../../me'), /格式/);
  assert.equal(calls.filter((c) => c.url.includes('/api/token')).length, 1, '權杖有效期間不重複換');
});

test('Spotify 登入：PKCE、state 不對的回呼不理、完成後存權杖並關閉接口', async () => {
  const secrets = createSecrets({ platform: 'linux' });
  let handler;
  let closed = false;
  const listen = (h) => ((handler = h), { once() {}, listen: (_p, _h, cb) => cb(), close: () => (closed = true) });
  const tokenBodies = [];
  const fetchImpl = async (_url, init) => (tokenBodies.push(String(init.body)), json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 }));
  const sp = createSpotify({ getConfig: () => ({ spotifyClientId: 'client', spotifyLoginPort: 43917, territory: 'TW' }), secrets, fetchImpl, listen });
  const { url, redirectUri } = await sp.beginLogin();
  const params = new URL(url).searchParams;
  assert.equal(redirectUri, 'http://127.0.0.1:43917/callback');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.ok(params.get('code_challenge').length >= 43);
  const hit = (query) => new Promise((resolve) => handler({ url: '/callback?' + query }, { writeHead() {}, end: (text) => resolve(String(text)) }));
  assert.match(await hit('code=abc&state=wrong'), /失效/);
  assert.equal(tokenBodies.length, 0);
  assert.equal((await sp.status()).loginPending, true);
  assert.match(await hit('code=abc&state=' + params.get('state')), /登入完成/);
  assert.match(tokenBodies[0], /code_verifier=/);
  assert.equal(await secrets.get('spotifyRefresh'), 'r');
  assert.equal(closed, true);
  assert.equal((await sp.status()).loggedIn, true);
  await sp.logout();
  assert.equal(await secrets.get('spotifyRefresh'), '');
});

test('KKBOX 與 Apple：回傳整理成同一種曲目格式', async () => {
  const secrets = createSecrets({ platform: 'linux' });
  await secrets.set({ kkboxId: 'id', kkboxSecret: 'sec' });
  const kk = createKkbox({
    getConfig: () => ({ territory: 'TW' }),
    secrets,
    fetchImpl: async (url, init) => {
      if (String(url).includes('oauth2/token')) return (assert.match(init.headers.authorization, /^Basic /), json({ access_token: 't', expires_in: 3600 }));
      assert.match(String(url), /territory=TW/);
      return json({ tracks: { data: [{ id: 'Gq5EJ8C3mXkSQhTrl', name: '晴天', duration: 269000, url: 'https://www.kkbox.com/tw/tc/song/Gq5EJ8C3mXkSQhTrl', album: { name: '葉惠美', artist: { name: '周杰倫' } } }] } });
    },
  });
  assert.deepEqual(await kk.search('晴天'), [{ id: 'Gq5EJ8C3mXkSQhTrl', title: '晴天', artist: '周杰倫', album: '葉惠美', duration: 269, url: 'https://www.kkbox.com/tw/tc/song/Gq5EJ8C3mXkSQhTrl' }]);
  // 沒填金鑰：改用 KKBOX 公開網站的搜尋頁（只有最符合的一首），同一個關鍵字用快取；被擋時說明原因並停止再查。
  const page = '<html>' + 'x'.repeat(2100) + '<song-li data-id="Kn9Aw92cKmKv6tCogT" data-duration="3:35" data-lyrics="true"> <a slot="song-name" title="告白氣球 &amp; 測試" href="https://www.kkbox.com/tw/tc/song/Kn9Aw92cKmKv6tCogT">x</a> <a slot="album-name" title="周杰倫的床邊故事" href="#">x</a> <a slot="artist-name" href="#" title="周杰倫 (Jay Chou)">x</a></song-li></html>';
  let webCalls = 0;
  let webStatus = 200;
  const web = createKkbox({
    getConfig: () => ({ territory: 'TW' }),
    secrets: createSecrets({ platform: 'linux' }),
    fetchImpl: async (url) => (webCalls++, assert.match(String(url), /^https:\/\/www\.kkbox\.com\/tw\/tc\/search\?q=/), { ok: webStatus === 200, status: webStatus, text: async () => (webStatus === 200 ? page : '') }),
  });
  const found = await web.search('周杰倫 告白氣球');
  assert.deepEqual(found, [{ id: 'Kn9Aw92cKmKv6tCogT', title: '告白氣球 & 測試', artist: '周杰倫 (Jay Chou)', album: '周杰倫的床邊故事', duration: 215, url: 'https://www.kkbox.com/tw/tc/song/Kn9Aw92cKmKv6tCogT' }]);
  await web.search('周杰倫 告白氣球');
  assert.equal(webCalls, 1, '同一個關鍵字用快取');
  assert.equal((await web.track('Kn9Aw92cKmKv6tCogT')).title, '告白氣球 & 測試', '搜尋看過的歌可以直接取資料');
  assert.equal(web.playLink('Kn9Aw92cKmKv6tCogT'), 'kkbox://song/Kn9Aw92cKmKv6tCogT#play');
  assert.equal(web.playLink('../x'), '');
  await assert.rejects(web.track('AAAAAAAAAAAAAAAAAA'), (e) => e.code === 'NOT_CONFIGURED');
  webStatus = 202;
  await assert.rejects(web.search('別首歌'), (e) => e.rateLimited === true && /擋下了搜尋/.test(e.message));
  await assert.rejects(web.search('再一首'), (e) => e.rateLimited === true);
  assert.equal(webCalls, 2, '被擋之後五分鐘內不再送請求');

  const apple = createApple({
    getConfig: () => ({ territory: 'TW' }),
    secrets: createSecrets({ platform: 'linux' }),
    fetchImpl: async (url) => (assert.match(String(url), /country=TW/), json({ results: [{ wrapperType: 'track', kind: 'song', trackId: 535824738, trackName: '晴天', artistName: '周杰倫', collectionName: '葉惠美', trackTimeMillis: 269660, trackViewUrl: 'https://music.apple.com/tw/album/x/1?i=535824738' }, { wrapperType: 'track', kind: 'music-video', trackId: 9 }] })),
  });
  const rows = await apple.search('晴天');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '535824738');
  assert.equal(rows[0].duration, 270);
  await assert.rejects(apple.playlistTracks('pl.u-abc123'), (e) => e.code === 'NOT_CONFIGURED');
});

test('yt-dlp：找執行檔、搜尋合併兩種結果、不接受奇怪的 ID', async () => {
  const dir = await temp();
  const runs = [];
  const run = async (bin, args) => {
    runs.push(args);
    if (args[0] === '--version') return bin.includes('yt-dlp') ? { stdout: '2026.10.26\n' } : Promise.reject(Error('nope'));
    const url = args.at(-1);
    if (url.includes('music.youtube.com/search')) return { stdout: JSON.stringify({ entries: [{ id: 'aaaaaaaaaaa', title: '晴天' }] }) };
    if (url.includes('youtube.com/results')) return { stdout: JSON.stringify({ entries: [{ id: 'bbbbbbbbbbb', title: '周杰倫 晴天 MV', channel: '周杰倫', duration: 319 }, { id: 'aaaaaaaaaaa', title: 'dup' }, { id: 'ccccccccccc', title: 'live', is_live: true }, { id: 'RDxx', title: 'mix' }] }) };
    if (url.includes('watch?v=aaaaaaaaaaa')) return { stdout: JSON.stringify({ track: '晴天', artists: ['周杰倫'], duration: 270.2 }) };
    return Promise.reject(Object.assign(Error('x'), { stderr: 'ERROR: boom' }));
  };
  const yt = createYtdlp({ getConfig: () => ({}), cacheDir: dir, run, env: {}, home: dir, platform: 'linux' });
  const rows = await yt.search('周杰倫 晴天');
  assert.deepEqual(rows.map((r) => r.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.deepEqual(rows[0], { id: 'aaaaaaaaaaa', title: '晴天', artist: '周杰倫', duration: 270 });
  assert.ok(runs.every((a) => a[0] === '--version' || a.includes('--ignore-config')));
  await assert.rejects(yt.fetch('../../etc/passwd'), /有效的 YouTube/);
  await assert.rejects(yt.playlist('x; rm -rf'), /格式/);
  const missing = createYtdlp({ getConfig: () => ({}), cacheDir: dir, run: async () => Promise.reject(Error('no')), env: {}, home: dir, platform: 'linux' });
  await assert.rejects(missing.search('x'), (e) => e.code === 'NO_YTDLP');
});

test('bilibili：搜尋只回編號所以逐筆查資料、多分 P 只留 BV、下載只取第一段', async () => {
  const dir = await temp();
  const runs = [];
  const run = async (_bin, args) => {
    runs.push(args);
    if (args[0] === '--version') return { stdout: '2026.10.26\n' };
    const last = args.at(-1);
    if (last.startsWith('bilisearch')) return { stdout: JSON.stringify({ entries: [{ id: '55185686' }, { id: '999' }, { id: 'weird id' }, { id: '777' }] }) };
    if (last.endsWith('/av55185686')) return { stdout: JSON.stringify({ id: 'BV1d4411N7zD', title: '周杰伦 - 晴天MV', uploader: 'UP主', duration: 317.4 }) };
    if (last.endsWith('/av999')) return { stdout: JSON.stringify({ entries: [{ id: 'BV1xx411c7mD_p1', title: '合集 p1', uploader: 'UP2', duration: 200 }] }) };
    if (last.endsWith('/av777')) return { stdout: JSON.stringify({ id: 'BV1yy411c7mE', title: '兩小時合集', duration: 7200 }) };
    if (args.includes('bestaudio/best')) return (await writeFile(args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a'), 'biliaudio'), { stdout: '' });
    return Promise.reject(Error('unexpected ' + last));
  };
  const yt = createYtdlp({ getConfig: () => ({}), cacheDir: dir, run, env: {}, home: dir, platform: 'linux' });
  const rows = await yt.biliSearch('周杰伦 晴天');
  assert.deepEqual(rows, [
    { id: 'BV1d4411N7zD', title: '周杰伦 - 晴天MV', artist: 'UP主', duration: 317 },
    { id: 'BV1xx411c7mD', title: '合集 p1', artist: 'UP2', duration: 200 },
  ]);
  assert.match(runs.find((a) => a.at(-1).startsWith('bilisearch')).at(-1), /^bilisearch6:周杰伦 晴天$/);
  const file = await yt.biliFetch('BV1d4411N7zD');
  assert.match(file.path, /bili-BV1d4411N7zD\.m4a$/);
  const dl = runs.find((a) => a.includes('bestaudio/best'));
  assert.deepEqual(dl.slice(-3), ['--playlist-items', '1', 'https://www.bilibili.com/video/BV1d4411N7zD']);
  const before = runs.length;
  await yt.biliFetch('BV1d4411N7zD');
  assert.equal(runs.length, before, '快取裡有就不重新下載');
  await assert.rejects(yt.biliFetch('BV1; rm -rf /'), /有效的 bilibili/);
  // CDN 第一次回錯誤時會自動重試；一直失敗就在第三次放棄並說明原因。
  let fails = 2;
  const flaky = createYtdlp({ getConfig: () => ({}), cacheDir: await temp(), env: {}, home: dir, platform: 'linux', retryDelayMs: 1, run: async (bin, args) => (args.includes('bestaudio/best') && fails-- > 0 ? Promise.reject(Object.assign(Error('x'), { stderr: 'ERROR: HTTP Error 567' })) : run(bin, args)) });
  assert.match((await flaky.biliFetch('BV1d4411N7zD')).path, /\.m4a$/);
  let tries = 0;
  const dead = createYtdlp({ getConfig: () => ({}), cacheDir: await temp(), env: {}, home: dir, platform: 'linux', retryDelayMs: 1, run: async (bin, args) => (args.includes('bestaudio/best') ? (tries++, Promise.reject(Object.assign(Error('x'), { stderr: 'ERROR: HTTP Error 567' }))) : run(bin, args)) });
  await assert.rejects(dead.biliFetch('BV1d4411N7zD'), /bilibili 讀取失敗：HTTP Error 567/);
  assert.equal(tries, 3);
  await assert.rejects(yt.biliInfo('https://evil.example'), /有效的 bilibili/);
  // 被 bilibili 流量管制（HTTP 412）時說明原因，而且不重試。
  let limitedRuns = 0;
  const limitedRun = async (bin, args) => (args[0] === '--version' ? { stdout: '1\n' } : (limitedRuns++, Promise.reject(Object.assign(Error('x'), { stderr: 'ERROR: Unable to download JSON metadata: HTTP Error 412: Precondition Failed' }))));
  const limited = createYtdlp({ getConfig: () => ({}), cacheDir: await temp(), env: {}, home: dir, platform: 'linux', retryDelayMs: 1, run: limitedRun });
  await assert.rejects(limited.biliSearch('x'), /暫時限制.*412/);
  limitedRuns = 0;
  await assert.rejects(limited.biliFetch('BV1d4411N7zD'), /暫時限制/);
  assert.equal(limitedRuns, 1, '被管制時不重試');
});

test('bilibili 音頻區：單曲、歌單、熱門歌單、短網址只接受轉到 bilibili', async () => {
  const { createBilibili } = await import('../lib/sources/bilibili.js');
  const song = (id, title) => ({ id, title, author: '歌手', uname: 'UP', duration: 200 });
  const bili = createBilibili({
    fetchImpl: async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://b23.tv/good')) return { headers: { get: () => 'https://www.bilibili.com/audio/au15664?share=1' } };
      if (u.startsWith('https://b23.tv/evil')) return { headers: { get: () => 'https://evil.example/video/BV1d4411N7zD' } };
      assert.equal(init.redirect, undefined);
      if (u.includes('/song/info?sid=15664')) return json({ code: 0, data: song(15664, '威风堂堂') });
      if (u.includes('/song/info')) return json({ code: 4511001, data: null });
      if (u.includes('/menu/info')) return json({ code: 0, data: { title: '新曲推荐' } });
      if (u.includes('/song/of-menu')) return json({ code: 0, data: { pageCount: 1, data: [song(1, 'A'), { id: 'bad' }, song(2, 'B')] } });
      if (u.includes('/menu/hit')) return json({ code: 0, data: { data: [{ menuId: 10624, title: '新曲推荐' }, { menuId: 'x' }] } });
      return json({}, 500);
    },
  });
  assert.deepEqual(await bili.audio('au15664'), { id: 'au15664', title: '威风堂堂', artist: '歌手', duration: 200, url: 'https://www.bilibili.com/audio/au15664' });
  await assert.rejects(bili.audio('au999'), /找不到或已下架/);
  await assert.rejects(bili.audio('15664'), /格式/);
  const menu = await bili.menuSongs('am10624');
  assert.equal(menu.title, '新曲推荐');
  assert.deepEqual(menu.tracks.map((t) => t.id), ['au1', 'au2']);
  assert.deepEqual(await bili.hitMenus(), [{ id: 'am10624', name: '新曲推荐' }]);
  assert.deepEqual(await bili.resolveShort('good'), { kind: 'track', id: 'au15664' });
  await assert.rejects(bili.resolveShort('evil'), /不是影片/);
});

async function fakeCore({ ytRows = [], appleTrack } = {}) {
  const dir = await musicDir();
  const cache = join(dir, 'yt.webm');
  await writeFile(cache, 'ytaudio');
  const fetched = [];
  const core = await createCore({
    dir: join(dir, 'data'),
    overrides: {
      secrets: createSecrets({ platform: 'linux' }),
      library: createLibrary({ file: join(dir, 'library.json'), getFolders: () => [join(dir, 'music')], parse: fakeParse }),
      ytdlp: { probe: async () => ({}), ready: () => true, status: () => ({ found: true, version: 'test' }), search: async () => ytRows, fetch: async (id) => (fetched.push(id), { path: cache, size: 7 }), playlist: async () => ({ title: 'L', entries: ytRows }) },
      apple: { parseLink: () => null, configured: async () => true, status: async () => ({}), search: async () => [appleTrack], track: async () => appleTrack },
      remote: { open: async (source, target) => ({ ok: true, opened: target }) },
    },
  });
  await core.store.setConfig({ libraryFolders: [join(dir, 'music')], enabledSources: ['local', 'ytmusic', 'apple'] });
  await core.library.scan();
  await core.refreshUsable();
  return { core, fetched, dir };
}

test('核心：對應播放先找本地音樂庫，找不到才找 YouTube，結果會記住', async () => {
  const { core, fetched } = await fakeCore({
    ytRows: [{ id: 'yyyyyyyyyyy', title: '稻香', artist: '周杰倫', duration: 223 }],
    appleTrack: { id: '111111', title: '彩虹', artist: '周杰倫', duration: 264, url: 'https://music.apple.com/tw/album/x/1?i=111111' },
  });
  const local = await core.resolve('apple', '111111');
  assert.equal(local.kind, 'local');
  const bytes = await core.audioBytes('apple', '111111');
  assert.equal(bytes.toString(), 'bbbbbb', '播的是本地音樂庫的檔案');
  assert.equal(fetched.length, 0);
  assert.equal((await core.status()).matches, 1);
  await assert.rejects(core.search('spotify', 'x'), /沒有啟用/);
  await assert.rejects(core.search('nope', 'x'), /沒有這個來源/);
  assert.match((await core.openInApp('apple', { id: '111111' })).opened, /^https:\/\/music\.apple\.com\//);
  await core.dispose();
});

test('核心：本地沒有時用 YouTube；都對不上就說找不到，不亂播', async () => {
  const appleTrack = { id: '222222', title: '稻香', artist: '周杰倫', duration: 223 };
  const hit = await fakeCore({ ytRows: [{ id: 'yyyyyyyyyyy', title: '稻香', artist: '周杰倫', duration: 223 }], appleTrack });
  const r = await hit.core.resolve('apple', '222222');
  assert.deepEqual([r.kind, r.id], ['yt', 'yyyyyyyyyyy']);
  assert.equal((await hit.core.audioBytes('apple', '222222')).toString(), 'ytaudio');
  const file = await hit.core.audioFile('ytmusic', 'yyyyyyyyyyy');
  assert.equal(file.type, 'audio/webm');
  await hit.core.dispose();

  const miss = await fakeCore({ ytRows: [{ id: 'zzzzzzzzzzz', title: '完全不同的歌', artist: '別人', duration: 100 }], appleTrack });
  await assert.rejects(miss.core.resolve('apple', '222222'), (e) => e.code === 'NO_MATCH');
  assert.equal(miss.fetched.length, 0);
  await miss.core.dispose();
});

test('Discord 登記：照 Discord 的接口提供 search 與 load；停用、關閉、重新載入都處理', async () => {
  const { core } = await fakeCore({ ytRows: [{ id: 'yyyyyyyyyyy', title: '稻香', artist: '周杰倫', duration: 223 }], appleTrack: { id: '222222', title: '稻香', artist: '周杰倫', duration: 223 } });
  const makeHost = () => {
    const providers = new Map();
    return { providers, version: '1.0.6', registerMusicProvider: (p) => (providers.set(p.id, p), () => providers.delete(p.id)) };
  };
  const root = { __DSH_DISCORD_PYSELF_LAB__: makeHost() };
  let on = true;
  const link = createDiscordLink({ core, ctx: {}, isOn: () => on, root });
  link.sync();
  const host = root.__DSH_DISCORD_PYSELF_LAB__;
  assert.deepEqual([...host.providers.keys()].sort(), ['jukebox-apple', 'jukebox-local', 'jukebox-ytmusic']);
  const apple = host.providers.get('jukebox-apple');
  assert.equal(apple.available(), true);
  const rows = await apple.search('稻香', { signal: AbortSignal.timeout(5000) });
  assert.deepEqual(Object.keys(rows[0]).sort(), ['artist', 'id', 'title']);
  const audio = await apple.load(rows[0].id, { signal: AbortSignal.timeout(5000) });
  assert.ok(audio instanceof Uint8Array && audio.length > 0 && audio.length <= 64 * 1024 * 1024);
  // 關掉某個來源 → 取消那一個的登記。
  await core.store.setConfig({ enabledSources: ['local'] });
  link.sync();
  assert.deepEqual([...host.providers.keys()], ['jukebox-local']);
  // Discord 插件重新載入（換了一個新的入口物件）→ 重新登記。
  root.__DSH_DISCORD_PYSELF_LAB__ = makeHost();
  link.sync();
  assert.deepEqual([...root.__DSH_DISCORD_PYSELF_LAB__.providers.keys()], ['jukebox-local']);
  // 關掉登記 → 全部撤掉。
  on = false;
  link.sync();
  assert.equal(root.__DSH_DISCORD_PYSELF_LAB__.providers.size, 0);
  assert.equal(link.status().found, false);
  // 沒有 Discord 插件時安靜地什麼都不做。
  assert.equal(findDiscordHost({}, {}), null);
  link.dispose();
  await core.dispose();
});

test('Spotify 沒登入：公開頁面讀得到單曲、專輯、歌單；歌名搜尋會說明要貼連結', async () => {
  const { createSpotify } = await import('../lib/sources/spotify.js');
  const page = (entity) => '<html><script id="__NEXT_DATA__" type="application/json">' + JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } }) + '</script></html>';
  const id = 'A'.repeat(22), other = 'B'.repeat(22);
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/embed/track/' + id)) return new Response(page({ name: '晴天', artists: [{ name: '周杰倫' }], duration: 269000, uri: 'spotify:track:' + id }));
    if (String(url).includes('/embed/album/')) return new Response(page({ name: '葉惠美', trackList: [{ uri: 'spotify:track:' + id, title: '晴天', subtitle: '周杰倫', duration: 269000 }, { uri: 'spotify:episode:x', title: '不是歌' }] }));
    if (String(url).includes('/embed/playlist/')) return new Response(page({ name: '清單', trackList: [{ uri: 'spotify:track:' + other, title: 'B', subtitle: 'X', duration: 1000 }] }));
    return new Response('nope', { status: 404 });
  };
  const spotify = createSpotify({ getConfig: () => ({ spotifyClientId: '', spotifyLoginPort: 1, territory: 'TW' }), secrets: { get: async () => '', status: async () => ({ has: {} }) }, fetchImpl });
  assert.deepEqual(await spotify.track(id), { id, title: '晴天', artist: '周杰倫', album: '', duration: 269, url: 'https://open.spotify.com/track/' + id });
  await spotify.track(id);
  assert.equal(seen.length, 1, '同一首十分鐘內不重複讀');
  const album = await spotify.albumTracks(id);
  assert.deepEqual([album.title, album.tracks.length, album.tracks[0].album], ['葉惠美', 1, '葉惠美']);
  assert.equal((await spotify.playlistTracks(other)).tracks[0].id, other);
  await assert.rejects(spotify.search('晴天'), (e) => e.code === 'SPOTIFY_LINK_ONLY' && /連結/.test(e.message));
  // 接上桌面版搜尋之後：有結果就用它，沒開（回 null）才回報原因。
  spotify.desktopSearch = async (q, { limit }) => [{ id, title: q + ':' + limit, artist: 'X', album: '', duration: 0, url: 'u' }];
  assert.equal((await spotify.search('晴天', { limit: 3 }))[0].title, '晴天:3');
  spotify.desktopSearch = async () => null;
  await assert.rejects(spotify.search('晴天'), (e) => e.code === 'SPOTIFY_LINK_ONLY');
  await assert.rejects(spotify.track(other), /沒有這個連結/);
  assert.ok(seen.every((u) => u.startsWith('https://open.spotify.com/embed/')), '只讀公開的嵌入頁');
});
