import { BaseLLMProvider } from './base.js';

/**
 * Provider for OpenAI-compatible APIs (ChatGPT, OpenRouter, any OpenAI-compatible endpoint).
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  get name() {
    return this.config.providerName || 'openai';
  }

  get baseUrl() {
    return this.config.baseUrl || 'https://api.openai.com/v1';
  }

  get model() {
    return this.config.model || 'gpt-5';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    if (this.config.supportsVision != null) return !!this.config.supportsVision;
    const m = (this.config.model || '').toLowerCase();
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|llava|qwen.*vl|qwen2.*vl|qwen3.*vl|pixtral|llama.*vision|gemma.*vision|gemma-?[34]/.test(m);
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    // OpenRouter-specific headers
    if (this.config.providerName === 'openrouter') {
      headers['HTTP-Referer'] = this.config.siteUrl || 'https://github.com/esokullu/webbrain';
      headers['X-Title'] = 'WebBrain';
    }
    return headers;
  }

  /**
   * Newer OpenAI models (gpt-5, gpt-4.1+, o1, o3, o4) reject `max_tokens`
   * and require `max_completion_tokens` instead. LM Studio and other local
   * OpenAI-compatible servers only accept `max_tokens`. Detect by model
   * name and provider type.
   */
  _useMaxCompletionTokens() {
    const m = (this.config.model || '').toLowerCase();
    if (this.config.providerName === 'lmstudio') return false;
    return /^(gpt-5|gpt-4\.1|o1|o3|o4)/.test(m);
  }

  _addMaxTokens(body, options) {
    const max = options.maxTokens ?? 4096;
    if (this._useMaxCompletionTokens()) {
      body.max_completion_tokens = max;
    } else {
      body.max_tokens = max;
    }
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.7,
      stream: false,
    };
    this._addMaxTokens(body, options);

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const message = choice?.message;

    return {
      content: message?.content || '',
      toolCalls: message?.tool_calls || null,
      usage: data.usage || null,
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    const body = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.7,
      stream: true,
    };
    this._addMaxTokens(body, options);

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} stream error ${res.status}: ${err}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') {
          yield { type: 'done', content: '' };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'text', content: delta.content };
          }
          if (delta?.tool_calls) {
            yield { type: 'tool_call', content: delta.tool_calls };
          }
        } catch {
          // skip
        }
      }
    }
    yield { type: 'done', content: '' };
  }
}
