# PDF Sheet Music Editor

## Cloudflare Worker: AI part-name recognition

The frontend calls:

- `https://sheet-music-parser.mrtsuritetsu.workers.dev/`
- Method: `POST`
- JSON body: `{ "image": "<base64 JPEG>" }`
- Success response: `{ "partName": "Flute", "recognized": true, "model": "meta/llama-3.2-11b-vision-instruct" }`

Worker source: [worker/index.js](worker/index.js)

### Configure the NVIDIA API key

Set the Cloudflare Worker secret named `NVIDIA_API_KEY`. Never put the key in `index.html`, this repository, or a public configuration file.

### Deploy

From the repository root, after installing and authenticating Wrangler:

```sh
npx wrangler secret put NVIDIA_API_KEY
npx wrangler deploy
```

The command for the secret prompts for its value. Do not paste the key into source code or commit it.

### Health check

Open `https://sheet-music-parser.mrtsuritetsu.workers.dev/health`. A healthy Worker returns JSON containing `ok: true` and the model name.

### Notes

- CORS allows the GitHub Pages origin `https://tsuritetsu-eng.github.io` and common local development origins.
- Requests are limited to 5 MB decoded image data.
- NVIDIA calls time out after 55 seconds.
- Configure a Cloudflare rate-limiting rule for the Worker route to protect the public endpoint from excessive use. CORS is not authentication and does not stop direct non-browser requests.
