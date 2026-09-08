import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { SavedMessage } from "./database.js";

type ProviderName = "gemini" | "groq" | "openrouter" | "openai" | "anthropic";

type Provider = {
  name: ProviderName;
  generate: (prompt: string) => Promise<string>;
};

const geminiKey = process.env.GEMINI_API_KEY;
const groqKey = process.env.GROQ_API_KEY;
const openRouterKey = process.env.OPENROUTER_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;

const providers: Provider[] = [];

if (geminiKey) {
  providers.push({
    name: "gemini",
    generate: async (prompt) => {
      const model = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(30000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
          }),
        },
      );

      const body = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        error?: { message?: string };
      };

      if (!response.ok) {
        throw new Error(body.error?.message ?? `Gemini HTTP ${response.status}`);
      }

      const answer = body.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("")
        .trim();

      if (!answer) {
        throw new Error("Gemini returned an empty response");
      }

      return answer;
    },
  });
}

function addOpenAICompatibleProvider(
  name: "groq" | "openrouter" | "openai",
  apiKey: string,
  baseURL: string | undefined,
  model: string,
  defaultHeaders?: Record<string, string>,
): void {
  const client = new OpenAI({ apiKey, baseURL, defaultHeaders });
  providers.push({
    name,
    generate: async (prompt) => {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
      });

      return response.choices[0]?.message.content ?? `Не удалось получить ответ от ${name}.`;
    },
  });
}

if (groqKey) {
  addOpenAICompatibleProvider(
    "groq",
    groqKey,
    "https://api.groq.com/openai/v1",
    process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  );
}

if (openRouterKey) {
  addOpenAICompatibleProvider(
    "openrouter",
    openRouterKey,
    "https://openrouter.ai/api/v1",
    process.env.OPENROUTER_MODEL ?? "google/gemma-4-26b-a4b-it:free",
    {
      "HTTP-Referer": "https://github.com/Klepchelka_bot",
      "X-OpenRouter-Title": "Klepchelka Bot",
    },
  );
}

if (openaiKey) {
  addOpenAICompatibleProvider(
    "openai",
    openaiKey,
    undefined,
    process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  );
}

if (anthropicKey) {
  const anthropic = new Anthropic({ apiKey: anthropicKey });
  providers.push({
    name: "anthropic",
    generate: async (prompt) => {
      const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-haiku-latest",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content.find((block) => block.type === "text");
      return text?.type === "text" ? text.text : "Не удалось получить ответ от Claude.";
    },
  });
}

function buildPrompt(messages: SavedMessage[], text: string): string {
  const history = messages
    .map((message) => `${message.role}: ${message.text}`)
    .join("\n");

  return [
    "Ты полезный русскоязычный ассистент в Telegram.",
    "Отвечай кратко, естественно и по существу.",
    history ? `История диалога:\n${history}` : "",
    `Новое сообщение пользователя:\n${text}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function generateAnswer(
  messages: SavedMessage[],
  text: string,
): Promise<{ provider: ProviderName; answer: string }> {
  if (providers.length === 0) {
    throw new Error("No AI providers configured");
  }

  const prompt = buildPrompt(messages, text);
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const answer = await provider.generate(prompt);
      console.log(`AI response from ${provider.name}`);
      return { provider: provider.name, answer };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${provider.name}: ${message}`);
      console.error(`AI provider ${provider.name} failed: ${message}`);
    }
  }

  throw new Error(`All AI providers failed: ${errors.join(" | ")}`);
}
