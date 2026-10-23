// Lyric Stage: plays YouTube / YouTube Music links and drives Folia's lyric visualizer with the
// player's clock. Modelled on Folia's OBS web source (src/components/obs/ObsWebSourceApp.tsx):
// same VisualizerRenderer pipeline, with the YouTube IFrame player as the time source.
// The page cannot hear the YouTube audio, so the audio energy inputs stay at 0.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMotionValue } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import VisualizerRenderer from '../components/visualizer/VisualizerRenderer';
import { VISUALIZER_REGISTRY, getVisualizerModeLabel, hasVisualizerMode, DEFAULT_VISUALIZER_MODE } from '../components/visualizer/registry';
import { buildVisualizerTheme } from '../components/app/presentation/buildVisualizerTheme';
import { buildBuiltinDualTheme } from '../hooks/themeControllerState';
import { extractColors } from '../utils/colorExtractor';
import { findLatestActiveLineIndex } from '../utils/appPlaybackHelpers';
import { NO_LYRIC_LINES } from '../utils/lyrics/noLyricLines';
import { buildObsAppearanceFromShortcode } from '../utils/obsWebAppearance';
import type { DualTheme, Line, VisualizerMode } from '../types';
import { ERROR_TEXT, loadYouTubeApi, parseLink, playableList, thumbUrl, type ParsedLink } from './youtube';
import { autoFind, getLrc, guessTrack, searchLrc, toLines, type LrcRecord } from './lyrics';
import { ExpiredError, GOOGLE_CLIENT_ID, listMyPlaylists, listPlaylistVideoIds, loadGsi, type MyPlaylist } from './google';

const SOURCE_URL = 'https://github.com/lyxuan0604-bot/lyric-stage';
const FOLIA_URL = 'https://github.com/chthollyphile/folia-major';
const SAMPLE = 'https://music.youtube.com/watch?v=YQHsXMglC9A';
const EMPTY_SPECTRUM = new Uint8Array(0);

const store = {
  get<T>(k: string, d: T): T {
    try { const v = localStorage.getItem(`ls:${k}`); return v == null ? d : (JSON.parse(v) as T); } catch { return d; }
  },
  set(k: string, v: unknown) {
    try { localStorage.setItem(`ls:${k}`, JSON.stringify(v)); } catch { /* storage blocked */ }
  },
};

const fmt = (s: number) => {
  const n = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

type Panel = 'none' | 'link' | 'modes' | 'library' | 'lyrics';
interface Recent { id: string; title: string; author: string }

const Icon: React.FC<{ d: string }> = ({ d }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>
);
const I = {
  play: 'M7 4v16l13-8z',
  pause: 'M6 4h4v16H6zm8 0h4v16h-4z',
  prev: 'M6 5h2v14H6zM20 5v14L9 12z',
  next: 'M16 5h2v14h-2zM4 5v14l11-7z',
  link: 'M10.6 13.4a1 1 0 0 1 0-1.4l3.4-3.4a3 3 0 1 1 4.2 4.2l-2 2-1.4-1.4 2-2a1 1 0 1 0-1.4-1.4L12 13.4a1 1 0 0 1-1.4 0zM13.4 10.6a1 1 0 0 1 0 1.4L10 15.4a3 3 0 1 1-4.2-4.2l2-2 1.4 1.4-2 2a1 1 0 1 0 1.4 1.4L12 10.6a1 1 0 0 1 1.4 0z',
  modes: 'M4 5h16v2H4zm0 6h10v2H4zm0 6h16v2H4zm13-7l4 2-4 2z',
  library: 'M4 4h2v16H4zm4 0h2v16H8zm5.5.6l1.9-.6 4.6 15.4-1.9.6z',
  lyrics: 'M4 5h16v2H4zm0 4h16v2H4zm0 4h10v2H4zm0 4h7v2H4zm13-4v6.3a2.5 2.5 0 1 1-2-2.4V13z',
  full: 'M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z',
  video: 'M3 6h13v12H3zm14 4 4-3v10l-4-3z',
};

const YouTubeStageApp: React.FC = () => {
  const { t } = useTranslation();

  // ---------- player / clock ----------
  const playerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [duration, setDuration] = useState(0);
  const [hasPlaylist, setHasPlaylist] = useState(false);
  const [msg, setMsg] = useState('');
  const [videoSmall, setVideoSmall] = useState(() => store.get('videoSmall', false));
  const pendingStartRef = useRef<string | null>(null);
  const pendingRememberRef = useRef<Recent | null>(null);
  const videoIdRef = useRef<string | null>(null);
  const clockRef = useRef({ apiTime: 0, at: 0, playing: false });

  const currentTime = useMotionValue(0);
  const audioPower = useMotionValue(0);
  const bass = useMotionValue(0);
  const lowMid = useMotionValue(0);
  const mid = useMotionValue(0);
  const vocal = useMotionValue(0);
  const treble = useMotionValue(0);
  const spectrum = useMotionValue(EMPTY_SPECTRUM);
  const audioBands = useMemo(() => ({ bass, lowMid, mid, vocal, treble, spectrum }), [bass, lowMid, mid, vocal, treble, spectrum]);

  // ---------- lyrics ----------
  const [lines, setLines] = useState<Line[]>([]);
  const [lyricNote, setLyricNote] = useState('');
  const [currentLineIndex, setCurrentLineIndex] = useState(-1);
  const linesRef = useRef<Line[]>([]);
  linesRef.current = lines;
  const lineIndexRef = useRef(-1);
  const [offset, setOffset] = useState(0);
  const offsetRef = useRef(0);
  offsetRef.current = offset;
  const lyricTokenRef = useRef(0);
  const [finderTrack, setFinderTrack] = useState('');
  const [finderArtist, setFinderArtist] = useState('');
  const [finderResults, setFinderResults] = useState<LrcRecord[] | null>(null);
  const [finderState, setFinderState] = useState('');

  // ---------- look ----------
  const [mode, setMode] = useState<VisualizerMode>(() => {
    const saved = store.get<string>('foliaMode', DEFAULT_VISUALIZER_MODE);
    return hasVisualizerMode(saved) ? saved : DEFAULT_VISUALIZER_MODE;
  });
  const [builtinDualTheme, setBuiltinDualTheme] = useState<DualTheme>(() => buildBuiltinDualTheme());
  const [panel, setPanel] = useState<Panel>('none');
  const [linkText, setLinkText] = useState('');
  const [recent, setRecent] = useState<Recent[]>(() => store.get<Recent[]>('recent', []));
  const [chromeHidden, setChromeHidden] = useState(false);
  const idleTimerRef = useRef(0);

  // ---------- library ----------
  const tokenRef = useRef<string | null>(null);
  const tokenClientRef = useRef<any>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [playlists, setPlaylists] = useState<MyPlaylist[]>([]);
  const [libNote, setLibNote] = useState('登录后可以直接放你在 YouTube Music 里的歌单和点过喜欢的歌');

  const remember = useCallback((r: Recent) => {
    if (!r.title) return;
    setRecent((prev) => {
      const next = [r, ...prev.filter((x) => x.id !== r.id)].slice(0, 8);
      store.set('recent', next);
      return next;
    });
  }, []);

  // ---------- lyric loading ----------
  const applyRecord = useCallback((rec: LrcRecord | null) => {
    const res = toLines(rec);
    setLines(res.lines);
    lineIndexRef.current = -1;
    setCurrentLineIndex(-1);
    setLyricNote(
      res.kind === 'synced' ? ''
        : res.kind === 'instrumental' ? '这是一首纯音乐，没有歌词'
          : res.kind === 'plain' ? '这首歌只找到了不带时间的歌词，没法跟着动。可以点“歌词”手动换一个'
            : '没找到这首歌的歌词。可以点“歌词”手动找',
    );
  }, []);

  const loadLyricsFor = useCallback(async (id: string, songTitle: string, songAuthor: string, dur: number) => {
    const token = ++lyricTokenRef.current;
    setLines([]);
    setLyricNote('正在找歌词…');
    const saved = store.get<number | null>(`lrc:${id}`, null);
    if (saved) {
      const rec = await getLrc(saved).catch(() => null);
      if (token !== lyricTokenRef.current) return;
      if (rec) { applyRecord(rec); return; }
    }
    const guess = guessTrack(songTitle, songAuthor);
    setFinderTrack(guess.track);
    setFinderArtist(guess.artist);
    const rec = await autoFind(guess, dur);
    if (token !== lyricTokenRef.current) return;
    applyRecord(rec);
  }, [applyRecord]);

  const onNewVideo = useCallback(async (id: string) => {
    videoIdRef.current = id;
    setVideoId(id);
    setOffset(store.get(`off:${id}`, 0));
    setMsg('');
    const p = playerRef.current;
    let d: any = {};
    for (let i = 0; i < 12; i += 1) {
      d = p?.getVideoData?.() || {};
      if (d.video_id === id && d.title) break;
      await new Promise((r) => setTimeout(r, 250));
      if (videoIdRef.current !== id) return;
    }
    const songTitle = d.title || '';
    const songAuthor = d.author || '';
    setTitle(songTitle);
    setAuthor(songAuthor);
    document.title = songTitle ? `${songTitle} · 歌词舞台` : '歌词舞台';
    const entry = { id, title: songTitle, author: songAuthor };
    if (clockRef.current.playing) remember(entry); else pendingRememberRef.current = entry;
    const dur = p?.getDuration?.() || 0;
    void loadLyricsFor(id, songTitle, songAuthor, dur > 0 ? dur : 0);
  }, [loadLyricsFor, remember]);

  const checkVideoChange = useCallback(() => {
    const d = playerRef.current?.getVideoData?.();
    if (d?.video_id && d.video_id !== videoIdRef.current) void onNewVideo(d.video_id);
  }, [onNewVideo]);

  // ---------- create the YouTube player ----------
  useEffect(() => {
    let cancelled = false;
    loadYouTubeApi().then((YT) => {
      if (cancelled || playerRef.current) return;
      playerRef.current = new YT.Player('ls-yt', {
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin },
        events: {
          onReady: () => {
            setReady(true);
            const first = store.get<Recent[]>('recent', [])[0]?.id || parseLink(SAMPLE)!.v!;
            playerRef.current.cueVideoById(first);
            setTimeout(checkVideoChange, 600);
          },
          onStateChange: (e: any) => {
            const p = playerRef.current;
            const isPlaying = e.data === YT.PlayerState.PLAYING;
            clockRef.current = { apiTime: p.getCurrentTime?.() || 0, at: performance.now(), playing: isPlaying };
            setPlaying(isPlaying);
            setDuration(p.getDuration?.() || 0);
            if (isPlaying && pendingRememberRef.current && pendingRememberRef.current.id === videoIdRef.current) {
              remember(pendingRememberRef.current);
              pendingRememberRef.current = null;
            }
            const pl = p.getPlaylist?.();
            if (pendingStartRef.current && pl?.length) {
              const idx = pl.indexOf(pendingStartRef.current);
              pendingStartRef.current = null;
              if (idx > 0) { p.playVideoAt(idx); return; }
            }
            setHasPlaylist(!!(pl && pl.length > 1));
            checkVideoChange();
          },
          onError: (e: any) => setMsg(ERROR_TEXT[e.data] || '这首歌放不了，换一首试试'),
        },
      });
    }).catch(() => setMsg('YouTube 播放器加载不出来，检查一下网络（需要能打开 YouTube）'));
    return () => { cancelled = true; };
  }, [checkVideoChange, remember]);

  // ---------- clock: interpolate the player's coarse time every frame ----------
  useEffect(() => {
    let frame = 0;
    let lastCheck = 0;
    const tick = (now: number) => {
      const p = playerRef.current;
      if (p?.getCurrentTime) {
        const c = clockRef.current;
        const raw = p.getCurrentTime() || 0;
        if (raw !== c.apiTime) { c.apiTime = raw; c.at = now; }
        const rate = p.getPlaybackRate?.() || 1;
        const time = c.playing ? c.apiTime + Math.min(1, (now - c.at) / 1000) * rate : c.apiTime;
        const lyricTime = time - offsetRef.current;
        currentTime.set(lyricTime);
        const ls = linesRef.current;
        const idx = ls.length ? findLatestActiveLineIndex(ls, lyricTime) : -1;
        if (idx !== lineIndexRef.current) { lineIndexRef.current = idx; setCurrentLineIndex(idx); }
        if (now - lastCheck > 1000) { lastCheck = now; checkVideoChange(); }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [currentTime, checkVideoChange]);

  // ---------- theme from the cover colours, like Folia's builtin theme ----------
  const coverUrl = videoId ? thumbUrl(videoId) : null;
  useEffect(() => {
    let cancelled = false;
    if (!coverUrl) return () => { cancelled = true; };
    void extractColors(coverUrl, 5)
      .then((colors) => { if (!cancelled) setBuiltinDualTheme(buildBuiltinDualTheme({ coverColors: colors })); })
      .catch(() => { if (!cancelled) setBuiltinDualTheme(buildBuiltinDualTheme()); });
    return () => { cancelled = true; };
  }, [coverUrl]);

  const appearance = useMemo(
    () => buildObsAppearanceFromShortcode(null, { isDaylight: false, transparent: false, visualizerOverride: mode }),
    [mode],
  );
  const theme = builtinDualTheme.dark;
  const { visualizerTheme, visualizerSubtitleTheme } = buildVisualizerTheme({
    appStyle: {},
    theme,
    lyricsFontStyle: theme.fontStyle,
    lyricsFontWeight: appearance.lyricsFontWeight,
    lyricsCustomFontFamily: null,
    lyricsFontFallbackFamilies: appearance.lyricsFontFallbackFamilies,
    subtitleFontInheritsLyrics: appearance.subtitleFontInheritsLyrics,
    subtitleFontStyle: appearance.subtitleFontStyle,
    subtitleFontWeight: appearance.subtitleFontWeight,
    subtitleFontFamily: appearance.subtitleFontFamily,
    subtitleFontFallbackFamilies: appearance.subtitleFontFallbackFamilies,
    visualizerMode: appearance.mode,
  });

  // ---------- actions ----------
  const playLink = useCallback((link: ParsedLink) => {
    const p = playerRef.current;
    if (!p?.loadVideoById) { setMsg('播放器还在加载，请稍等几秒再试'); return; }
    setMsg(link.list === 'LM' ? '“我喜欢的音乐”是私人歌单，别的网站读不到。登录后可以在“我的音乐库”里放“我点过喜欢的”' : '');
    const list = playableList(link);
    if (list) {
      pendingStartRef.current = link.v;
      p.loadPlaylist({ list, listType: 'playlist', index: 0 });
    } else if (link.v) {
      if (link.v === videoIdRef.current) p.playVideo(); else p.loadVideoById(link.v);
    } else {
      setMsg('这个链接里没有找到能播放的歌曲');
    }
  }, []);

  const submitLink = (e?: React.FormEvent) => {
    e?.preventDefault();
    const link = parseLink(linkText);
    if (!link) { setMsg('这不像是 YouTube 的链接。请在 YouTube Music 里点“分享 → 复制链接”再贴过来'); return; }
    playLink(link);
    setPanel('none');
  };

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p?.getPlayerState) return;
    if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo();
  }, []);

  const bumpOffset = (d: number) => {
    setOffset((o) => {
      const n = Math.round((o + d) * 10) / 10;
      if (videoIdRef.current) store.set(`off:${videoIdRef.current}`, n);
      return n;
    });
  };

  const chooseMode = (m: VisualizerMode) => { setMode(m); store.set('foliaMode', m); };

  const onLyricLineSeek = useCallback((lyricTimeSec: number) => {
    const p = playerRef.current;
    if (!p?.seekTo) return;
    p.seekTo(Math.max(0, lyricTimeSec + offsetRef.current), true);
    p.playVideo();
  }, []);

  const runFinder = async (e: React.FormEvent) => {
    e.preventDefault();
    const track = finderTrack.trim();
    const artist = finderArtist.trim();
    if (!track) { setFinderState('先填一下歌名'); return; }
    setFinderState('搜索中…');
    setFinderResults(null);
    let list = await searchLrc(artist ? { track_name: track, artist_name: artist } : { q: track }).catch(() => null);
    if (list && !list.length && artist) list = await searchLrc({ q: `${artist} ${track}` }).catch(() => null);
    if (list == null) { setFinderState('歌词库连不上，检查一下网络再试'); return; }
    setFinderState(list.length ? '' : '没搜到。试试只填歌名，或者换成英文 / 原文歌名');
    setFinderResults(list.slice(0, 12));
  };

  const useRecord = (r: LrcRecord) => {
    if (videoIdRef.current) store.set(`lrc:${videoIdRef.current}`, r.id);
    lyricTokenRef.current += 1;
    applyRecord(r);
    setPanel('none');
  };

  // ---------- Google library ----------
  const loadLibrary = useCallback(async () => {
    const token = tokenRef.current;
    if (!token) return;
    setLibNote('正在读取你的歌单…');
    try {
      const all = await listMyPlaylists(token);
      setPlaylists(all);
      setLibNote('点一个歌单开始放');
    } catch (err) {
      if (err instanceof ExpiredError) { tokenRef.current = null; setSignedIn(false); setLibNote('登录过期了，再点一次登录'); }
      else setLibNote('读取歌单失败。如果你从没用这个谷歌账号开过 YouTube 频道，可能读不到');
    }
  }, []);

  const signIn = async () => {
    try {
      await loadGsi();
    } catch {
      setLibNote('连不上谷歌登录服务，检查一下网络');
      return;
    }
    if (!tokenClientRef.current) {
      tokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/youtube.readonly',
        callback: (resp: any) => {
          if (resp.error || !resp.access_token) { setLibNote('没有登录成功，可以再点一次试试'); return; }
          tokenRef.current = resp.access_token;
          setSignedIn(true);
          void loadLibrary();
        },
        error_callback: (err: any) => setLibNote(err?.type === 'popup_closed'
          ? '登录窗口被关掉了，再点一次就行'
          : '登录窗口打不开，检查一下浏览器是不是拦截了弹窗'),
      });
    }
    tokenClientRef.current.requestAccessToken({ prompt: tokenRef.current ? '' : 'select_account' });
  };

  const signOut = () => {
    if (tokenRef.current) window.google?.accounts?.oauth2?.revoke(tokenRef.current, () => {});
    tokenRef.current = null;
    setSignedIn(false);
    setPlaylists([]);
    setLibNote('已退出。登录后可以直接放你在 YouTube Music 里的歌单和点过喜欢的歌');
  };

  const playMyPlaylist = async (pl: MyPlaylist) => {
    const token = tokenRef.current;
    if (!token) return;
    setLibNote(`正在读取「${pl.title}」…`);
    try {
      const ids = await listPlaylistVideoIds(token, pl.id);
      if (!ids.length) { setLibNote(`「${pl.title}」里没有能播放的歌`); return; }
      playerRef.current?.loadPlaylist(ids, 0);
      setLibNote(`正在放「${pl.title}」，共 ${ids.length} 首${ids.length >= 200 ? '（最多读前 200 首）' : ''}`);
      setPanel('none');
    } catch (err) {
      if (err instanceof ExpiredError) { tokenRef.current = null; setSignedIn(false); setLibNote('登录过期了，再点一次登录'); }
      else setLibNote('读取歌单失败，稍后再试');
    }
  };

  // ---------- keyboard, fullscreen, auto-hide controls ----------
  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } catch { /* not supported */ }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === 'Escape') { setPanel('none'); return; }
      if (target.closest('input, button, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, toggleFullscreen]);

  useEffect(() => {
    const wake = () => {
      setChromeHidden(false);
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(() => setChromeHidden(true), 3500);
    };
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
      window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  // ---------- progress bar ----------
  const [seekValue, setSeekValue] = useState<number | null>(null);
  const [shownTime, setShownTime] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (p?.getCurrentTime) { setShownTime(p.getCurrentTime() || 0); setDuration(p.getDuration?.() || 0); }
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const hideChrome = chromeHidden && panel === 'none' && playing;
  const shownLines = lines.length ? lines : NO_LYRIC_LINES;

  return (
    <div className={`ls-root${hideChrome ? ' ls-idle' : ''}`} style={{ backgroundColor: theme.backgroundColor, color: theme.primaryColor }}>
      <div className="ls-vis">
        <VisualizerRenderer
          mode={mode}
          visualizerTunings={appearance.visualizerTunings}
          currentTime={currentTime}
          currentLineIndex={currentLineIndex}
          lines={shownLines}
          theme={visualizerTheme}
          subtitleTheme={visualizerSubtitleTheme}
          isDaylight={false}
          audioPower={audioPower}
          audioBands={audioBands}
          songTitle={title || null}
          songArtist={author || null}
          coverUrl={coverUrl}
          showText={true}
          seed={videoId || 'lyric-stage'}
          paused={!playing}
          staticMode={appearance.staticMode}
          visualizerOpacity={appearance.visualizerOpacity}
          background={appearance.background}
          lyricsFontScale={appearance.lyricsFontScale}
          subtitleFontScale={appearance.subtitleFontScale}
          subtitleOverlayBackground={appearance.subtitleOverlayBackground}
          subtitleUpcomingLyricsBlur={appearance.subtitleUpcomingLyricsBlur}
          subtitleOverlayOpacity={appearance.subtitleOverlayOpacity}
          showHarmonySubtitle={appearance.showHarmonySubtitle}
          harmonySubtitleBackground={appearance.harmonySubtitleBackground}
          hideTranslationSubtitle={appearance.hideTranslationSubtitle}
          showSubtitleTranslation={appearance.showSubtitleTranslation}
          subtitleContentMode={appearance.subtitleContentMode}
          isPlayerChromeHidden={true}
          onLyricLineSeek={onLyricLineSeek}
        />
      </div>

      {lyricNote && <div className="ls-note" role="status">{lyricNote}</div>}

      <div className={`ls-video${videoSmall ? ' small' : ''}`}>
        <div id="ls-yt" />
      </div>

      {panel !== 'none' && <div className="ls-scrim" onClick={() => setPanel('none')} />}

      {panel === 'link' && (
        <section className="ls-panel" aria-label="放一首歌">
          <h2>放一首歌</h2>
          <p>在 YouTube Music 里点“分享 → 复制链接”，贴到下面。单曲和歌单都可以。</p>
          <form className="ls-row" onSubmit={submitLink}>
            <input
              id="ls-link"
              autoFocus
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
              onPaste={(e) => {
                const text = e.clipboardData.getData('text');
                const link = parseLink(text);
                if (link) { e.preventDefault(); setLinkText(text); playLink(link); setPanel('none'); }
              }}
              placeholder={SAMPLE}
              aria-label="歌曲或歌单链接"
            />
            <button type="submit" className="ls-primary">播放</button>
          </form>
          {recent.length > 0 && (
            <>
              <h3>最近播放</h3>
              <ul className="ls-list">
                {recent.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => { playLink({ v: r.id, list: null }); setPanel('none'); }}>
                      <img src={`https://i.ytimg.com/vi/${r.id}/default.jpg`} alt="" loading="lazy" />
                      <span className="ls-t"><b>{r.title}</b><small>{r.author}</small></span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {panel === 'modes' && (
        <section className="ls-panel" aria-label="歌词动画">
          <h2>歌词动画</h2>
          <p>这些动画来自开源项目 Folia。</p>
          <div className="ls-modes">
            {VISUALIZER_REGISTRY.map((entry) => (
              <button
                key={entry.mode}
                type="button"
                aria-pressed={entry.mode === mode}
                onClick={() => chooseMode(entry.mode)}
              >
                {getVisualizerModeLabel(entry.mode, t)}
              </button>
            ))}
          </div>
        </section>
      )}

      {panel === 'library' && (
        <section className="ls-panel" aria-label="我的音乐库">
          <div className="ls-head">
            <h2>我的音乐库</h2>
            {signedIn && <button type="button" className="ls-chip" onClick={signOut}>退出登录</button>}
          </div>
          {!signedIn && (
            <button type="button" className="ls-google" onClick={() => void signIn()}>
              <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.7 17.8 9.5 24 9.5z" /><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.7 6c4.5-4.2 6.9-10.3 6.9-17.7z" /><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" /><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.5-5 2.3-8.2 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" /></svg>
              用 Google 账号登录
            </button>
          )}
          <p>{libNote}</p>
          {playlists.length > 0 && (
            <ul className="ls-list">
              {playlists.map((pl) => (
                <li key={pl.id}>
                  <button type="button" onClick={() => void playMyPlaylist(pl)}>
                    {pl.thumb ? <img src={pl.thumb} alt="" loading="lazy" /> : <span className="ls-ph">♥</span>}
                    <span className="ls-t"><b>{pl.title}</b><small>{pl.count != null ? `${pl.count} 首` : '你点过“喜欢”的歌'}</small></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {panel === 'lyrics' && (
        <section className="ls-panel" aria-label="歌词">
          <h2>歌词</h2>
          <div className="ls-offset">
            <span>歌词快慢</span>
            <button type="button" className="ls-chip" onClick={() => bumpOffset(-0.3)} aria-label="歌词提早出现">−</button>
            <b>{offset > 0 ? '+' : ''}{offset.toFixed(1)} 秒</b>
            <button type="button" className="ls-chip" onClick={() => bumpOffset(0.3)} aria-label="歌词推迟出现">+</button>
          </div>
          <h3>手动找歌词</h3>
          <p>改一下歌名或歌手再搜。点一个结果就会用它，下次放这首歌会记住。</p>
          <form className="ls-row" onSubmit={(e) => void runFinder(e)}>
            <input id="ls-ftrack" value={finderTrack} onChange={(e) => setFinderTrack(e.target.value)} placeholder="歌名" aria-label="歌名" />
            <input id="ls-fartist" value={finderArtist} onChange={(e) => setFinderArtist(e.target.value)} placeholder="歌手（可不填）" aria-label="歌手" />
            <button type="submit" className="ls-primary">搜索</button>
          </form>
          {finderState && <p>{finderState}</p>}
          {finderResults && finderResults.length > 0 && (
            <ul className="ls-results">
              {finderResults.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => useRecord(r)}>
                    <span>{r.trackName} — {r.artistName}{r.syncedLyrics ? <em>会跟着走</em> : null}</span>
                    <small>{fmt(r.duration)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <footer className="ls-bar">
        {msg && <div className="ls-msg" role="alert">{msg}</div>}
        <div className="ls-bar-inner">
          <div className="ls-song">
            {coverUrl && <img src={coverUrl} alt="" />}
            <div className="ls-t">
              <b>{title || (ready ? '还没有歌曲' : '正在加载播放器…')}</b>
              <small>{author || '点“放歌”贴一个 YouTube Music 链接'}</small>
            </div>
          </div>
          <div className="ls-transport">
            <button type="button" className="ls-icon" onClick={() => playerRef.current?.previousVideo()} disabled={!hasPlaylist} aria-label="上一首"><Icon d={I.prev} /></button>
            <button type="button" className="ls-icon ls-big" onClick={togglePlay} aria-label={playing ? '暂停' : '播放'}><Icon d={playing ? I.pause : I.play} /></button>
            <button type="button" className="ls-icon" onClick={() => playerRef.current?.nextVideo()} disabled={!hasPlaylist} aria-label="下一首"><Icon d={I.next} /></button>
            <div className="ls-seek">
              <span>{fmt(seekValue ?? shownTime)}</span>
              <input
                id="ls-seek"
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={seekValue ?? shownTime}
                onChange={(e) => setSeekValue(Number(e.target.value))}
                onPointerUp={() => { if (seekValue != null) { playerRef.current?.seekTo(seekValue, true); setSeekValue(null); } }}
                onKeyUp={() => { if (seekValue != null) { playerRef.current?.seekTo(seekValue, true); setSeekValue(null); } }}
                aria-label="播放进度"
              />
              <span>{fmt(duration)}</span>
            </div>
          </div>
          <nav className="ls-tools">
            <button type="button" className={`ls-tool${panel === 'link' ? ' on' : ''}`} onClick={() => setPanel(panel === 'link' ? 'none' : 'link')}><Icon d={I.link} /><span>放歌</span></button>
            <button type="button" className={`ls-tool${panel === 'library' ? ' on' : ''}`} onClick={() => setPanel(panel === 'library' ? 'none' : 'library')}><Icon d={I.library} /><span>音乐库</span></button>
            <button type="button" className={`ls-tool${panel === 'modes' ? ' on' : ''}`} onClick={() => setPanel(panel === 'modes' ? 'none' : 'modes')}><Icon d={I.modes} /><span>动画</span></button>
            <button type="button" className={`ls-tool${panel === 'lyrics' ? ' on' : ''}`} onClick={() => setPanel(panel === 'lyrics' ? 'none' : 'lyrics')}><Icon d={I.lyrics} /><span>歌词</span></button>
            <button type="button" className="ls-tool" onClick={() => { const v = !videoSmall; setVideoSmall(v); store.set('videoSmall', v); }}><Icon d={I.video} /><span>{videoSmall ? '大视频' : '小视频'}</span></button>
            <button type="button" className="ls-tool" onClick={toggleFullscreen}><Icon d={I.full} /><span>全屏</span></button>
          </nav>
        </div>
        <div className="ls-credit">
          动画来自开源项目 <a href={FOLIA_URL} target="_blank" rel="noreferrer">Folia</a>，按 AGPL-3.0 许可修改使用 · <a href={SOURCE_URL} target="_blank" rel="noreferrer">本站源代码</a>
        </div>
      </footer>
    </div>
  );
};

export default YouTubeStageApp;
