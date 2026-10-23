// "My library": Google sign-in (read-only YouTube scope) to list the user's playlists.
// The access token lives in memory only.

export const GOOGLE_CLIENT_ID = '65308532488-1qtv1ccde6lng8fja6i0h24tjfnrk1it.apps.googleusercontent.com';
const YT_API = 'https://www.googleapis.com/youtube/v3';

declare global {
  interface Window { google?: any }
}

let gsiPromise: Promise<void> | null = null;
export const loadGsi = () => {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gsiPromise) return gsiPromise;
  gsiPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gsiPromise = null; reject(new Error('gsi')); };
    document.head.appendChild(s);
  });
  return gsiPromise;
};

export class ExpiredError extends Error {}

const ytGet = async (token: string, path: string, params: Record<string, string>) => {
  const r = await fetch(`${YT_API}/${path}?${new URLSearchParams(params)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.status === 401) throw new ExpiredError('expired');
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
};

export interface MyPlaylist { id: string; title: string; count: number | null; thumb: string | null }

export const listMyPlaylists = async (token: string): Promise<MyPlaylist[]> => {
  const all: MyPlaylist[] = [{ id: 'LL', title: '我点过喜欢的', count: null, thumb: null }];
  let page = '';
  for (let i = 0; i < 4; i += 1) {
    const d = await ytGet(token, 'playlists', {
      part: 'snippet,contentDetails', mine: 'true', maxResults: '50', ...(page ? { pageToken: page } : {}),
    });
    for (const p of d.items || []) {
      const thumb = p.snippet?.thumbnails?.default?.url;
      all.push({
        id: p.id,
        title: p.snippet?.title || '未命名歌单',
        count: p.contentDetails?.itemCount ?? null,
        thumb: typeof thumb === 'string' && /^https:\/\/i\d*\.ytimg\.com\//.test(thumb) ? thumb : null,
      });
    }
    page = d.nextPageToken;
    if (!page) break;
  }
  return all;
};

export const listPlaylistVideoIds = async (token: string, playlistId: string) => {
  const ids: string[] = [];
  let page = '';
  for (let i = 0; i < 4 && ids.length < 200; i += 1) {
    const d = await ytGet(token, 'playlistItems', {
      part: 'contentDetails,status', playlistId, maxResults: '50', ...(page ? { pageToken: page } : {}),
    });
    for (const it of d.items || []) {
      const v = it.contentDetails?.videoId;
      if (v && /^[\w-]{11}$/.test(v) && it.status?.privacyStatus !== 'private') ids.push(v);
    }
    page = d.nextPageToken;
    if (!page) break;
  }
  return ids.slice(0, 200);
};
