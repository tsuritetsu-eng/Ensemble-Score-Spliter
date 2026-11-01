const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";
const GEMINI_MODEL = "gemini-3.5-flash-lite";

const ALLOWED_ORIGINS = new Set([
  "https://tsuritetsu-eng.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
]);

const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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
  if (typeof value !== "string" || !value.trim()) throw new Error("IMAGE_REQUIRED");
  const base64 = value.replace(/\\s/g, "");
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("INVALID_IMAGE_BASE64");
  }
  const estimatedBytes = Math.floor((base64.length * 3) / 4) -
    (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (estimatedBytes <= 0 || estimatedBytes > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
  return { base64, estimatedBytes };
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
      image = parseImage(payload?.image ?? payload?.imageBase64 ?? payload?.imageData);
    } catch (error) {
      const messages = {
        IMAGE_REQUIRED: "Header image data is required",
        INVALID_IMAGE_BASE64: "Header image must be valid Base64 data",
        IMAGE_TOO_LARGE: "Header image exceeds the 8 MB limit"
      };
      return jsonResponse({
        error: messages[error.message] || "Invalid image data",
        receivedFields: payload && typeof payload === "object" ? Object.keys(payload) : [],
        requestId
      }, 400, origin);
    }

    const pageNumber = Number(payload?.pageNumber);
    const pageLabel = Number.isInteger(pageNumber) && pageNumber > 0 ? String(pageNumber) : "unknown";

    const prompt = [
      "You are reading the printed instrument/part label on a concert band sheet-music page.",
      "First locate the page's own instrument/part label anywhere on the image: top, bottom, left, right, center, near a staff, or inside a stamp/box. Do not mistake the composition title, composer, publisher, copyright, page number, watermark, or musical instructions for the part label.",
      "Stage 1: transcribe the instrument/part label as literally as possible into detectedText. Preserve useful words such as C, B-flat, E-flat, Bass, Trombone, Oboe, and part numbers. If part of it is unclear, include the readable portion rather than discarding the whole label.",
      "Stage 2: classify that text into exactly one canonical instrument name from this closed list. Ignore transposition prefixes such as C, B♭, E♭ and omit part numbers. Use the closest plausible instrument when the label is partly blurred, abbreviated, or obscured.",
      "Canonical list: Flute; Piccolo; Oboe; English Horn; Bassoon; E♭ Clarinet; B♭ Clarinet; Alto Clarinet; Bass Clarinet; Contrabass Clarinet; Soprano Saxophone; Alto Saxophone; Tenor Saxophone; Baritone Saxophone; Trumpet; Cornet; Flugelhorn; French Horn; Trombone; Bass Trombone; Euphonium; Tuba; Double Bass; Glockenspiel; Xylophone; Marimba; Vibraphone; Tubular Bells; Timpani; Snare Drum; Bass Drum; Crash Cymbals; Suspended Cymbal; Tambourine; Triangle; Tam-tam; Wood Block; Castanets; Shaker; Drum Set; Piano; Harp; Electric Bass.",
      "Common abbreviations include Fl., Picc., Ob., E.H., Bsn., E♭ Cl., B♭ Cl., A.Cl., B.Cl., Tpt., Tp., Tbn., Trb., B.Tbn., B.Trb., Euph., Tub., S.Sax., A.Sax., T.Sax., B.Sax., Glock., Xyl., Mar., Vib., Timp., S.D., B.D., Cym., Tamb., Tri., Pf., Hp., E.Bass.",
      "Return ONLY valid JSON with exactly these keys: detectedText (string), instrument (canonical list item or empty string), confidence (high, medium, or low). If no plausible part label is visible, use empty detectedText, empty instrument, and low confidence. Never return the word UNKNOWN.",
      "Example: for 'C Trombone II', return {\"detectedText\":\"C Trombone II\",\"instrument\":\"Trombone\",\"confidence\":\"high\"}. For 'Bass Trombone (bra)', return {\"detectedText\":\"Bass Trombone\",\"instrument\":\"Bass Trombone\",\"confidence\":\"medium\"}.",
      "This is source sheet-music page " + pageLabel + "."
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
              { inline_data: { mime_type: "image/jpeg", data: image.base64 } },
              { text: prompt + " This is source sheet-music page " + pageLabel + "." }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 160,
            responseMimeType: "application/json"
          }
        }),
        signal: controller.signal
      });
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      const diagnostic = String(error?.message || error || "Unknown fetch error")
        .split("\\r").join(" ").split("\\n").join(" ").split("\\t").join(" ")
        .slice(0, 250);
      return jsonResponse({
        error: timedOut ? "Gemini request timed out" : "Could not connect to Gemini API",
        details: diagnostic,
        errorName: String(error?.name || "Error").slice(0, 80),
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
        details: providerMessage || "Geminiから詳細情報のないエラー応答が返されました",
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
      ? content.map(part => typeof part?.text === "string" ? part.text : "").join(" ").trim()
      : "";
    const candidate = result?.candidates?.[0] || {};
    let parsed = null;
    try {
      const jsonMatch = rawText.match(/\\{[\\s\\S]*\\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (_) {}
    const detectedText = cleanPartName(parsed?.detectedText || "");
    const instrument = cleanPartName(parsed?.instrument || "");
    const confidence = ["high", "medium", "low"].includes(String(parsed?.confidence || "").toLowerCase())
      ? String(parsed.confidence).toLowerCase()
      : "low";

    return jsonResponse({
      detectedText,
      instrument,
      partName: instrument,
      confidence,
      recognized: Boolean(instrument || detectedText),
      message: instrument ? "" : "楽器名を確定できませんでした",
      model: GEMINI_MODEL,
      requestId,
      debug: {
        rawText: rawText.slice(0, 240),
        finishReason: candidate.finishReason || null,
        promptBlocked: Boolean(result?.promptFeedback?.blockReason)
      }
    }, 200, origin);
  }
};
