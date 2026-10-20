/**
 * 豆包语音合成（V3 HTTP 单向流式）：一次请求拿回整句 mp3。
 * 按音色选资源和鉴权：
 *   - 复刻音色（S_ 开头）：seed-icl-2.0，新版控制台的 API Key（X-Api-Key）；固定按中文念（复刻时用的参考音频可能是别的语言）
 *   - 2.0 音色（…_uranus_bigtts）：seed-tts-2.0，新版控制台的 API Key
 *   - 其余（1.0 音色）：seed-tts-1.0，旧版控制台的 APP ID + Access Token
 * 密钥不进配置：通过 DSH 的 credentials 服务按名字取（DOUBAO_TTS_API_KEY / DOUBAO_TTS_APP_ID / DOUBAO_TTS_ACCESS_KEY）。
 */

import { randomUUID } from 'node:crypto';
import { DEFAULT_VOICE, usesNewConsole } from './voices';

export { DEFAULT_VOICE };
export const TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export interface TtsAuth {
  /** 旧版控制台（1.0 音色） */
  appId?: string;
  accessKey?: string;
  /** 新版控制台（2.0 音色、复刻音色） */
  apiKey?: string;
}

interface VoiceRoute {
  resource: string;
  /** 新版控制台的 API Key 还是旧版的 APP ID + Access Token */
  newConsole: boolean;
  additions?: Record<string, unknown>;
}

export function routeOf(voice: string): VoiceRoute {
  if (voice.startsWith('S_')) return { resource: 'seed-icl-2.0', newConsole: true, additions: { explicit_language: 'zh-cn' } };
  if (usesNewConsole(voice)) return { resource: 'seed-tts-2.0', newConsole: true };
  return { resource: 'seed-tts-1.0', newConsole: false };
}

/** 这个音色要的密钥配齐了没有 */
export function canSpeak(auth: TtsAuth, voice: string): boolean {
  return routeOf(voice).newConsole ? !!auth.apiKey : !!(auth.appId && auth.accessKey);
}

/** 逐字时间：这个字（可能带着后面的标点）在音频里从几秒念到几秒 */
export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

export interface Speech {
  audio: Uint8Array;
  /** 开了 enable_subtitle 才有；按音频里的先后排好 */
  words: TimedWord[];
}

/** rate：语速（-50 到 100，0 是正常） */
export async function synthesize(auth: TtsAuth, voice: string, text: string, signal: AbortSignal, rate = 0): Promise<Speech> {
  const route = routeOf(voice);
  const keyHeaders: Record<string, string> = route.newConsole
    ? { 'X-Api-Key': auth.apiKey ?? '' }
    : { 'X-Api-App-Id': auth.appId ?? '', 'X-Api-Access-Key': auth.accessKey ?? '' };
  const res = await fetch(TTS_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...keyHeaders,
      'X-Api-Resource-Id': route.resource,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify({
      user: { uid: 'dsh-livestream' },
      req_params: {
        text,
        speaker: voice,
        // enable_subtitle：每句念完后带回逐字时间（音频里的绝对秒数），字幕按它走，不按字数估
        audio_params: { format: 'mp3', sample_rate: 24000, enable_subtitle: true, ...(rate ? { speech_rate: rate } : {}) },
        ...(route.additions ? { additions: JSON.stringify(route.additions) } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`豆包语音 HTTP ${res.status}（${route.resource}）`);
  const chunks: Buffer[] = [];
  const words: TimedWord[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line) as {
      code?: number; message?: string; data?: string;
      sentence?: { words?: Array<{ word?: string; startTime?: number; endTime?: number }> };
    };
    if (msg.data) chunks.push(Buffer.from(msg.data, 'base64'));
    // 第一条 sentence 是整段文字（words 为空），后面每句一条带逐字时间
    else if (msg.sentence?.words?.length) {
      for (const w of msg.sentence.words) {
        if (w.word && typeof w.startTime === 'number' && typeof w.endTime === 'number') words.push({ word: w.word, start: w.startTime, end: w.endTime });
      }
    } else if (msg.code && msg.code !== 20000000) throw new Error(`豆包语音 ${msg.code} ${msg.message ?? ''}`);
  }
  words.sort((a, b) => a.start - b.start);
  return { audio: new Uint8Array(Buffer.concat(chunks)), words };
}

/**
 * 逐字时间 → 字幕时间线：每个字开始念时亮到它前面，念完时亮到它（连同带着的标点）。
 * 按顺序在原文里找每个字，对不上的跳过（服务端偶尔改写个别字）；返回 [亮到第几个字, 音频里的毫秒]
 */
export function subtitleTimeline(text: string, words: TimedWord[]): Array<{ chars: number; atMs: number }> {
  const chars = [...text];
  const points: Array<{ chars: number; atMs: number }> = [];
  let cursor = 0;
  for (const w of words) {
    const piece = [...w.word];
    // 只用第一个字定位（后面可能粘着标点），在接下来几个字里找
    let found = -1;
    for (let i = cursor; i < Math.min(chars.length, cursor + 8); i++) {
      if (chars[i] === piece[0]) { found = i; break; }
    }
    if (found < 0) continue;
    points.push({ chars: found, atMs: Math.round(w.start * 1000) });
    cursor = Math.min(chars.length, found + piece.length);
    points.push({ chars: cursor, atMs: Math.round(w.end * 1000) });
  }
  return points;
}

/** 没有音频时按字数估朗读时长 */
export function estimateSpeechMs(text: string): number {
  return Math.max(1500, text.length * 230);
}
