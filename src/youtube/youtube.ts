// YouTube IFrame player helpers: load the API once and turn a pasted link into a video / playlist.

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<any> | null = null;

export const loadYouTubeApi = (): Promise<any> => {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('youtube-api')); };
    document.head.appendChild(s);
  });
  return apiPromise;
};

export interface ParsedLink { v: string | null; list: string | null }

export const parseLink = (raw: string): ParsedLink | null => {
  const str = (raw || '').trim();
  if (/^[\w-]{11}$/.test(str)) return { v: str, list: null };
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(str) ? str : `https://${str}`); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (!/(^|\.)youtube\.com$|^youtu\.be$|youtube-nocookie\.com$/.test(host)) return null;
  let v = u.searchParams.get('v');
  const list = u.searchParams.get('list');
  if (host === 'youtu.be') v = u.pathname.slice(1).split('/')[0];
  const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/);
  if (m) v = m[1];
  if (v && !/^[\w-]{11}$/.test(v)) v = null;
  if (!v && !list) return null;
  return { v, list };
};

// RDAMVM / RDMM / RD+video are auto-generated radio mixes the embed player cannot load;
// RDCLAK lists are YouTube Music's own curated playlists and play fine.
export const playableList = (link: ParsedLink): string | null => {
  if (!link.list || link.list === 'LM') return null;
  const isRadio = /^RD/.test(link.list) && !/^RDCLAK/.test(link.list);
  return isRadio && link.v ? null : link.list;
};

export const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

export const ERROR_TEXT: Record<number, string> = {
  2: '链接好像不完整，请重新复制一次',
  5: '播放器出错了，刷新页面再试试',
  100: '找不到这首歌，可能已经被删掉或者设成了私密',
  101: '这首歌的版权方不允许在别的网站播放。可以在 YouTube 上搜同一首歌的其他版本（比如歌词版）再贴过来',
  150: '这首歌的版权方不允许在别的网站播放。可以在 YouTube 上搜同一首歌的其他版本（比如歌词版）再贴过来',
};
