import * as cheerio from "cheerio";

const MAX_RESPONSE_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 12_000;

export type UrlContext = {
  url: string;
  title?: string;
  text: string;
  durationMs: number;
};

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s<>]+/i);
  return match?.[0]?.replace(/[),.!?]+$/, "");
}

async function readLimitedBody(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(`response is too large: ${contentLength} bytes`);
  }

  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error(`response is too large: ${body.byteLength} bytes`);
  }

  return new TextDecoder().decode(body);
}

function extractText(body: string, contentType: string): { title?: string; text: string } {
  if (!contentType.includes("html")) {
    return { text: body.trim() };
  }

  const $ = cheerio.load(body);
  $("script, style, noscript, svg, nav, footer, header, form").remove();
  const title = $("title").first().text().trim() || undefined;
  const text = $("body").text().replace(/\s+/g, " ").trim();

  return { title, text };
}

export async function loadUrlContext(message: string): Promise<UrlContext | undefined> {
  const url = extractFirstUrl(message);
  if (!url) {
    return undefined;
  }

  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("only http and https URLs are supported");
  }
  if (isBlockedHostname(parsed.hostname)) {
    throw new Error("URL host is not allowed");
  }

  const started = performance.now();
  console.log(`[URL] fetch started url=${url}`);
  const response = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "KlepchelkaBot/1.0 (+URL context reader)",
      Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
    },
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`redirect ${response.status} is not followed`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const body = await readLimitedBody(response);
  const extracted = extractText(body, response.headers.get("content-type") ?? "");
  const text = extracted.text.slice(0, 30_000);
  const durationMs = Math.round(performance.now() - started);

  if (!text) {
    throw new Error("page contains no readable text");
  }

  console.log(`[URL] fetch succeeded durationMs=${durationMs} chars=${text.length}`);
  return { url, title: extracted.title, text, durationMs };
}
