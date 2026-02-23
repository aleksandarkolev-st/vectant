import { NextResponse } from 'next/server';

/**
 * POST /api/theme-generate
 *
 * Accepts a user description and returns a complete set of theme
 * colour values that can be applied to the Theme Creator form.
 *
 * Body: { prompt: string, themeType: 'dark' | 'light' }
 * Response: NDJSON stream of { delta } chunks, final { colors, themeName, done: true }
 */

const GEMINI_BASE =
  (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const DEFAULT_MODEL = process.env.SYNTHI_AI_MODEL || process.env.GEMINI_MODEL || 'gemini-3-flash';

/* ─── All theme colour keys the creator expects ─────────────────────────── */
const ALL_COLOR_KEYS = [
  // General
  'bgApp', 'bgSurface', 'bgElevated', 'background', 'foreground',
  // Sidebar
  'bgSidebar', 'sidebar', 'sidebarForeground', 'sidebarPrimary',
  'sidebarPrimaryForeground', 'sidebarAccent', 'sidebarAccentForeground',
  'sidebarBorder', 'sidebarRing',
  // Editor & Panels
  'bgEditor', 'bgPanel',
  // Text
  'textPrimary', 'textSecondary', 'textMuted', 'textDim', 'muted', 'mutedForeground',
  // Borders
  'borderSubtle', 'borderMedium', 'borderFocus', 'borderStrong', 'border', 'input',
  // Accents
  'accentPrimary', 'accentSecondary', 'accentTertiary',
  'accentDanger', 'accentDangerSoft', 'accentSuccess', 'accentWarning',
  'primary', 'primaryForeground', 'ring', 'destructive',
  // Syntax
  'syntaxKeyword', 'syntaxString', 'syntaxFunction',
  'syntaxComment', 'syntaxPreprocessor', 'syntaxNumber', 'syntaxType',
  // Components
  'card', 'cardForeground', 'popover', 'popoverForeground',
  'secondary', 'secondaryForeground', 'accent', 'accentForeground',
  // Charts
  'chart1', 'chart2', 'chart3', 'chart4', 'chart5',
  // Shadows (CSS box-shadow strings, not hex)
  'shadowPanel', 'shadowDropdown', 'shadowGlow',
];

const SHADOW_KEYS = new Set(['shadowPanel', 'shadowDropdown', 'shadowGlow']);

function buildSystemPrompt(themeType) {
  return `You are a professional UI theme designer for a code editor IDE called Synthi.
The user will describe what kind of theme they want. You must generate a complete set of colour values for the theme.

Theme type: ${themeType}

RULES:
- Return ONLY a valid JSON object. No markdown fences, no explanation text.
- The JSON must have two top-level keys: "colors" (object of key→value) and "themeName" (a short creative name, 2-4 words).
- Every colour key listed below MUST be present in "colors".
- All values must be valid CSS hex colours (#rrggbb or #rrggbbaa) EXCEPT shadow keys which are CSS box-shadow strings.
- Ensure foreground/text colours have sufficient contrast against their background colours (WCAG AA 4.5:1 for text, 3:1 for large text).
- The theme should be cohesive, aesthetically pleasing, and suitable for long coding sessions.
- For ${themeType} themes, backgrounds should be ${themeType === 'dark' ? 'very dark (near-black)' : 'light (near-white)'} and text should be ${themeType === 'dark' ? 'light' : 'dark'}.

COLOUR KEYS (all required):
${ALL_COLOR_KEYS.map(k => SHADOW_KEYS.has(k) ? `${k} (CSS box-shadow string, e.g. "0 2px 8px rgba(0,0,0,0.5)")` : k).join('\n')}

RESPOND WITH ONLY THE JSON OBJECT. EXAMPLE FORMAT:
{"colors":{"bgApp":"#0a0b10","bgSurface":"#10111a",...},"themeName":"Midnight Ocean"}`;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { prompt, themeType = 'dark' } = body;

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return NextResponse.json({ error: 'A description is required.' }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      return NextResponse.json(
        { error: 'AI is not configured. Set GEMINI_API_KEY in your environment variables.' },
        { status: 503 },
      );
    }

    const model = DEFAULT_MODEL;
    const endpoint = `${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;

    const geminiBody = {
      contents: [
        { role: 'user', parts: [{ text: `${buildSystemPrompt(themeType)}\n\nUser request: ${prompt.trim()}` }] },
      ],
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    };

    const geminiRes = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => 'Unknown error');
      console.error('[theme-generate] Gemini error:', geminiRes.status, errText);
      return NextResponse.json(
        { error: `AI request failed (${geminiRes.status}). Please try again.` },
        { status: 502 },
      );
    }

    const geminiData = await geminiRes.json();
    const rawText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText) {
      return NextResponse.json({ error: 'AI returned an empty response.' }, { status: 502 });
    }

    // Parse JSON — strip markdown fences if model added them despite instructions
    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[theme-generate] Failed to parse AI JSON:', parseErr.message, '\nRaw:', cleaned.slice(0, 500));
      return NextResponse.json({ error: 'AI returned invalid data. Please try again.' }, { status: 502 });
    }

    // Validate structure
    const colors = parsed.colors || parsed;
    const themeName = parsed.themeName || 'AI Theme';

    // Ensure all keys are present (fill missing ones with sensible fallbacks)
    const result = {};
    for (const key of ALL_COLOR_KEYS) {
      if (colors[key]) {
        result[key] = colors[key];
      }
      // If missing, leave it out — the ThemeCreator will show it as unfilled
    }

    return NextResponse.json({ colors: result, themeName });
  } catch (err) {
    console.error('[theme-generate] Unexpected error:', err);
    return NextResponse.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}
