import type { ProviderId, ProviderPreset } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat",
    docsUrl: "https://api-docs.deepseek.com/",
    authStyle: "bearer",
    notes:
      "deepseek-chat is the fast general model; deepseek-reasoner emits chain-of-thought and is slower but stronger at multi-step tool use.",
  },
  qwen: {
    id: "qwen",
    label: "Qwen (DashScope compatible mode)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    models: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max"],
    defaultModel: "qwen-plus",
    docsUrl:
      "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope",
    authStyle: "bearer",
    notes:
      "Use dashscope-intl.aliyuncs.com for the international region and dashscope.aliyuncs.com for mainland China. Keys are region-specific.",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    baseUrl: "http://localhost:8000/v1/chat/completions",
    models: [],
    defaultModel: "",
    docsUrl: "",
    authStyle: "bearer",
    notes:
      "Enter the full endpoint URL; it is used exactly as typed. Any server accepting OpenAI-style chat requests with tool calling works: vLLM, SGLang, Ollama, LM Studio, OpenRouter, Together, Fireworks.",
  },
};

export const PROVIDER_LIST: ProviderPreset[] = [
  PROVIDERS.deepseek,
  PROVIDERS.qwen,
  PROVIDERS.custom,
];
