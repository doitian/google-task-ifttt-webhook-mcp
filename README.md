# google-task-ifttt-webhook-mcp

MCP server running on Cloudflare Workers that exposes a `create_google_task` tool.
Sends tasks to Google Tasks via the [IFTTT Maker webhook](https://ifttt.com/maker_webhooks).

Authentication is handled by **Cloudflare Access** (Managed OAuth). The worker validates the `Cf-Access-Jwt-Assertion` JWT against Access JWKS.

## How it works

```
MCP Client                  Cloudflare Access          Cloudflare Worker         IFTTT
    |                             |                          |                     |
    |-- OAuth login ------------>|                          |                     |
    |<-- access granted ---------|                          |                     |
    |                             |                          |                     |
    |-- POST /mcp -------------->|-- Cf-Access-Jwt-Assertion->|                    |
    |                             |                          |-- POST JSON ------->|
    |                             |                          |<-- "Congratulations"|
    |<-- result -----------------|<-------------------------|                     |
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare account](https://dash.cloudflare.com/) with Workers enabled
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) (requires Cloudflare Zero Trust)
- IFTTT account with the [Maker Webhooks](https://ifttt.com/maker_webhooks) service connected
- A Google Tasks applet on IFTTT triggered by a JSON web request event named `task`

## Setup

### 1. Install dependencies

```pwsh
npm install
```

### 2. Get your IFTTT Maker key

1. Go to [IFTTT Maker Webhooks](https://ifttt.com/maker_webhooks)
2. Click **Documentation**
3. Your key is the last path segment of the URL shown:
   `https://maker.ifttt.com/use/{YOUR_KEY}`
4. Set it as a Worker secret:

```pwsh
npx wrangler secret put IFTTT_MAKER_TASK_KEY
```

### 3. Set up the IFTTT applet

Create an applet on IFTTT:

- **If**: Maker Webhooks → Receive a web request with a JSON payload, event name `task`
- **Then**: Google Tasks → Create a task
  - Title: `{{JsonPayload.title}}`
  - Notes: `{{JsonPayload.notes}}`
  - Due date: `{{JsonPayload.due}}`

The worker posts to:

`https://maker.ifttt.com/trigger/task/json/with/key/{KEY}`

with a JSON body like `{ "title": "...", "notes": "...", "due": "..." }`.

### 4. Configure Cloudflare Access

1. Go to [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** → **Applications** → **Add an application** → **Self-hosted**
3. Configure:
   - **Application name**: `google-task-mcp`
   - **Application domain**: your worker hostname (custom domain or `*.workers.dev`)
   - **Identity providers**: Select your preferred IdP (Google, GitHub, email OTP, etc.)
   - **Policy**: Create an allow policy for the users who should access the MCP server
   - **Managed OAuth (Beta)**: Must be enabled
4. Note your **team domain** (e.g. `myteam.cloudflareaccess.com`) and the **Application Audience (AUD)** tag
5. Set them as Worker secrets:

```pwsh
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

`CF_ACCESS_AUD` is optional but recommended (enables audience validation on the JWT).

### 5. Deploy

```pwsh
npm run deploy
```

### 6. Test locally (optional)

```pwsh
npm run dev
```

The worker is available at `http://localhost:8787`. When `CF_ACCESS_TEAM_DOMAIN` is unset, any present `Cf-Access-Jwt-Assertion` header is accepted (use a dummy value for local calls).

### 7. Configure the MCP client

Point the client at the worker URL (path `/` or `/mcp`). Auth is Cloudflare Access Managed OAuth — the client completes Access login; Access injects `Cf-Access-Jwt-Assertion` on requests to the worker.

#### opencode

```json
{
  "mcp": {
    "google-tasks": {
      "type": "remote",
      "url": "https://google-task-mcp.yourdomain.com/mcp",
      "oauth": {}
    }
  }
}
```

#### Claude Desktop / other streamable HTTP clients

Use your client's remote MCP + OAuth settings with:

`https://google-task-mcp.yourdomain.com/mcp`

## Tool: `create_google_task`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `title`   | yes      | Single-line task title |
| `notes`   | no       | Optional detailed notes. `\n` for line breaks |
| `due`     | no       | Optional due date in ISO 8601 UTC (e.g. `2026-07-25T23:59:59Z`) |

### Example MCP call

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "create_google_task",
    "arguments": {
      "title": "Buy groceries",
      "notes": "Milk, eggs, bread",
      "due": "2026-07-25T23:59:59Z"
    }
  }
}
```

## Secrets / env

| Name | Required | Description |
|------|----------|-------------|
| `IFTTT_MAKER_TASK_KEY` | yes | IFTTT Maker Webhooks key |
| `CF_ACCESS_TEAM_DOMAIN` | prod | Cloudflare Zero Trust team domain (e.g. `myteam.cloudflareaccess.com`). Omit locally to skip JWKS verification |
| `CF_ACCESS_AUD` | no | Access application audience tag (enables audience validation) |
| `ICON_URL` | no | Override the default server icon URL returned on `initialize` |

Set secrets via:

```pwsh
npx wrangler secret put <NAME>
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` or `/mcp` | MCP JSON-RPC (requires valid `Cf-Access-Jwt-Assertion`) |
| `OPTIONS` | `*` | CORS preflight |

Supported MCP methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.

## Troubleshooting

**"Unauthorized: Cloudflare Access authentication required"**

Missing or invalid `Cf-Access-Jwt-Assertion`. Ensure Access protects the worker hostname, Managed OAuth is enabled, and the client completed Access login. Locally, send any non-empty `Cf-Access-Jwt-Assertion` header when `CF_ACCESS_TEAM_DOMAIN` is unset.

**"IFTTT webhook failed (HTTP 404)"**

The Maker key is invalid or no applet listens for event `task`. Verify the key and applet event name.

**"IFTTT_MAKER_TASK_KEY is not configured on the server."**

```pwsh
npx wrangler secret put IFTTT_MAKER_TASK_KEY
```

Then redeploy.

**JWT verification failures in production**

Confirm `CF_ACCESS_TEAM_DOMAIN` matches your team domain exactly (hostname only, or full `https://…` URL). If set, `CF_ACCESS_AUD` must match the Access application AUD tag.
