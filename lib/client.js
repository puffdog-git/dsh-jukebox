// dsh-jukebox 設定頁與播放器。直接手寫、沒有建置步驟。
window.__ModuleLoader__.load({
  id: 'dsh-jukebox',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;
    const API = '/dsh-jukebox';
    const NAMES = { local: '本地音樂庫', ytmusic: 'YT Music', bilibili: 'bilibili', spotify: 'Spotify', kkbox: 'KKBOX', apple: 'Apple Music' };
    const ORDER = ['local', 'ytmusic', 'bilibili', 'spotify', 'kkbox', 'apple'];
    const DIRECT = ['local', 'ytmusic', 'bilibili'];
    const PLAY_METHODS = ['official', 'platform', 'youtube', 'local'];
    const PLAY_LABELS = {
      official: ['指定的平台，用官方播放器播放', '叫你電腦上的 Spotify、KKBOX 或 Apple Music 播那首歌，並即時轉送到 Discord。音源就是官方的那一版。'],
      platform: ['指定的平台，用它自己可下載的音訊', 'YT Music、bilibili 與本地音樂庫本來就是這樣播；有 DRM 的平台沒有這一種。'],
      youtube: ['到 YouTube 找同一首', '用歌名、歌手與長度比對，找不到夠像的就不播。'],
      local: ['在本地音樂庫找同一首', '音樂庫裡有同一首就用你自己的檔案。'],
    };

    async function api(path, body) {
      const response = await fetch(API + path, {
        credentials: 'same-origin',
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch {}
      if (!response.ok || payload?.ok === false) throw new Error(payload?.error || 'HTTP ' + response.status);
      return payload;
    }
    const clock = (s) => (s > 0 ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '');
    const keyOf = (t) => t.source + ':' + t.id;

    const CSS = `
.jb{--jb-accent:var(--dsw-alias-brand-primary,#4d6bfe);--jb-line:var(--dsw-alias-border-l2,#8b9c9a35);--jb-soft:color-mix(in srgb,currentColor 6%,transparent);
  container-type:inline-size;color:inherit;font-size:14px;line-height:1.6;display:flex;flex-direction:column;gap:14px;min-width:0}
.jb *{box-sizing:border-box}
.jb h2{font-size:17px;margin:0;font-weight:650}
.jb h3{font-size:14px;margin:0;font-weight:650}
.jb p{margin:0}
.jb-muted{opacity:.68;font-size:12.5px}
.jb-btn{font:inherit;color:inherit;border:1px solid var(--jb-line);background:transparent;border-radius:8px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.jb-btn:hover:not(:disabled){background:var(--jb-soft)}
.jb-btn:disabled{opacity:.45;cursor:not-allowed}
.jb-btn:focus-visible,.jb-tab:focus-visible,.jb-input:focus-visible,.jb-chip:focus-visible{outline:2px solid var(--jb-accent);outline-offset:2px}
.jb-btn.primary{background:var(--jb-accent);border-color:var(--jb-accent);color:#fff;font-weight:600}
.jb-btn.small{padding:2px 9px;font-size:12.5px}
.jb-warn{border:1px solid #d9892b88;background:#d9892b1a;border-radius:8px;padding:8px 12px;font-size:13px}
.jb-bad{border-color:#d0453f88;background:#d0453f1a}
.jb-tabs{display:flex;gap:2px;border-bottom:1px solid var(--jb-line);overflow-x:auto}
.jb-tab{font:inherit;color:inherit;background:none;border:0;border-bottom:2px solid transparent;padding:7px 12px;cursor:pointer;opacity:.7;white-space:nowrap}
.jb-tab[aria-selected=true]{opacity:1;border-bottom-color:var(--jb-accent);font-weight:600}
.jb-card{border:1px solid var(--jb-line);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.jb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0}
.jb-grow{flex:1 1 160px;min-width:0}
.jb-input{font:inherit;color:inherit;background:transparent;border:1px solid var(--jb-line);border-radius:8px;padding:5px 9px;min-width:0}
textarea.jb-input{width:100%;min-height:74px;font-family:ui-monospace,monospace;font-size:12px;resize:vertical}
.jb-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.jb-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.jb-field>span{font-size:13px;font-weight:550}
.jb-field .jb-input{width:100%}
.jb-check{display:flex;gap:8px;align-items:flex-start;cursor:pointer}
.jb-check input{margin-top:4px;flex:none}
.jb-chips{display:flex;flex-wrap:wrap;gap:6px}
.jb-chip{font:inherit;color:inherit;background:none;border:1px solid var(--jb-line);border-radius:999px;padding:2px 11px;font-size:13px;cursor:pointer}
.jb-chip[aria-pressed=true]{border-color:var(--jb-accent);background:color-mix(in srgb,var(--jb-accent) 12%,transparent);font-weight:600}
.jb-chip:disabled{opacity:.45;cursor:not-allowed}
.jb-badge{display:inline-block;font-size:11.5px;border:1px solid var(--jb-line);border-radius:999px;padding:0 7px;white-space:nowrap}
.jb-badge.ok{border-color:#2f9e6b88;color:#2f9e6b}
.jb-badge.no{border-color:#d9892b88;color:#d9892b}
.jb-list{display:flex;flex-direction:column;min-width:0}
.jb-track{display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px dashed var(--jb-line);min-width:0}
.jb-track:last-child{border-bottom:0}
.jb-track[data-current=true] .jb-title{color:var(--jb-accent);font-weight:650}
.jb-meta{flex:1 1 0;min-width:0}
.jb-title,.jb-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jb-sub{font-size:12.5px;opacity:.68}
.jb-time{font-size:12.5px;opacity:.6;font-variant-numeric:tabular-nums;flex:none}
.jb-actions{display:flex;gap:4px;flex:none}
.jb-now{border:1px solid var(--jb-line);border-radius:12px;padding:12px 14px;background:var(--jb-soft);display:flex;flex-direction:column;gap:8px}
.jb-now audio{width:100%;height:36px}
.jb-code{font-family:ui-monospace,monospace;font-size:12.5px;border:1px solid var(--jb-line);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere;user-select:all}
.jb-steps{margin:0;padding-left:20px;font-size:13px;display:flex;flex-direction:column;gap:3px}
.jb-savebar{position:sticky;bottom:10px;z-index:2;align-self:flex-end;display:flex;gap:10px;align-items:center;width:fit-content;max-width:100%;padding:5px 6px 5px 14px;border:1px solid var(--jb-line);border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-base,Canvas) 86%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 4px 18px rgba(0,0,0,.16);font-size:13px}
.jb-savebar.toast{padding:6px 14px}
.jb-savebar .jb-btn.primary{border-radius:999px;padding:5px 16px}
.jb-details>summary{cursor:pointer;font-size:13px;font-weight:550;list-style-position:inside}
.jb-details>summary:focus-visible{outline:2px solid var(--jb-accent);outline-offset:2px}
.jb-details[open]>summary{margin-bottom:10px}
.jb-details{display:flex;flex-direction:column}
.jb-details>*+*{margin-top:10px}
@container (max-width:440px){.jb-track{flex-wrap:wrap}.jb-meta{flex-basis:100%}.jb-actions{margin-left:auto}}
`;

    function Field({ label, hint, children }) {
      return h('label', { className: 'jb-field' }, h('span', null, label), children, hint ? h('span', { className: 'jb-muted' }, hint) : null);
    }
    function Check({ label, hint, checked, onChange, ...rest }) {
      return h('label', { className: 'jb-check' }, h('input', { type: 'checkbox', checked: !!checked, onChange: (e) => onChange(e.target.checked), ...rest }),
        h('span', null, label, hint ? h('span', { className: 'jb-muted', style: { display: 'block' } }, hint) : null));
    }
    function Badge({ ok, children }) {
      return h('span', { className: 'jb-badge ' + (ok ? 'ok' : 'no') }, children);
    }

    function Panel() {
      const [status, setStatus] = useState(null);
      const [draft, setDraft] = useState(null);
      const [tab, setTab] = useState('play');
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState('');
      const dirty = useRef(false);
      // 播放器
      const [queue, setQueue] = useState([]);
      const [index, setIndex] = useState(-1);
      const [playState, setPlayState] = useState(''); // ''｜loading｜playing｜paused｜error
      const [resolved, setResolved] = useState(null);
      const audio = useRef(null);
      // 找歌
      const [source, setSource] = useState('local');
      const [query, setQuery] = useState('');
      const [results, setResults] = useState(null); // { title, tracks, note }
      const [linkText, setLinkText] = useState('');
      const [playlists, setPlaylists] = useState(null);
      // 音樂庫
      const [lib, setLib] = useState({ q: '', offset: 0, total: 0, tracks: null });
      const [folder, setFolder] = useState('');
      // 帳號
      const [secrets, setSecrets] = useState({});
      const [loginUrl, setLoginUrl] = useState('');
      const [devices, setDevices] = useState(null);
      // 擷取
      const [capture, setCapture] = useState(null);
      const [captureTest, setCaptureTest] = useState({});
      // 官方播放器
      const [players, setPlayers] = useState(null);
      const [playerQuery, setPlayerQuery] = useState({});

      const refresh = useCallback(async () => {
        try {
          const next = await api('/status');
          setStatus(next);
          if (!dirty.current) setDraft(next.config);
        } catch (e) {
          setError(e.message);
        }
      }, []);
      const fast = !!status?.library?.scanning || !!status?.sources?.spotify?.loginPending;
      useEffect(() => {
        refresh();
        const timer = setInterval(refresh, fast ? 2000 : 15000);
        return () => clearInterval(timer);
      }, [refresh, fast]);

      useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(''), 4000);
        return () => clearTimeout(timer);
      }, [notice]);
      const act = async (name, fn, done) => {
        setBusy(name);
        setError('');
        setNotice('');
        try {
          const value = await fn();
          if (done) setNotice(typeof done === 'function' ? done(value) : done);
          return value;
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy('');
        }
      };
      const edit = (patch) => {
        dirty.current = true;
        setDraft((d) => ({ ...d, ...patch }));
      };
      const save = () =>
        act('save', async () => {
          const r = await api('/config', draft);
          dirty.current = false;
          setDraft(r.config);
          await refresh();
        }, '已儲存');

      // ---- 播放 ----
      const current = index >= 0 ? queue[index] : null;
      const currentKey = current ? keyOf(current) : '';
      useEffect(() => {
        const el = audio.current;
        if (!el) return;
        if (!current) {
          el.removeAttribute('src');
          el.load();
          setPlayState('');
          setResolved(null);
          return;
        }
        let stale = false;
        setPlayState('loading');
        setResolved(null);
        setError('');
        (async () => {
          try {
            // 先問清楚實際會播哪個版本；找不到對應版本時在這裡就會知道原因。
            if (!DIRECT.includes(current.source)) {
              const r = await api('/resolve', { source: current.source, id: current.id });
              if (stale) return;
              setResolved(r.resolved);
            }
            el.src = API + '/stream?' + new URLSearchParams({ source: current.source, id: current.id });
            await el.play();
          } catch (e) {
            if (stale || e?.name === 'AbortError') return;
            setPlayState('error');
            setError('「' + (current.title || current.id) + '」播不出來：' + (e?.name === 'NotAllowedError' ? '瀏覽器擋下了自動播放，請按播放鍵' : e?.name === 'NotSupportedError' ? '這個瀏覽器不支援這種音訊格式，或音訊還沒準備好' : e.message));
          }
        })();
        return () => {
          stale = true;
        };
      }, [currentKey]);

      const playNow = (track) => {
        const at = queue.findIndex((t) => keyOf(t) === keyOf(track));
        if (at >= 0) return setIndex(at);
        setQueue((q) => [...q, track]);
        setIndex(queue.length);
      };
      const enqueue = (tracks) => {
        const fresh = tracks.filter((t) => !queue.some((q) => keyOf(q) === keyOf(t)));
        if (!fresh.length) return setNotice('這些歌已經在佇列裡了');
        setQueue((q) => [...q, ...fresh]);
        if (index < 0) setIndex(queue.length);
        setNotice('加了 ' + fresh.length + ' 首到佇列');
      };
      const removeAt = (i) => {
        setQueue((q) => q.filter((_, n) => n !== i));
        setIndex((n) => (i < n ? n - 1 : i === n ? (i < queue.length - 1 ? n : -1) : n));
      };
      const step = (delta) => setIndex((n) => (n + delta >= 0 && n + delta < queue.length ? n + delta : n));
      const openInApp = (t) => act('open', () => api('/remote/open', { source: t.source, id: t.id, url: t.url || '' }), '已請官方播放器打開（聲音在這台電腦播放）');

      // ---- 找歌 ----
      const sources = status?.sources || {};
      const enabledSources = ORDER.filter((s) => sources[s]?.enabled);
      useEffect(() => {
        if (enabledSources.length && !enabledSources.includes(source)) setSource(enabledSources[0]);
      }, [enabledSources.join(',')]);
      const search = () => act('search', async () => setResults({ title: NAMES[source] + '：' + query, tracks: (await api('/search?' + new URLSearchParams({ source, q: query }))).tracks }));
      const readLink = () =>
        act('link', async () => {
          const r = await api('/link', { text: linkText });
          setResults({ title: r.title || NAMES[r.link.source] + ' 連結', tracks: r.tracks || [], note: r.note, link: r.link });
        });
      const loadPlaylists = (s) => act('playlists', async () => setPlaylists({ source: s, items: (await api('/playlists?source=' + s)).playlists }));
      const openPlaylist = (s, p) => act('collection', async () => {
        const r = await api('/collection?' + new URLSearchParams({ source: s, kind: 'playlist', id: p.id }));
        setResults({ title: NAMES[s] + ' 歌單：' + p.name, tracks: r.tracks, note: r.note });
      });

      // ---- 音樂庫 ----
      const loadLib = useCallback(async (q, offset) => {
        try {
          const r = await api('/library?' + new URLSearchParams({ q, offset: String(offset), limit: '50' }));
          setLib({ q, offset, total: r.total, tracks: r.tracks.map((t) => ({ ...t, source: 'local' })) });
        } catch (e) {
          setError(e.message);
        }
      }, []);
      const libCount = status?.library?.count;
      useEffect(() => {
        if (tab === 'library') loadLib(lib.q, 0);
      }, [tab, libCount]);

      const loadPlayers = useCallback(async () => {
        try {
          setPlayers(await api('/players'));
        } catch (e) {
          setPlayers({ error: e.message });
        }
      }, []);
      useEffect(() => {
        if (tab === 'players') loadPlayers();
      }, [tab]);
      const playerAct = (player, action) => act('pl-' + player + action, async () => { const r = await api('/players/control', { player, action }); await loadPlayers(); return r; }, (r) => (r?.already ? '本來就是這個狀態' : r?.via === 'mediakey' ? '已用媒體鍵送出' : '已送出'));
      const playerPlay = (player) => act('pl-play-' + player, async () => { const r = await api('/players/play', { player, query: playerQuery[player] || '' }); await loadPlayers(); return r; }, (r) => (r?.started === false ? '已送出，但還沒聽到聲音：' : '播放：') + (r?.track?.title || '') + (r?.track?.artist ? '（' + r.track.artist + '）' : ''));
      const captureOn = !!status?.config?.captureEnabled;
      const loadCapture = useCallback(async () => {
        try {
          setCapture(await api('/capture'));
        } catch (e) {
          setCapture({ error: e.message });
        }
      }, []);
      useEffect(() => {
        if (tab === 'settings' && captureOn) loadCapture();
      }, [tab, captureOn]);
      const testCapture = (app) =>
        act('cap-' + app, async () => {
          setCaptureTest((t) => ({ ...t, [app]: null }));
          const r = await api('/capture/test', { app, quiet: !!status.config.captureQuiet });
          setCaptureTest((t) => ({ ...t, [app]: r }));
          await loadCapture();
        });

      if (!status || !draft) return h('div', { className: 'jb' }, h('style', null, CSS), error ? h('div', { className: 'jb-warn jb-bad', role: 'alert' }, error) : h('p', { className: 'jb-muted' }, '讀取中…'));

      const trackRow = (t, i, extra) =>
        h('div', { className: 'jb-track', key: keyOf(t) + ':' + i, 'data-track': keyOf(t), 'data-current': extra?.current ? 'true' : undefined },
          h('div', { className: 'jb-meta' },
            h('div', { className: 'jb-title', title: t.title }, t.title || t.id),
            h('div', { className: 'jb-sub' }, [t.artist, t.album].filter(Boolean).join(' · ') || NAMES[t.source])),
          h('span', { className: 'jb-time' }, clock(t.duration)),
          h('div', { className: 'jb-actions' }, extra?.actions || [
            h('button', { key: 'p', className: 'jb-btn small', type: 'button', 'data-act': 'play', onClick: () => playNow(t) }, '播放'),
            h('button', { key: 'q', className: 'jb-btn small', type: 'button', 'data-act': 'queue', onClick: () => enqueue([t]) }, '加入'),
            draft.remoteEnabled && t.source !== 'local' ? h('button', { key: 'o', className: 'jb-btn small', type: 'button', 'data-act': 'open', title: '在官方播放器打開（聲音在這台電腦）', disabled: busy === 'open', onClick: () => openInApp(t) }, '官方 App') : null,
          ]));

      const stateText = { loading: '準備中…（第一次播放要先下載，可能要等幾十秒）', playing: '播放中', paused: '已暫停', error: '播放失敗' }[playState] || '';
      const now = h('section', { className: 'jb-now', 'data-now': playState || 'idle' },
        current
          ? h('div', null,
              h('div', { className: 'jb-title', style: { fontWeight: 650 } }, current.title || current.id),
              h('div', { className: 'jb-sub' }, [current.artist, NAMES[current.source], stateText].filter(Boolean).join(' · ')),
              resolved ? h('div', { className: 'jb-sub', 'data-resolved': resolved.kind }, '對應播放：' + (resolved.kind === 'local' ? '本地音樂庫' : resolved.kind === 'bili' ? 'bilibili' : 'YouTube') + '「' + (resolved.title || resolved.id) + '」' + (resolved.artist ? '（' + resolved.artist + '）' : '') + '，相似度 ' + Math.round(resolved.score * 100) + '%') : null)
          : h('p', { className: 'jb-muted' }, '佇列是空的。到下面找歌，或到「音樂庫」挑一首。'),
        h('audio', { ref: audio, controls: true, preload: 'none', onPlaying: () => setPlayState('playing'), onPause: () => setPlayState((s) => (s === 'playing' ? 'paused' : s)), onWaiting: () => setPlayState((s) => (s === 'playing' ? 'loading' : s)), onEnded: () => (index < queue.length - 1 ? step(1) : setPlayState('paused')),
          onError: () => { if (current) { setPlayState('error'); setError('「' + (current.title || current.id) + '」載入失敗（檔案格式這個瀏覽器不支援，或下載失敗）'); } } }),
        h('div', { className: 'jb-row' },
          h('button', { className: 'jb-btn small', type: 'button', disabled: index <= 0, onClick: () => step(-1) }, '上一首'),
          h('button', { className: 'jb-btn small', type: 'button', disabled: index < 0 || index >= queue.length - 1, onClick: () => step(1) }, '下一首'),
          h('span', { className: 'jb-muted', 'data-queue-count': queue.length }, queue.length ? '佇列 ' + (index + 1) + ' / ' + queue.length : ''),
          queue.length ? h('button', { className: 'jb-btn small', type: 'button', style: { marginLeft: 'auto' }, onClick: () => { setQueue([]); setIndex(-1); } }, '清空佇列') : null));

      const playTab = h(React.Fragment, null,
        queue.length ? h('section', { className: 'jb-card', 'data-card': 'queue' }, h('h3', null, '播放佇列'),
          h('div', { className: 'jb-list' }, queue.map((t, i) => trackRow(t, i, { current: i === index, actions: [
            h('button', { key: 'j', className: 'jb-btn small', type: 'button', disabled: i === index, onClick: () => setIndex(i) }, '播這首'),
            h('button', { key: 'x', className: 'jb-btn small', type: 'button', 'aria-label': '從佇列移除', onClick: () => removeAt(i) }, '移除'),
          ] })))) : null,
        h('section', { className: 'jb-card', 'data-card': 'find' },
          h('h3', null, '找歌'),
          enabledSources.length
            ? h('div', { className: 'jb-chips', role: 'group', 'aria-label': '來源' }, enabledSources.map((s) => h('button', { key: s, className: 'jb-chip', type: 'button', 'aria-pressed': source === s, 'data-source': s, onClick: () => { setSource(s); setResults(null); } }, NAMES[s])))
            : h('p', { className: 'jb-muted' }, '還沒有啟用任何來源；請到「來源帳號」開啟。'),
          enabledSources.length ? h('form', { className: 'jb-row', onSubmit: (e) => { e.preventDefault(); if (query.trim() || source === 'local') search(); } },
                h('input', { className: 'jb-input jb-grow', placeholder: '歌名或歌手', value: query, 'data-search': '', onChange: (e) => setQuery(e.target.value) }),
                h('button', { className: 'jb-btn primary', type: 'submit', disabled: busy === 'search' || (!query.trim() && source !== 'local') }, busy === 'search' ? '搜尋中…' : '搜尋')) : null,
          !sources[source]?.usable && enabledSources.includes(source)
            ? h('div', { className: 'jb-warn jb-row' }, h('span', { className: 'jb-grow' }, source === 'local' ? '音樂庫還是空的；要先設定音樂資料夾並掃描。' : !status.ytdlp.found ? '找不到 yt-dlp，YT Music、bilibili 與對應播放都需要它。' : NAMES[source] + ' 還沒設定好。'),
                h('button', { className: 'jb-btn small', type: 'button', onClick: () => setTab(source === 'local' ? 'library' : !status.ytdlp.found ? 'settings' : 'accounts') }, source === 'local' ? '前往音樂庫' : !status.ytdlp.found ? '前往設定' : '前往來源帳號')) : null,
          !DIRECT.includes(source) ? h('p', { className: 'jb-muted' }, NAMES[source] + ' 的音訊受保護：按「播放」會改播本地音樂庫或 YouTube 上的同一首；按「官方 App」則由 ' + NAMES[source] + ' 自己的播放器播放。') : null,
          h('form', { className: 'jb-row', onSubmit: (e) => { e.preventDefault(); if (linkText.trim()) readLink(); } },
            h('input', { className: 'jb-input jb-grow', placeholder: '或貼上歌曲／專輯／歌單連結', value: linkText, 'data-link': '', onChange: (e) => setLinkText(e.target.value) }),
            h('button', { className: 'jb-btn', type: 'submit', disabled: !linkText.trim() || busy === 'link' }, busy === 'link' ? '讀取中…' : '讀取連結')),
          (source === 'spotify' && sources.spotify?.loggedIn) || source === 'bilibili' ? h('div', { className: 'jb-row' },
            h('button', { className: 'jb-btn small', type: 'button', 'data-act': 'playlists', disabled: busy === 'playlists' || busy === 'collection', onClick: () => loadPlaylists(source) }, source === 'spotify' ? '我的 Spotify 歌單' : '音頻區熱門歌單'),
            playlists?.source === source ? h('div', { className: 'jb-chips' }, playlists.items.map((p) => h('button', { key: p.id, className: 'jb-chip', type: 'button', 'data-playlist': p.id, onClick: () => openPlaylist(source, p) }, p.name))) : null) : null,
          source === 'bilibili' ? h('p', { className: 'jb-muted' }, '搜尋找的是 bilibili 的影片（播它的音訊）。音頻區的單曲（au…）、歌單（am…），以及影片的合集、系列、收藏夾、某位 UP 主的全部投稿（bilibili.com/list/編號），請貼連結；b23.tv 短網址也可以。') : null),
        results ? h('section', { className: 'jb-card', 'data-card': 'results' },
          h('div', { className: 'jb-row' }, h('h3', { className: 'jb-grow' }, results.title), results.tracks.length > 1 ? h('button', { className: 'jb-btn small', type: 'button', 'data-act': 'queue-all', onClick: () => enqueue(results.tracks) }, '全部加入佇列（' + results.tracks.length + '）') : null),
          results.note ? h('p', { className: 'jb-muted' }, results.note) : null,
          results.tracks.length ? h('div', { className: 'jb-list' }, results.tracks.map((t, i) => trackRow(t, i))) : results.note ? null : h('p', { className: 'jb-muted' }, '沒有找到。')) : null,
        null);

      const scanning = status.library.scanning;
      const libraryTab = h(React.Fragment, null,
        h('section', { className: 'jb-card', 'data-card': 'folders' },
          h('h3', null, '音樂資料夾'),
          h('p', { className: 'jb-muted' }, '點唱機只讀取這些資料夾裡的音樂檔，不會改動、搬移或刪除。支援 MP3、FLAC、M4A、OGG、Opus、WAV 等格式。'),
          draft.libraryFolders.length ? h('div', { className: 'jb-list' }, draft.libraryFolders.map((f) => h('div', { className: 'jb-track', key: f }, h('span', { className: 'jb-meta jb-title', title: f }, f),
            h('button', { className: 'jb-btn small', type: 'button', onClick: () => edit({ libraryFolders: draft.libraryFolders.filter((x) => x !== f) }) }, '移除')))) : h('p', { className: 'jb-muted' }, '還沒有資料夾。'),
          h('form', { className: 'jb-row', onSubmit: (e) => { e.preventDefault(); const v = folder.trim(); if (v) { edit({ libraryFolders: [...draft.libraryFolders, v] }); setFolder(''); } } },
            h('input', { className: 'jb-input jb-grow', placeholder: '資料夾的完整路徑，例如 D:\\Music', value: folder, 'data-folder': '', onChange: (e) => setFolder(e.target.value) }),
            h('button', { className: 'jb-btn', type: 'submit', disabled: !folder.trim() }, '加入')),
          h('div', { className: 'jb-row' },
            h('button', { className: 'jb-btn primary', type: 'button', 'data-act': 'scan', disabled: !!scanning || dirty.current || !status.config.libraryFolders.length, onClick: () => act('scan', async () => { await api('/library/scan', {}); await refresh(); }) }, scanning ? '掃描中…' : '掃描音樂庫'),
            scanning ? h('button', { className: 'jb-btn', type: 'button', onClick: () => act('cancel', () => api('/library/cancel', {})) }, '取消') : null,
            h('span', { className: 'jb-muted', 'data-lib-count': status.library.count, role: 'status' },
              scanning ? '已處理 ' + scanning.done + ' / ' + scanning.total + ' 個檔案' : dirty.current ? '資料夾有變更，請先按下面的「儲存」再掃描' : '共 ' + status.library.count + ' 首' + (status.library.scannedAt ? '，上次掃描 ' + new Date(status.library.scannedAt).toLocaleString() : '，還沒掃描過'))),
          status.library.last && !scanning ? h('p', { className: 'jb-muted' }, status.library.last.ok === false ? '上次掃描沒有完成：' + status.library.last.error
            : '上次掃描：新增或更新 ' + status.library.last.changed + ' 首' + (status.library.last.unreadable ? '，' + status.library.last.unreadable + ' 個檔案讀不出標籤（改用檔名）' : '') + (status.library.last.missing?.length ? '；找不到資料夾：' + status.library.last.missing.join('、') : '') + (status.library.last.truncated ? '；超過 50,000 首的部分沒有收錄' : '')) : null),
        h('section', { className: 'jb-card', 'data-card': 'browse' },
          h('form', { className: 'jb-row', onSubmit: (e) => { e.preventDefault(); loadLib(lib.q, 0); } },
            h('input', { className: 'jb-input jb-grow', placeholder: '在音樂庫裡找（歌名、歌手、專輯）', value: lib.q, 'data-lib-search': '', onChange: (e) => setLib({ ...lib, q: e.target.value }) }),
            h('button', { className: 'jb-btn', type: 'submit' }, '搜尋'),
            lib.tracks?.length ? h('button', { className: 'jb-btn', type: 'button', onClick: () => enqueue(lib.tracks) }, '這頁全部加入佇列') : null),
          lib.tracks === null ? h('p', { className: 'jb-muted' }, '讀取中…') : lib.tracks.length ? h('div', { className: 'jb-list' }, lib.tracks.map((t, i) => trackRow(t, i))) : h('p', { className: 'jb-muted' }, lib.q ? '沒有符合的歌。' : '音樂庫是空的。'),
          lib.total > 50 ? h('div', { className: 'jb-row' },
            h('button', { className: 'jb-btn small', type: 'button', disabled: lib.offset === 0, onClick: () => loadLib(lib.q, Math.max(0, lib.offset - 50)) }, '上一頁'),
            h('span', { className: 'jb-muted' }, (lib.offset + 1) + '–' + Math.min(lib.total, lib.offset + 50) + ' / ' + lib.total),
            h('button', { className: 'jb-btn small', type: 'button', disabled: lib.offset + 50 >= lib.total, onClick: () => loadLib(lib.q, lib.offset + 50) }, '下一頁')) : null));

      const toggle = (s) => (on) => edit({ enabledSources: on ? [...new Set([...draft.enabledSources, s])] : draft.enabledSources.filter((x) => x !== s) });
      const secretInput = (key, placeholder, has) => h('input', { className: 'jb-input', type: 'password', autoComplete: 'off', placeholder: has ? '已填（留空表示不變）' : placeholder, value: secrets[key] || '', 'data-secret': key, onChange: (e) => setSecrets({ ...secrets, [key]: e.target.value }) });
      const saveSecrets = (keys, label) => act('secrets', async () => {
        const patch = {};
        for (const k of keys) if (secrets[k]) patch[k] = secrets[k];
        await api('/secrets', patch);
        setSecrets((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k))));
        await refresh();
      }, label + ' 的金鑰已保存');
      const clearSecrets = (keys, label) => act('secrets', async () => { await api('/secrets', Object.fromEntries(keys.map((k) => [k, '']))); await refresh(); }, label + ' 的金鑰已清除');
      const sp = sources.spotify || {};
      const head = (s, ok, text) => h('div', { className: 'jb-row' }, h('h3', { className: 'jb-grow' }, NAMES[s]), h(Badge, { ok }, text));
      const accountsTab = h(React.Fragment, null,
        !status.secrets.persistent ? h('div', { className: 'jb-warn' }, '這個系統沒有可用的加密保存方式，金鑰只會留在記憶體，DSH 重啟後要重新輸入。') : null,
        status.secrets.error ? h('div', { className: 'jb-warn jb-bad' }, status.secrets.error) : null,
        h('section', { className: 'jb-card', 'data-source-card': 'local' }, head('local', sources.local.usable, sources.local.usable ? '可播放 ' + status.library.count + ' 首' : '音樂庫是空的'),
          h(Check, { label: '啟用本地音樂庫', hint: '直接播放你電腦裡的音樂檔。資料夾在「音樂庫」分頁設定。', checked: draft.enabledSources.includes('local'), onChange: toggle('local') })),
        h('section', { className: 'jb-card', 'data-source-card': 'ytmusic' }, head('ytmusic', status.ytdlp.found, status.ytdlp.found ? 'yt-dlp ' + status.ytdlp.version : '找不到 yt-dlp'),
          h(Check, { label: '啟用 YT Music', hint: '用你電腦上的 yt-dlp 搜尋與播放，不需要帳號。其他服務的「對應播放」也靠它。', checked: draft.enabledSources.includes('ytmusic'), onChange: toggle('ytmusic') }),
          !status.ytdlp.found ? h('p', { className: 'jb-muted' }, '請安裝 yt-dlp，或到「設定」填它的完整路徑。如果有裝「Discord 賽博群友」，在它的語音頁按「下載 yt-dlp」，這裡會自動找到。') : null),
        h('section', { className: 'jb-card', 'data-source-card': 'bilibili' }, head('bilibili', status.ytdlp.found, status.ytdlp.found ? '不需要帳號' : '找不到 yt-dlp'),
          h(Check, { label: '啟用 bilibili', hint: '播放 bilibili 公開影片的音訊，以及音頻區（bilibili.com/audio）的單曲與歌單；也能讀合集、系列與收藏夾的連結。用 yt-dlp，不需要帳號。需要登入或大會員的內容播不了；多分 P 的影片只播第一段。', checked: draft.enabledSources.includes('bilibili'), onChange: toggle('bilibili') })),
        h('section', { className: 'jb-card', 'data-source-card': 'spotify' }, head('spotify', sp.loggedIn, sp.loggedIn ? '已登入' : '尚未登入'),
          h(Check, { label: '啟用 Spotify', hint: '讀你的歌單與搜尋。聲音用對應播放，或叫這台電腦的 Spotify 播放（免費版也可以；遙控別的裝置才需要 Premium）。', checked: draft.enabledSources.includes('spotify'), onChange: toggle('spotify') }),
          draft.enabledSources.includes('spotify') || sp.loggedIn ? h(React.Fragment, null,
          h('ol', { className: 'jb-steps' },
            h('li', null, '到 developer.spotify.com 的 Dashboard 建立一個 App（Spotify 目前要求 App 擁有者是 Premium 帳號）。'),
            h('li', null, '在 App 的 Redirect URIs 加上：', h('span', { className: 'jb-code', 'data-redirect': '' }, sp.redirectUri)),
            h('li', null, '把 App 的 Client ID 貼到下面並按「儲存」，再按「登入 Spotify」。')),
          h(Field, { label: 'Client ID', hint: '不需要 Client Secret。' }, h('input', { className: 'jb-input', value: draft.spotifyClientId, 'data-spotify-client': '', onChange: (e) => edit({ spotifyClientId: e.target.value.trim() }) })),
          h('div', { className: 'jb-row' },
            h('button', { className: 'jb-btn primary', type: 'button', disabled: !status.config.spotifyClientId || dirty.current || busy === 'login', onClick: () => act('login', async () => { const r = await api('/spotify/login', {}); setLoginUrl(r.url); window.open(r.url, '_blank', 'noopener'); await refresh(); }) }, sp.loggedIn ? '重新登入' : '登入 Spotify'),
            sp.loggedIn ? h('button', { className: 'jb-btn', type: 'button', onClick: () => act('logout', async () => { await api('/spotify/logout', {}); setLoginUrl(''); await refresh(); }, '已登出 Spotify') }, '登出') : null,
            sp.loginPending ? h('span', { className: 'jb-muted', role: 'status' }, '等你在瀏覽器完成登入…') : sp.lastLogin?.ok === false ? h('span', { className: 'jb-muted', role: 'status' }, '上次登入沒有完成：' + sp.lastLogin.error) : null),
          sp.loginPending && loginUrl ? h('p', { className: 'jb-muted' }, '瀏覽器沒有自動打開的話，', h('a', { href: loginUrl, target: '_blank', rel: 'noopener noreferrer' }, '按這裡打開 Spotify 登入頁'), '。') : null) : h('p', { className: 'jb-muted' }, '勾選啟用後會顯示設定步驟。')),
        h('section', { className: 'jb-card', 'data-source-card': 'kkbox' }, head('kkbox', true, sources.kkbox.hasKeys ? '已填金鑰' : '不填金鑰也能用'),
          h(Check, { label: '啟用 KKBOX', hint: '不填金鑰也能搜尋（用 KKBOX 的公開網站，一次只找得到最符合的一首，查得太頻繁會被它暫時擋下）。填了金鑰改用官方接口：可回多筆結果、讀公開的分享歌單與專輯。讀不到個人收藏。', checked: draft.enabledSources.includes('kkbox'), onChange: toggle('kkbox') }),
          draft.enabledSources.includes('kkbox') || sources.kkbox.hasKeys ? h(React.Fragment, null,
          h('p', { className: 'jb-muted' }, '到 developer.kkbox.com 建立應用程式，取得 Client ID 與 Client Secret。'),
          h('div', { className: 'jb-fields' }, h(Field, { label: 'Client ID' }, secretInput('kkboxId', '', sources.kkbox.hasKeys)), h(Field, { label: 'Client Secret' }, secretInput('kkboxSecret', '', sources.kkbox.hasKeys))),
          h('div', { className: 'jb-row' },
            h('button', { className: 'jb-btn', type: 'button', disabled: !(secrets.kkboxId || secrets.kkboxSecret) || busy === 'secrets', onClick: () => saveSecrets(['kkboxId', 'kkboxSecret'], 'KKBOX') }, '保存金鑰'),
            h('button', { className: 'jb-btn', type: 'button', disabled: !sources.kkbox.hasKeys || busy === 'kktest', onClick: () => act('kktest', () => api('/kkbox/test', {}), 'KKBOX 金鑰可以用') }, '測試金鑰'),
            sources.kkbox.hasKeys ? h('button', { className: 'jb-btn', type: 'button', onClick: () => clearSecrets(['kkboxId', 'kkboxSecret'], 'KKBOX') }, '清除') : null)) : h('p', { className: 'jb-muted' }, '勾選啟用後會顯示金鑰欄位（選填）。')),
        h('section', { className: 'jb-card', 'data-source-card': 'apple' }, head('apple', true, '搜尋不需要金鑰'),
          h(Check, { label: '啟用 Apple Music', hint: '搜尋、單曲與專輯連結用 Apple 的公開查詢接口，不需要帳號。聲音用對應播放。', checked: draft.enabledSources.includes('apple'), onChange: toggle('apple') }),
          h('details', { className: 'jb-details', 'data-details': 'apple-token' }, h('summary', null, '讀歌單連結用的開發者權杖（選填' + (sources.apple.hasDeveloperToken ? '，已填）' : '）')),
          h('p', { className: 'jb-muted' }, '只有「讀歌單連結」需要開發者權杖（付費的 Apple Developer 帳號）。' + (sources.apple.hasDeveloperToken ? '目前已填。' : '沒有的話可以跳過。')),
          h('div', { className: 'jb-fields' }, h(Field, { label: 'Team ID' }, secretInput('appleTeamId', '', sources.apple.hasDeveloperToken)), h(Field, { label: 'Key ID' }, secretInput('appleKeyId', '', sources.apple.hasDeveloperToken))),
          h(Field, { label: '私鑰（.p8 檔的內容）' }, h('textarea', { className: 'jb-input', autoComplete: 'off', spellCheck: false, placeholder: sources.apple.hasDeveloperToken ? '已填（留空表示不變）' : '-----BEGIN PRIVATE KEY-----', value: secrets.appleKey || '', 'data-secret': 'appleKey', onChange: (e) => setSecrets({ ...secrets, appleKey: e.target.value }) })),
          h('div', { className: 'jb-row' },
            h('button', { className: 'jb-btn', type: 'button', disabled: !(secrets.appleTeamId || secrets.appleKeyId || secrets.appleKey) || busy === 'secrets', onClick: () => saveSecrets(['appleTeamId', 'appleKeyId', 'appleKey'], 'Apple Music') }, '保存金鑰'),
            sources.apple.hasDeveloperToken ? h('button', { className: 'jb-btn', type: 'button', onClick: () => clearSecrets(['appleTeamId', 'appleKeyId', 'appleKey', 'appleToken'], 'Apple Music') }, '清除') : null))));

      const d = status.discord;
      const settingsTab = h(React.Fragment, null,
        h('section', { className: 'jb-card', 'data-card': 'discord' },
          h('div', { className: 'jb-row' }, h('h3', { className: 'jb-grow' }, 'Discord 賽博群友'), h(Badge, { ok: d.found && d.registered.length > 0 }, !draft.discordEnabled ? '沒有登記' : d.found ? '已登記 ' + d.registered.length + ' 個來源' : '沒有找到 Discord 插件')),
          h(Check, { label: '把點唱機登記成 Discord 的音樂來源', hint: '登記後，Discord 的點歌可以選「點唱機：本地音樂庫」「點唱機：Spotify（對應播放）」等來源，聲音會進語音房。誰可以點歌仍由 Discord 插件的設定決定。', checked: draft.discordEnabled, 'data-discord-toggle': '', onChange: (v) => edit({ discordEnabled: v }) }),
          d.registered.length ? h('div', { className: 'jb-chips' }, d.registered.map((id) => h('span', { key: id, className: 'jb-badge ok' }, 'plugin:' + id))) : null,
          d.error ? h('p', { className: 'jb-muted' }, '登記時發生問題：' + d.error) : null),
        h('section', { className: 'jb-card', 'data-card': 'priority' },
          h('h3', null, '播放方式的優先順序'),
          h('p', { className: 'jb-muted' }, '有人指定某個平台的歌時，點唱機照這個順序找能用的播放方式，上面的優先。取消勾選表示不使用那一種。'),
          h('div', { className: 'jb-list' }, [...draft.playPriority, ...PLAY_METHODS.filter((m) => !draft.playPriority.includes(m))].map((method) => {
            const at = draft.playPriority.indexOf(method);
            const on = at >= 0;
            const move = (delta) => { const next = [...draft.playPriority]; next.splice(at, 1); next.splice(at + delta, 0, method); edit({ playPriority: next }); };
            return h('div', { className: 'jb-track', key: method, 'data-priority': method, 'data-on': on ? 'true' : 'false', style: on ? null : { opacity: 0.6 } },
              h('span', { className: 'jb-time', style: { width: '1.4em', textAlign: 'center' } }, on ? at + 1 : '–'),
              h('label', { className: 'jb-check jb-meta' }, h('input', { type: 'checkbox', checked: on, 'aria-label': PLAY_LABELS[method][0], onChange: (e) => edit({ playPriority: e.target.checked ? [...draft.playPriority, method] : draft.playPriority.filter((m) => m !== method) }) }),
                h('span', null, PLAY_LABELS[method][0], h('span', { className: 'jb-muted', style: { display: 'block' } }, PLAY_LABELS[method][1]))),
              h('div', { className: 'jb-actions' },
                h('button', { className: 'jb-btn small', type: 'button', 'aria-label': '往上移', disabled: !on || at === 0, onClick: () => move(-1) }, '↑'),
                h('button', { className: 'jb-btn small', type: 'button', 'aria-label': '往下移', disabled: !on || at === draft.playPriority.length - 1, onClick: () => move(1) }, '↓')));
          })),
          !draft.playPriority.length ? h('div', { className: 'jb-warn' }, '至少要保留一種；全部取消的話儲存後會回到預設順序。') : null,
          draft.playPriority.includes('official') && !(draft.captureEnabled && draft.captureControl) ? h('p', { className: 'jb-muted' }, '「用官方播放器播放」要先在下面開啟擷取，並允許點歌控制你的播放器；沒開的時候會自動跳到下一種。') : null),
        h('section', { className: 'jb-card', 'data-card': 'capture' },
          h('div', { className: 'jb-row' }, h('h3', { className: 'jb-grow' }, '擷取官方播放器的聲音'), h(Badge, { ok: captureOn && status.capture.supported }, !status.capture.supported ? '只支援 Windows' : captureOn ? '已開啟' : '關閉')),
          h('p', { className: 'jb-muted' }, '把 Spotify、KKBOX、Apple Music 官方播放器正在播的聲音，即時轉送到 Discord 語音房。只擷取這幾個播放器程式，不擷取整台電腦的聲音，也不擷取麥克風。'),
          h('div', { className: 'jb-warn' }, '這些服務的使用條款都不允許把串流內容轉播給其他人。開啟後的風險由帳號擁有人承擔；建議只在自己的私人小群使用。'),
          h(Check, { label: '開啟擷取，並登記成 Discord 的即時來源', hint: '開啟後 Discord 的音樂來源會多一個「點唱機：官方播放器的聲音（即時轉送）」。播放是即時的：歌多長就播多久，同時只能轉送到一個語音房。需要 Discord 賽博群友 1.0.7 以上。', checked: draft.captureEnabled, disabled: !status.capture.supported, 'data-capture-toggle': '', onChange: (v) => edit({ captureEnabled: v }) }),
          h(Check, { label: '轉送時讓播放器在這台電腦上幾乎聽不到', hint: '不需要另外裝虛擬音效裝置。做法是轉送期間把播放器在 Windows 音量混音器的音量調到千分之一，結束時還原；轉送出去的音量不受影響。開頭約 0.1 秒會小聲一下。轉送出去的大小跟著播放器自己的音量走，覺得太小聲就把播放器裡的音量調大。', checked: draft.captureQuiet, onChange: (v) => edit({ captureQuiet: v }) }),
          h(Check, { label: '讓 Discord 的點歌可以控制我的播放器', hint: '開啟後，有人在 Discord 點 Spotify、KKBOX 或 Apple Music 的歌時，點唱機會叫你的播放器開始播那首歌並即時轉送，播完或停止時幫你暫停（三個都需要程式在這台電腦開著；Spotify 另外要先在「來源帳號」登入才找得到歌，免費版也可以；Apple Music 要有訂閱）。關閉時只能轉送你自己正在播的內容。', checked: draft.captureControl, 'data-capture-control': '', onChange: (v) => edit({ captureControl: v }) }),
          captureOn && status.capture.supported ? h(React.Fragment, null,
            capture?.error ? h('div', { className: 'jb-warn jb-bad' }, capture.error) : null,
            h('div', { className: 'jb-list' }, Object.keys(status.capture.apps).map((app) => h('div', { className: 'jb-track', key: app, 'data-capture-app': app },
              h('div', { className: 'jb-meta' }, h('div', { className: 'jb-title' }, status.capture.apps[app]),
                h('div', { className: 'jb-sub', role: 'status' }, captureTest[app] ? (captureTest[app].heard ? '有擷取到聲音（最大音量 ' + captureTest[app].peak + '%）' : '擷取成功，但這三秒沒有聲音；請確認播放器正在播放') : capture?.running ? (capture.running[app] ? '正在執行' : '沒有在執行') : '檢查中…')),
              h('div', { className: 'jb-actions' }, h('button', { className: 'jb-btn small', type: 'button', disabled: !capture?.running?.[app] || !!busy, onClick: () => testCapture(app) }, busy === 'cap-' + app ? '擷取中…' : '測試三秒'))))),
            h('div', { className: 'jb-row' },
              h('button', { className: 'jb-btn small', type: 'button', onClick: loadCapture }, '重新檢查'),
              status.capture.active ? h('button', { className: 'jb-btn small', type: 'button', onClick: () => act('cap-stop', async () => { await api('/capture/stop', {}); await refresh(); }, '已停止轉送') }, '停止目前的轉送（' + status.capture.apps[status.capture.active.app] + '）') : null),
            h('details', { className: 'jb-details', 'data-details': 'capture-names' }, h('summary', null, '進階：播放器的程式名稱'), h('div', { className: 'jb-fields' }, Object.keys(status.capture.apps).map((app) => h(Field, { key: app, label: status.capture.apps[app] + ' 的程式名稱', hint: '預設 ' + status.capture.defaults[app] + '.exe；偵測不到時才需要改。' },
              h('input', { className: 'jb-input', placeholder: status.capture.defaults[app], value: draft.captureProcessNames?.[app] || '', onChange: (e) => edit({ captureProcessNames: { ...draft.captureProcessNames, [app]: e.target.value } }) })))))) : null),
        h('section', { className: 'jb-card', 'data-card': 'options' },
          h('h3', null, '播放與工具'),

          h(Check, { label: '允許「在官方播放器打開」與遙控 Spotify', hint: '只有你在這個頁面按按鈕時才會動作；AI 與 Discord 都不能觸發。', checked: draft.remoteEnabled, onChange: (v) => edit({ remoteEnabled: v }) }),
          h(Check, { label: '讓 DSH 對話裡的 AI 可以查歌', hint: '兩個唯讀工具：找歌、讀連結裡的歌曲清單。AI 不能播放、登入或改設定。', checked: draft.toolsEnabled, onChange: (v) => edit({ toolsEnabled: v }) }),
          h('div', { className: 'jb-fields' },
            h(Field, { label: '地區', hint: '兩個英文字母，例如 TW、JP、US。影響搜尋結果。' }, h('input', { className: 'jb-input', maxLength: 2, value: draft.territory, onChange: (e) => edit({ territory: e.target.value.toUpperCase() }) })),
            h(Field, { label: 'YouTube 音訊快取上限（MB）', hint: '放在 ' + status.dataDir + ' 的 cache 資料夾，超過會刪最久沒播的。' }, h('input', { className: 'jb-input', type: 'number', min: 100, max: 20000, value: draft.cacheMaxMb, onChange: (e) => edit({ cacheMaxMb: Number(e.target.value) }) })),
            h(Field, { label: 'Spotify 登入用的本機埠', hint: '改了以後，Spotify 後台的 Redirect URI 也要跟著改。' }, h('input', { className: 'jb-input', type: 'number', min: 1024, max: 65535, value: draft.spotifyLoginPort, onChange: (e) => edit({ spotifyLoginPort: Number(e.target.value) }) }))),
          h(Field, { label: 'yt-dlp 執行檔路徑', hint: '通常留空，會自動找 ~/.dsh/bin 與系統路徑。目前：' + (status.ytdlp.found ? '已找到 ' + status.ytdlp.version : '找不到') }, h('input', { className: 'jb-input', value: draft.ytdlpPath, onChange: (e) => edit({ ytdlpPath: e.target.value }) })),
          h(Field, { label: 'FFmpeg 執行檔路徑', hint: '通常留空。只有本地音樂檔超過 64 MiB、要送進 Discord 時才會用它轉檔。' }, h('input', { className: 'jb-input', value: draft.ffmpegPath, onChange: (e) => edit({ ffmpegPath: e.target.value }) }))));

      const pl = players?.players || {};
      const playersTab = h(React.Fragment, null,
        h('section', { className: 'jb-card', 'data-card': 'players' },
          h('div', { className: 'jb-row' }, h('h3', { className: 'jb-grow' }, '這台電腦上的官方播放器'), h('button', { className: 'jb-btn small', type: 'button', onClick: loadPlayers }, '重新整理')),
          h('p', { className: 'jb-muted' }, '聲音由播放器自己在這台電腦播放。暫停、繼續、上下首會先用播放器的接口或 Windows 的系統媒體控制；都沒有時用媒體鍵（和鍵盤上的一樣，同時開著好幾個播放器時可能控制到別的）。'),
          players?.error ? h('div', { className: 'jb-warn jb-bad' }, players.error) : null,
          players && players.supported === false ? h('div', { className: 'jb-warn' }, '控制官方播放器只支援 Windows。') : null,
          !players ? h('p', { className: 'jb-muted' }, '讀取中…') : h('div', { className: 'jb-list' }, Object.keys(pl).map((id) => {
            const p = pl[id];
            const how = { api: '可依歌名播放（官方接口）', link: '可依歌名播放（用它自己的播放連結）', window: '可依歌名播放（自動操作它的視窗，約需 5～8 秒；需要有訂閱）', none: id === 'spotify' ? '登入 Spotify 後可依歌名播放' : '不能直接指定歌曲（要靠 AI 看畫面操作）' }[p.playByName];
            return h('div', { key: id, 'data-player': id, style: { padding: '8px 0', borderBottom: '1px dashed var(--jb-line)', display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { className: 'jb-row' },
                h('div', { className: 'jb-meta' }, h('div', { className: 'jb-title', style: { fontWeight: 600 } }, p.name, ' ', h(Badge, { ok: p.running }, p.running ? '開著' : '沒開')),
                  h('div', { className: 'jb-sub' }, p.nowPlaying?.title ? (p.nowPlaying.state === 'playing' ? '正在播：' : '停在：') + p.nowPlaying.title + (p.nowPlaying.artist ? '（' + p.nowPlaying.artist + '）' : '') : how)),
                h('div', { className: 'jb-actions' }, [['previous', '上一首'], ['pause', '暫停'], ['resume', '繼續'], ['next', '下一首']].map(([action, text]) =>
                  h('button', { key: action, className: 'jb-btn small', type: 'button', disabled: !!busy || (!p.running && p.control !== 'api'), onClick: () => playerAct(id, action) }, text)))),
              p.playByName !== 'none' ? h('form', { className: 'jb-row', onSubmit: (e) => { e.preventDefault(); if ((playerQuery[id] || '').trim()) playerPlay(id); } },
                h('input', { className: 'jb-input jb-grow', placeholder: '歌名，可以加歌手', value: playerQuery[id] || '', 'data-player-query': id, onChange: (e) => setPlayerQuery({ ...playerQuery, [id]: e.target.value }) }),
                h('button', { className: 'jb-btn', type: 'submit', disabled: !!busy || !(playerQuery[id] || '').trim() || (!p.running && p.playByName !== 'api') }, busy === 'pl-play-' + id ? '處理中…' : '在 ' + p.name + ' 播放')) : null);
          }))),
        h('section', { className: 'jb-card', 'data-card': 'players-ai' },
          h('h3', null, '讓 AI 控制'),
          h(Check, { label: '讓 DSH 對話裡的 AI 可以控制官方播放器', hint: '開啟後，AI 多三個工具（看播放器狀態、依歌名播放、暫停／繼續／上下首）和一個教它怎麼用的技能。AI 仍然不能登入、改設定或讀你的金鑰。', checked: draft.playerControlEnabled, 'data-player-ai': '', onChange: (v) => edit({ playerControlEnabled: v }) }),
          h('p', { className: 'jb-muted' }, '想讓 Discord 裡的點歌也能叫播放器播歌，要到「Discord 與設定」開啟擷取與「讓 Discord 的點歌可以控制我的播放器」。')));

      const tabs = [['play', '播放'], ['library', '音樂庫'], ['players', '官方播放器'], ['accounts', '來源帳號'], ['settings', 'Discord 與設定']];
      return h('div', { className: 'jb' }, h('style', null, CSS),
        !status.enabled ? h('div', { className: 'jb-warn' }, '點唱機目前是停用的；請到插件列表啟用。') : null,
        now,
        error ? h('div', { className: 'jb-warn jb-bad', role: 'alert' }, error) : null,
        h('div', { className: 'jb-tabs', role: 'tablist' }, tabs.map(([id, label]) => h('button', { className: 'jb-tab', type: 'button', role: 'tab', key: id, 'aria-selected': tab === id, 'data-tab': id, onClick: () => setTab(id) }, label))),
        tab === 'play' ? playTab : tab === 'library' ? libraryTab : tab === 'players' ? playersTab : tab === 'accounts' ? accountsTab : settingsTab,
        dirty.current || busy === 'save'
          ? h('div', { className: 'jb-savebar', 'data-savebar': 'dirty' }, h('span', null, '有還沒儲存的變更'),
              h('button', { className: 'jb-btn', type: 'button', disabled: busy === 'save', onClick: () => { dirty.current = false; setDraft(status.config); } }, '還原'),
              h('button', { className: 'jb-btn primary', type: 'button', 'data-act': 'save', disabled: busy === 'save', onClick: save }, busy === 'save' ? '儲存中…' : '儲存'))
          : notice ? h('div', { className: 'jb-savebar toast', 'data-savebar': 'notice', role: 'status' }, notice) : null);
    }

    function Row(props) {
      return props?.view === 'summary' ? h('p', null, '點唱機：播放本地音樂庫與 YT Music；Spotify、KKBOX、Apple Music 以對應播放或官方播放器支援。') : h(Panel);
    }

    return {
      inject: ['slots'],
      JukeboxPanel: Panel,
      apply(ctx) {
        ctx.slots.inject('settings.section', () => {
          ctx.effect(() => ctx.slots.register({ name: 'settings.section', id: 'dsh-jukebox', order: 63, label: () => '點唱機' }, Row));
        });
      },
    };
  },
});
