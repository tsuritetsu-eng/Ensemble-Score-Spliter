const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";
const GEMINI_MODEL = "gemini-2.5-flash-lite";

const ALLOWED_ORIGINS = new Set([
  "https://tsuritetsu-eng.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);

const MAX_JSON_BYTES = 7 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const GEMINI_TIMEOUT_MS = 55000;

function corsHeaders(origin) {
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function readTextWithLimit(request, maxBytes) {
  if (!request.body) throw new Error("EMPTY_BODY");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseImage(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("IMAGE_REQUIRED");
  }

  let mime = "image/jpeg";
  let base64 = value.trim();
  const dataUriMatch = base64.match(/^data:(image\/(?:jpeg|png|webp));base64,([\s\S]+)$/i);
  if (dataUriMatch) {
    mime = dataUriMatch[1].toLowerCase();
    base64 = dataUriMatch[2];
  }

  base64 = base64.replace(/\s/g, "");
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("INVALID_IMAGE_BASE64");
  }

  const estimatedBytes = Math.floor((base64.length * 3) / 4) -
    (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_IMAGE_BYTES) {
    throw new Error("IMAGE_TOO_LARGE");
  }

  return { mime, base64, dataUri: `data:${mime};base64,${base64}` };
}

function cleanPartName(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/^\s*["'“”]+|["'“”]+\s*$/g, "")
    .replace(/^(part|instrument|楽器|パート)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);
    const requestId = crypto.randomUUID();

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ error: "Origin not allowed", requestId }, 403, "");
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({
        ok: true,
        service: "sheet-music-parser",
        model: GEMINI_MODEL
      }, 200, origin);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed", requestId }, 405, origin);
    }

    if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
      return jsonResponse({ error: "Content-Type must be application/json", requestId }, 415, origin);
    }

    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_JSON_BYTES) {
      return jsonResponse({ error: "Request body is too large", requestId }, 413, origin);
    }

    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ error: "Worker secret GEMINI_API_KEY is not configured", requestId }, 500, origin);
    }

    let payload;
    try {
      const rawBody = await readTextWithLimit(request, MAX_JSON_BYTES);
      payload = JSON.parse(rawBody);
    } catch (error) {
      const tooLarge = error?.message === "BODY_TOO_LARGE";
      return jsonResponse({
        error: tooLarge ? "Request body is too large" : "Invalid JSON request body",
        requestId
      }, tooLarge ? 413 : 400, origin);
    }

    let image;
    try {
      image = parseImage(payload?.image);
    } catch (error) {
      const messages = {
        IMAGE_REQUIRED: "Image data is required",
        INVALID_IMAGE_BASE64: "Image must be valid Base64 image data",
        IMAGE_TOO_LARGE: "Image exceeds the 5 MB limit"
      };
      return jsonResponse({
        error: messages[error.message] || "Invalid image data",
        requestId
      }, 400, origin);
    }

    const prompt = [
      "You are identifying the instrument or part name printed in the header of a sheet-music page.",
      "Read only the visible header text in the supplied image.",
      "Return only the part or instrument name, preserving useful qualifiers and numbering, such as 'Flute', 'Bb Clarinet 2', 'Violin I', or 'Full Score'.",
      "Do not describe the image. Do not guess if the header is unreadable; return exactly UNKNOWN.",
      "Output plain text only, with no quotation marks or explanation."
    ].join(" ");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(GEMINI_ENDPOINT, {
        method: "POST",
        headers: {
          "x-goog-api-key": env.GEMINI_API_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              { inline_data: { mime_type: image.mime, data: image.base64 } }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 48,
            responseMimeType: "text/plain"
          }
        }),
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      return jsonResponse({
        error: timedOut ? "Gemini request timed out" : "Could not connect to Gemini API",
        requestId
      }, timedOut ? 504 : 502, origin);
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      let providerMessage = "";
      try {
        const providerBody = await upstream.text();
        let parsed;
        try { parsed = JSON.parse(providerBody); } catch { parsed = null; }
        const candidate =
          parsed?.detail ||
          parsed?.message ||
          parsed?.error?.message ||
          parsed?.error?.detail ||
          parsed?.error ||
          parsed?.title ||
          providerBody;
        if (typeof candidate === "string") {
          providerMessage = candidate
            .replace(/Bearer\\s+\\S+/gi, "Bearer [redacted]")
            .replace(/(api[_-]?key|token|secret)\\s*[:=]\\s*[^\\s,;]+/gi, "$1=[redacted]")
            .replace(/[\\r\\n\\t]+/g, " ")
            .trim()
            .slice(0, 500);
        }
      } catch {
        providerMessage = "";
      }
      return jsonResponse({
        error: "Gemini API returned an error",
        upstreamStatus: upstream.status,
        details: providerMessage || "NVIDIAから詳細情報のないエラー応答が返されました",
        requestId
      }, 502, origin);
    }

    let result;
    try {
      result = await upstream.json();
    } catch {
      return jsonResponse({ error: "Gemini returned an invalid response", requestId }, 502, origin);
    }

    const content = result?.candidates?.[0]?.content?.parts;
    const rawText = Array.isArray(content)
      ? content.map(part => typeof part?.text === "string" ? part.text : "").join(" ")
      : "";
    const partName = cleanPartName(rawText);

    if (!partName || partName.toUpperCase() === "UNKNOWN") {
      return jsonResponse({
        partName: "",
        recognized: false,
        message: "Header text could not be identified",
        model: GEMINI_MODEL,
        requestId
      }, 200, origin);
    }

    return jsonResponse({
      partName,
      recognized: true,
      model: GEMINI_MODEL,
      requestId
    }, 200, origin);
  }
};
