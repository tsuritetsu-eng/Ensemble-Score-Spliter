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
      "You are an expert at identifying concert band and wind ensemble instrument labels on sheet music.",
      "The attached image may be a full-page image or a supplementary crop from one sheet-music page. The instrument/part label can appear anywhere: top or bottom, left or right margin, center, above or below the staff, or in a boxed/stamped area. Do NOT assume it is in the upper-left or at the top. Scan the entire supplied image systematically and locate the label that identifies the part for this page. Distinguish it from the composition title, composer, arranger, publisher, copyright, page number, watermark, and instrument names that appear only as musical text or instructions.",
      "Classify the label into exactly ONE canonical instrument name from this closed list. Return the canonical name only; never return an abbreviation or any text outside this list:",
      "Flute; Piccolo; Oboe; English Horn; Bassoon; E♭ Clarinet; B♭ Clarinet; Alto Clarinet; Bass Clarinet; Contrabass Clarinet; Soprano Saxophone; Alto Saxophone; Tenor Saxophone; Baritone Saxophone; Trumpet; Cornet; Flugelhorn; French Horn; Trombone; Bass Trombone; Euphonium; Tuba; Double Bass; Glockenspiel; Xylophone; Marimba; Vibraphone; Tubular Bells; Timpani; Snare Drum; Bass Drum; Crash Cymbals; Suspended Cymbal; Tambourine; Triangle; Tam-tam; Wood Block; Castanets; Shaker; Drum Set; Piano; Harp; Electric Bass.",
      "Recognize common abbreviations and variants: Fl., Picc., Ob., E.H., Bsn., E♭ Cl., B♭ Cl., A.Cl., B.Cl., C.B.Cl., S.Sax., A.Sax., T.Sax., B.Sax., Tpt., Tp., Cnt., Flg., Hn., Tbn., Trb., B.Tbn., B.Trb., Euph., Tub., C.B., St.Bass, Glock., Xyl., Mar., Vib., Timp., S.D., B.D., Cym., Sus.Cym., Tamb., Tri., Pf., Hp., E.Bass.",
      "Ignore transposing-key prefixes such as C, B♭, E♭ when they precede an instrument name. Keep the instrument classification canonical and omit part numbers such as 1, 2, 3, or 4.",
      "The printed part label is expected to be one of the instruments in this list. Even if the label is faint, cropped, abbreviated, or partly unreadable, choose the single closest matching instrument using the visible letter shapes and abbreviation patterns. Do not require a perfect spelling.",
      "Do not output UNKNOWN merely because the text is abbreviated or blurry. Output UNKNOWN only if there is no plausible instrument/part label visible anywhere in the image. Output exactly one canonical list item or UNKNOWN, with no explanation."
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
            maxOutputTokens: 48,
            responseMimeType: "text/plain"
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
      ? content.map(part => typeof part?.text === "string" ? part.text : "").join(" ")
      : "";
    const partName = cleanPartName(rawText);

    if (!partName || partName.toUpperCase() === "UNKNOWN") {
      const candidate = result?.candidates?.[0] || {};
      return jsonResponse({
        partName: "",
        recognized: false,
        message: "Geminiは楽器名を返しませんでした",
        model: GEMINI_MODEL,
        requestId,
        debug: {
          rawText: rawText.slice(0, 120),
          finishReason: candidate.finishReason || null,
          promptBlocked: Boolean(result?.promptFeedback?.blockReason)
        }
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
