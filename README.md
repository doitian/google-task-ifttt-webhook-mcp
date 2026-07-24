# google-task-ifttt-webhook-mcp

MCP server running on Cloudflare Workers that exposes a `create_google_task` tool.
Sends tasks to Google Tasks via the [IFTTT Maker webhook](https://ifttt.com/maker_webhooks).

Authentication is handled by **Cloudflare Access** (OAuth).

## How it works

```
MCP Client                  Cloudflare Access          Cloudflare Worker         IFTTT
    |                             |                          |                     |
    |-- OAuth login ------------>|                          |                     |
    |<-- JWT token --------------|                          |                     |
    |                             |                          |                     |
    |-- POST (tools/call) ------>|-- Cf-Access-Jwt-Assertion->|                    |
    |                             |                          |-- POST webhook ---->|
    |                             |                          |<-- "Congratulations"|
    |<-- result -----------------|<-------------------------|                     |
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Cloudflare account](https://dash.cloudflare.com/) with Workers enabled
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/) (requires Cloudflare Zero Trust)
- IFTTT account with the [Maker Webhooks](https://ifttt.com/maker_webhooks) service connected
- A Google Tasks applet on IFTTT triggered by the `task` event from Maker Webhooks

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
- **If**: Maker Webhooks → Receive a web request with event name `task`
- **Then**: Google Tasks → Create a task
  - Title: `{{Value1}}`
  - Notes: `{{Value2}}`
  - Due date: `{{Value3}}`

### 4. Configure Cloudflare Access

1. Go to [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** → **Applications** → **Add an application** → **Self-hosted**
3. Configure:
   - **Application name**: `google-task-mcp`
   - **Application domain**: `google-task-mcp.yourdomain.com` (or a `*.workers.dev` subdomain)
   - **Identity providers**: Select your preferred IdP (Google, GitHub, email OTP, etc.)
   - **Policy**: Create an allow policy for the users who should access the MCP server
   - **Managed OAuth (Beta)**: Must be enabled
4. Note your **team domain** (e.g. `myteam.cloudflareaccess.com`) and the **Application Audience (AUD)** tag
5. Set them in `wrangler.jsonc` or via wrangler vars:

```pwsh
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```

### 5. Deploy

```pwsh
npm run deploy
```

### 6. Test locally (optional)

```pwsh
npm run dev
```

The worker will be available at `http://localhost:8787`. For local testing without Cloudflare Access, the JWT check can be bypassed by sending a dummy JWT header.

### 7. Configure the MCP client

#### opencode

Add to your opencode configuration:

```json
{
  "mcpServers": {
    "google-tasks": {
      "type": "streamableHttp",
      "url": "https://google-task-mcp.yourdomain.com",
      "auth": "oauth"
    }
  }
}
```

The client will discover the OAuth flow from `/.well-known/oauth-authorization-server` and redirect to Cloudflare Access for login.

#### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-tasks": {
      "command": "npx",
      "args": [
        "@anthropic-ai/mcp-client",
        "streamableHttp",
        "https://google-task-mcp.yourdomain.com"
      ],
      "env": {
        "MCP_AUTH": "oauth"
      }
    }
  }
}
```

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

## Secrets

| Secret | Description |
|--------|-------------|
| `IFTTT_MAKER_TASK_KEY` | IFTTT Maker Webhooks key (required) |
| `CF_ACCESS_TEAM_DOMAIN` | Cloudflare Zero Trust team domain (required for OAuth) |
| `CF_ACCESS_AUD` | Cloudflare Access application audience tag (optional, enables audience validation) |

Set via:

```pwsh
npx wrangler secret put <NAME>
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/.well-known/oauth-authorization-server` | OAuth metadata for MCP client discovery |
| `POST` | `/` | MCP JSON-RPC endpoint (requires `Cf-Access-Jwt-Assertion` header) |
| `OPTIONS` | `/` | CORS preflight |

## Troubleshooting

**"Unauthorized: Cloudflare Access authentication required"**

The request is missing the `Cf-Access-Jwt-Assertion` header. Ensure Cloudflare Access is properly configured and the client is authenticated through Access.

**"IFTTT webhook failed (HTTP 404)"**

The Maker key is invalid or the `task` event name doesn't match any applet. Verify the key and check your IFTTT applet configuration.

**"IFTTT_MAKER_TASK_KEY is not configured"**

Set the secret via `npx wrangler secret put IFTTT_MAKER_TASK_KEY` and redeploy.

**OAuth flow not working**

Check that `CF_ACCESS_TEAM_DOMAIN` matches your Cloudflare Zero Trust team domain exactly (without `https://`).
