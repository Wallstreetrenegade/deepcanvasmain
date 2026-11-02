export type ProviderDefaults = { api_base: string; model: string };
export type ProviderBucket = 'chat' | 'video' | 'audio' | 'vision' | 'embed';

export const PROVIDER_DEFAULTS: Record<ProviderBucket, Record<string, ProviderDefaults>> = {
  chat: {
    OpenAI: { api_base: 'https://api.openai.com/v1', model: 'gpt-5.4-mini' },
    OpenRouter: { api_base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5.4-mini' },
    Gemini: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash' },
    Google: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-pro' },
    Anthropic: { api_base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5-20250929' },
    DashScope: { api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
    SiliconFlow: { api_base: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
    InferenceAffinity: { api_base: '', model: '' },
  },
  video: {
    OpenAI: { api_base: 'https://api.openai.com/v1', model: 'sora-2' },
    Gemini: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'veo-3.0-generate-preview' },
    Google: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'veo-3.0-generate-preview' },
    FalAI: { api_base: 'https://fal.run/', model: 'fal-ai/veo3' },
  },
  audio: {
    OpenAI: { api_base: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts' },
    Google: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash-preview-tts' },
    Gemini: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash-preview-tts' },
    ElevenLabs: { api_base: 'https://api.elevenlabs.io/v1/', model: 'eleven_multilingual_v2' },
  },
  vision: {
    OpenAI: { api_base: 'https://api.openai.com/v1', model: 'gpt-image-1' },
    Google: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'imagen-4.0-generate-preview' },
    Gemini: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash-image-preview' },
    FalAI: { api_base: 'https://fal.run/', model: 'fal-ai/flux/dev' },
  },
  embed: {
    OpenAI: { api_base: 'https://api.openai.com/v1', model: 'text-embedding-3-small' },
    Google: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'text-embedding-004' },
    Gemini: { api_base: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'text-embedding-004' },
    Anthropic: { api_base: 'https://api.voyageai.com/v1', model: 'voyage-3' },
  },
};

export const PROJECT_FLOW_AI_PROVIDERS = [
  { value: 'OpenAI', label: 'OpenAI' },
  { value: 'Google', label: 'Google Gemini' },
  { value: 'Anthropic', label: 'Anthropic Claude' },
] as const;

export const CHAT_PROVIDER_MODELS: Record<string, string[]> = {
  OpenAI: ['gpt-5.4-mini', 'gpt-5.4', 'gpt-5.2-chat-latest', 'gpt-5.2', 'gpt-5.2-pro', 'gpt-5.2-codex', 'gpt-5-mini', 'gpt-5.5'],
  Google: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview'],
  Gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-flash-preview', 'gemini-3-pro-preview'],
  Anthropic: ['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'],
  OpenRouter: [
    'openai/gpt-5.4-mini',
    'openai/gpt-5.4',
    'openai/gpt-5.2-chat-latest',
    'openai/gpt-5.2',
    'openai/gpt-5.2-pro',
    'openai/gpt-5.2-codex',
    'openai/gpt-5-mini',
    'openai/gpt-5.5',
    'anthropic/claude-sonnet-4.5',
    'anthropic/claude-opus-4.1',
    'google/gemini-2.5-pro',
    'google/gemini-2.5-flash',
    'google/gemini-3-flash-preview',
    'google/gemini-3-pro-preview',
    'x-ai/grok-4',
    'deepseek/deepseek-chat',
    'deepseek/deepseek-r1',
    'qwen/qwen-max',
    'meta-llama/llama-4-maverick',
  ],
  DashScope: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  SiliconFlow: ['deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1'],
};

export function providerKeyParts(key: string): { prefix: string; bucket: ProviderBucket } | null {
  if (key === 'model_provider') return { prefix: '', bucket: 'chat' };
  if (key === 'features_provider') return { prefix: 'features_', bucket: 'chat' };
  if (key === 'video_provider') return { prefix: 'video_', bucket: 'video' };
  if (key === 'audio_provider') return { prefix: 'audio_', bucket: 'audio' };
  if (key === 'vision_provider') return { prefix: 'vision_', bucket: 'vision' };
  if (key === 'embed_provider') return { prefix: 'embed_', bucket: 'embed' };
  return null;
}

export function getProviderOptions(key: string): Array<{ value: string; label: string }> {
  if (key.startsWith('video_')) {
    return [
      { value: 'OpenAI', label: 'OpenAI' },
      { value: 'Gemini', label: 'Google Gemini' },
      { value: 'Google', label: 'Google' },
      { value: 'FalAI', label: 'FAL.ai' },
    ];
  }
  if (key.startsWith('audio_')) {
    return [
      { value: 'OpenAI', label: 'OpenAI' },
      { value: 'Google', label: 'Google' },
      { value: 'Gemini', label: 'Google Gemini' },
      { value: 'ElevenLabs', label: 'ElevenLabs' },
    ];
  }
  if (key.startsWith('vision_')) {
    return [
      { value: 'OpenAI', label: 'OpenAI' },
      { value: 'Google', label: 'Google' },
      { value: 'Gemini', label: 'Google Gemini' },
      { value: 'FalAI', label: 'FAL.ai' },
    ];
  }
  return [
    { value: 'OpenAI', label: 'OpenAI' },
    { value: 'Google', label: 'Google' },
    { value: 'Gemini', label: 'Google Gemini' },
    { value: 'Anthropic', label: 'Anthropic Claude' },
    { value: 'OpenRouter', label: 'OpenRouter' },
    { value: 'DashScope', label: 'DashScope' },
    { value: 'SiliconFlow', label: 'SiliconFlow' },
    { value: 'InferenceAffinity', label: 'InferenceAffinity' },
  ];
}

export function getProviderDefault(bucket: ProviderBucket, provider: string): ProviderDefaults {
  return PROVIDER_DEFAULTS[bucket]?.[provider] ?? { api_base: '', model: '' };
}

export function getProviderModels(bucket: ProviderBucket, provider: string): string[] {
  if (bucket === 'chat') return CHAT_PROVIDER_MODELS[provider] ?? [];
  const fallback = getProviderDefault(bucket, provider).model;
  return fallback ? [fallback] : [];
}

export function normalizeModelSelection(bucket: ProviderBucket, provider: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed || getProviderModels(bucket, provider).includes(trimmed)) return trimmed;
  if (isKnownProviderDefault(bucket, 'model', trimmed)) {
    return getProviderDefault(bucket, provider).model;
  }
  return trimmed;
}

export function isKnownProviderDefault(bucket: ProviderBucket, field: keyof ProviderDefaults, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return Object.values(PROVIDER_DEFAULTS[bucket] ?? {}).some((defaults) => defaults[field] === trimmed);
}
