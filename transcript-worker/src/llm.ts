import logger from './logger.js';
import type { SegmentRow } from './supabase.js';
import { assignSpeakers, groupBySpeaker } from './speakers.js';

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface MomResult {
  summary: string;
  decisions: string[];
  action_items: Array<{ owner?: string; task: string }>;
  discussion_points: string[];
  generated_at: string;
  model: string;
}

/**
 * Generate structured Minutes-of-Meeting from the transcript via any
 * OpenAI-compatible chat endpoint (Gemini, OpenAI, Mistral, Ollama...).
 * Production uses Gemini's OpenAI-compatible endpoint with a cheap
 * Flash-Lite model (see .env.example).
 * Returns null when LLM is not configured — the worker then completes with a
 * null MoM rather than failing.
 */
export async function generateMom(
  segments: SegmentRow[],
  config: LlmConfig,
  fetchImpl: typeof fetch = fetch,
  labels?: Map<string, string>,
): Promise<MomResult | null> {
  if (!config.apiKey || config.provider === 'none') {
    logger.info('llm: not configured, skipping MoM generation');
    return null;
  }

  const resolved = labels ?? assignSpeakers(segments);
  const lines = groupBySpeaker(segments, resolved);
  const transcriptText = lines
    .map((l) => `[${l.speaker}] ${l.text}`)
    .join('\n\n');
  const prompt = buildPrompt(transcriptText);

  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const request = () =>
    fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a meticulous meeting-minutes writer. You receive a raw, noisy ' +
              'auto-generated transcript from a team meeting (often a molecular tumor ' +
              'board, but summarize ANY topic faithfully). The transcript comes from ' +
              'streaming speech recognition: expect stutters, repeated phrases, mid-word ' +
              'cuts and imperfect grammar. Silently clean these up and extract the actual ' +
              'meaning - do NOT dismiss the content as noise unless it contains no words ' +
              'at all. Produce STRICT JSON with keys: summary (string; concise account of ' +
              'what was actually said), decisions (array of strings), action_items (array ' +
              'of objects {owner, task}), discussion_points (array of strings). Use only ' +
              'facts present in the transcript; never invent names, cases, numbers or ' +
              'outcomes. Attribute points to speakers where the labels allow. If the ' +
              'transcript is completely empty, write a one-sentence summary saying so and ' +
              'leave the arrays empty. Return ONLY the JSON object — no markdown fences, ' +
              'no commentary.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });

  // Retry transient failures (rate limits, provider hiccups). A MoM that could
  // have succeeded with one retry should not fail the whole meeting.
  const maxAttempts = 3;
  let res = await request();
  for (let attempt = 1; !res.ok && attempt < maxAttempts; attempt++) {
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) break;
    const delayMs = 1000 * 2 ** (attempt - 1);
    logger.warn(
      { status: res.status, attempt, delayMs },
      'llm: retryable error, backing off before retry',
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res = await request();
  }

  if (!res.ok) {
    throw new Error(`LLM request failed: ${res.status} ${await res.text().catch(() => '')}`);
  }

  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned no content');

  const parsed = parseMomJson(content);
  return {
    summary: String(parsed.summary ?? ''),
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    action_items: Array.isArray(parsed.action_items) ? parsed.action_items : [],
    discussion_points: Array.isArray(parsed.discussion_points) ? parsed.discussion_points : [],
    generated_at: new Date().toISOString(),
    model: config.model,
  };
}

/**
 * Parse MoM JSON, tolerating markdown fences some models (notably Gemini)
 * still wrap around `response_format: json_object` responses.
 */
export function parseMomJson(content: string): Omit<MomResult, 'generated_at' | 'model'> {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) {
    text = fence[1].trim();
  } else {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    text = text.slice(start, end + 1);
  }
  return JSON.parse(text) as Omit<MomResult, 'generated_at' | 'model'>;
}

function buildPrompt(transcriptText: string): string {
  return (
    'Here is the transcript of a meeting (timestamped, speaker-labeled - speaker ' +
    'names are auto-assigned channel labels, not real names):\n\n' +
    transcriptText +
    '\n\nSummarize this meeting as the structured JSON described by your system message.'
  );
}

function fmtTime(sec: number | null): string {
  if (sec === null) return '?';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}