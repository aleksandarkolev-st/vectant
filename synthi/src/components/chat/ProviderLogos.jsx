'use client';

/**
 * Provider logos for the chat model picker.
 *
 * Each component takes a single optional `size` prop (defaults to 14) and
 * inherits its colour from the surrounding text via `currentColor`. The
 * shapes are simplified, brand-recognisable marks rather than the full
 * trademarked logos so we can ship them as inline SVG without a licence
 * dependency or a network round-trip.
 */

const Wrap = ({ size = 14, children, label }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        role="img"
        aria-label={label}
        fill="none"
    >
        {children}
    </svg>
);

export const AnthropicLogo = ({ size = 14, color = '#D97757' }) => (
    <Wrap size={size} label="Anthropic">
        {/* Stylised "A" mark inspired by the Claude wordmark. */}
        <path
            d="M5 19 L10.5 5 H13.5 L19 19 H16 L14.7 15.5 H9.3 L8 19 Z M10.2 13 H13.8 L12 8.2 Z"
            fill={color}
        />
    </Wrap>
);

export const OpenAILogo = ({ size = 14, color = '#10A37F' }) => (
    <Wrap size={size} label="OpenAI">
        {/* Six-petal rosette echoing the OpenAI mark. */}
        <g fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4.5 L18 7.5 V13.5 L12 16.5 L6 13.5 V7.5 Z" />
            <path d="M12 4.5 V10 M18 7.5 L12 10 M6 7.5 L12 10 M12 10 V16.5" />
            <path d="M5 12 Q8 9 12 10 Q16 9 19 12" opacity="0.45" />
        </g>
    </Wrap>
);

export const GeminiLogo = ({ size = 14, color = '#4285F4' }) => (
    <Wrap size={size} label="Gemini">
        {/* Four-pointed star (Gemini sparkle). */}
        <path
            d="M12 2 L13.6 9.2 L20.5 11 L13.6 12.8 L12 22 L10.4 12.8 L3.5 11 L10.4 9.2 Z"
            fill={color}
        />
    </Wrap>
);

export const SparklesLogo = ({ size = 14, color = 'currentColor' }) => (
    <Wrap size={size} label="Custom">
        <path
            d="M12 3 L13 9 L19 10 L13 11 L12 17 L11 11 L5 10 L11 9 Z M18 14 L18.5 17 L21.5 17.5 L18.5 18 L18 21 L17.5 18 L14.5 17.5 L17.5 17 Z"
            fill={color}
        />
    </Wrap>
);

/**
 * Static metadata for the chat model selector. Add an entry here to surface
 * a new model in the UI without touching AIChatWindow.
 */
export const PROVIDER_OPTIONS = [
    {
        provider: 'gemini',
        label: 'Gemini',
        sublabel: 'Google · long-context default',
        defaultModel: 'gemini-3.1-flash-lite-preview',
        models: [
            { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite' },
            { id: 'gemini-3.1-pro',                label: 'Gemini 3.1 Pro' },
            { id: 'gemini-2.5-pro',                label: 'Gemini 2.5 Pro' },
            { id: 'gemini-2.5-flash',              label: 'Gemini 2.5 Flash' },
        ],
        Logo: GeminiLogo,
        accent: '#4285F4',
    },
    {
        provider: 'anthropic',
        label: 'Claude',
        sublabel: 'Anthropic · best at code',
        defaultModel: 'claude-sonnet-4-6',
        models: [
            { id: 'claude-opus-4-7',     label: 'Claude Opus 4.7' },
            { id: 'claude-sonnet-4-6',   label: 'Claude Sonnet 4.6' },
            { id: 'claude-haiku-4-5',    label: 'Claude Haiku 4.5' },
        ],
        Logo: AnthropicLogo,
        accent: '#D97757',
    },
    {
        provider: 'openai',
        label: 'ChatGPT',
        sublabel: 'OpenAI · GPT family',
        defaultModel: 'gpt-4o-mini',
        models: [
            { id: 'gpt-4.1',     label: 'GPT-4.1' },
            { id: 'gpt-4o',      label: 'GPT-4o' },
            { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
            { id: 'o3',          label: 'o3' },
            { id: 'o4-mini',     label: 'o4-mini' },
        ],
        Logo: OpenAILogo,
        accent: '#10A37F',
    },
    {
        provider: 'custom',
        label: 'Custom',
        sublabel: 'Bring your own model & key',
        defaultModel: '',
        models: [],
        Logo: SparklesLogo,
        accent: 'var(--accent-secondary, #4aba9a)',
    },
];

export const getProviderMeta = (provider) =>
    PROVIDER_OPTIONS.find((p) => p.provider === provider) || PROVIDER_OPTIONS[0];
