// Finds synced lyrics on LRCLIB (free, no key) and turns them into Folia's lyric lines.
import { parseLRC } from '../utils/lyrics/parserCore';
import type { Line } from '../types';

const LRC_API = 'https://lrclib.net/api';

export interface LrcRecord {
  id: number;
  trackName: string;
  artistName: string;
  duration: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

const getJSON = async <T,>(url: string): Promise<T> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(String(r.status));
  return r.json() as Promise<T>;
};

export const searchLrc = async (params: Record<string, string>): Promise<LrcRecord[]> => {
  const r = await getJSON<unknown>(`${LRC_API}/search?${new URLSearchParams(params)}`);
  return Array.isArray(r) ? (r as LrcRecord[]) : [];
};

export const getLrc = (id: number) => getJSON<LrcRecord>(`${LRC_API}/get/${id}`);

// Guess "track + artist" from a YouTube title like "Artist - Song (Official MV)".
export const guessTrack = (rawTitle: string, rawAuthor: string) => {
  let title = rawTitle || '';
  let artist = (rawAuthor || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '')
    .replace(/\s*(官方频道|Official( YouTube)?( Channel)?)$/i, '').trim();
  const isTopic = /-\s*Topic$/i.test(rawAuthor || '');
  const junk = /official|lyric|audio|video|\bmv\b|m\/v|\bhd\b|4k|visualizer|live|karaoke|remaster|歌词|歌詞|官方|動態|动态|完整版|高音质|高音質|字幕|music video/i;
  title = title.replace(/[([【（「『《][^)\]】）」』》]*[)\]】）」』》]/g, (m) => (junk.test(m) ? ' ' : m));
  const quoted = title.match(/[【《「『]([^】》」』]+)[】》」』]/);
  if (!isTopic) {
    const parts = title.split(/\s+[-–—|｜]\s+|\s*[｜|]\s*/);
    if (parts.length >= 2) {
      artist = parts[0].trim() || artist;
      title = parts.slice(1).join(' ');
    }
  }
  if (quoted) title = quoted[1];
  title = title
    .replace(/[([（][^)\]）]*\b(feat|ft)\.?\s[^)\]）]*[)\]）]/gi, ' ')
    .replace(/\s(feat|ft)\.?\s.*$/i, ' ')
    .replace(/\b(official (music )?video|official audio|lyrics?( video)?|audio)\b/gi, ' ')
    .replace(/[【】《》「」『』"“”]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return { track: title, artist };
};

const cjkOnly = (s: string) => (s.match(/[぀-ヿ㐀-鿿가-힯]+/g) || []).join(' ');

const pickBest = (list: LrcRecord[], dur: number) => {
  if (!list.length) return null;
  const score = (r: LrcRecord) => {
    let s = 0;
    if (r.syncedLyrics) s += 100;
    if (r.instrumental) s -= 200;
    if (dur && r.duration) s -= Math.min(60, Math.abs(r.duration - dur)) * 2;
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
};

export const autoFind = async (g: { track: string; artist: string }, dur: number) => {
  const tries: Record<string, string>[] = [];
  if (g.track && g.artist) tries.push({ track_name: g.track, artist_name: g.artist });
  if (g.track) tries.push({ q: [g.artist, g.track].filter(Boolean).join(' ') });
  if (g.track) tries.push({ q: g.track });
  const c = cjkOnly(g.track);
  if (c && c !== g.track) tries.push({ q: c });
  let fallback: LrcRecord | null = null;
  for (const params of tries) {
    const list = await searchLrc(params).catch(() => []);
    const best = pickBest(list, dur);
    if (best?.syncedLyrics) return best;
    if (best && !fallback) fallback = best;
  }
  return fallback;
};

// LRCLIB often stores a translation as a second line with the same timestamp. Split those out
// so Folia shows them as its translation subtitle instead of as separate lyric lines.
const splitTranslation = (lrc: string) => {
  const main: string[] = [];
  const trans: string[] = [];
  const seen = new Set<string>();
  for (const raw of lrc.split(/\r?\n/)) {
    const m = raw.match(/^((?:\[\d+:\d+(?:[.:]\d+)?\])+)(.*)$/);
    if (!m) { main.push(raw); continue; }
    const key = m[1];
    if (seen.has(key) && m[2].trim()) trans.push(raw);
    else { seen.add(key); main.push(raw); }
  }
  return { main: main.join('\n'), trans: trans.join('\n') };
};

export type LyricResult =
  | { kind: 'synced'; lines: Line[] }
  | { kind: 'plain' | 'instrumental' | 'none'; lines: Line[] };

export const toLines = (rec: LrcRecord | null): LyricResult => {
  if (rec?.syncedLyrics) {
    const { main, trans } = splitTranslation(rec.syncedLyrics);
    return { kind: 'synced', lines: parseLRC(main, trans).lines };
  }
  if (rec?.instrumental) return { kind: 'instrumental', lines: [] };
  if (rec?.plainLyrics) return { kind: 'plain', lines: [] };
  return { kind: 'none', lines: [] };
};
