interface Env {
  IFTTT_MAKER_TASK_KEY: string;
  API_KEY?: string;
  OAUTH_SIGNING_KEY?: string;
  ICON_URL?: string;
}

type JsonRpcId = number | string | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

interface PendingCode {
  codeChallenge: string;
  redirectUri: string;
  expiresAt: number;
}

const codes = new Map<string, PendingCode>();

setInterval(
  () => {
    const now = Date.now();
    for (const [code, entry] of codes) {
      if (entry.expiresAt < now) codes.delete(code);
    }
  },
  60_000,
);

const MCP_VERSION = "2024-11-05";

const SERVER_INFO = {
  name: "google-task-ifttt-webhook-mcp",
  version: "1.0.0",
};

const TOOLS: ToolDef[] = [
  {
    name: "create_google_task",
    description:
      "Create a Google Task via IFTTT webhook. Posts to maker.ifttt.com to create a task in Google Tasks.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Task title (single line, required)",
        },
        notes: {
          type: "string",
          description: "Optional detailed notes. Use \\n for line breaks.",
        },
        due: {
          type: "string",
          description:
            "Optional due date in ISO 8601 UTC format (e.g. 2026-07-25T23:59:59Z)",
        },
      },
      required: ["title"],
    },
  },
];

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Authorization, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() },
  });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

function rpcSuccess(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(
      atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
  } catch {
    return null;
  }
}

async function verifyJwt(jwt: string, key: string): Promise<boolean> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;

    const payload = decodeJwtPayload(jwt);
    if (!payload) return false;

    if (
      typeof payload.exp === "number" &&
      payload.exp < Math.floor(Date.now() / 1000)
    )
      return false;

    const encoder = new TextEncoder();
    const keyData = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const sigBytes = atob(
      parts[2].replace(/-/g, "+").replace(/_/g, "/"),
    );
    const sig = new Uint8Array(sigBytes.length);
    for (let i = 0; i < sigBytes.length; i++) sig[i] = sigBytes.charCodeAt(i);
    return crypto.subtle.verify(
      "HMAC",
      keyData,
      sig,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return false;
  }
}

async function signJwt(
  payload: Record<string, unknown>,
  key: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const base64url = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const partialToken =
    base64url(JSON.stringify(header)) +
    "." +
    base64url(JSON.stringify(payload));

  const keyData = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    keyData,
    encoder.encode(partialToken),
  );
  const signature = base64url(
    String.fromCharCode(...new Uint8Array(sig)),
  );

  return `${partialToken}.${signature}`;
}

function generateCode(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const base64url = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return base64url(String.fromCharCode(...bytes));
}

async function verifyCodeChallenge(
  verifier: string,
  challenge: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  const base64url = (s: string) =>
    btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return (
    base64url(String.fromCharCode(...new Uint8Array(hash))) === challenge
  );
}

async function createGoogleTask(
  args: Record<string, unknown>,
  env: Env,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) {
    return {
      content: [
        {
          type: "text",
          text: "Error: title is required and must be a non-empty string.",
        },
      ],
      isError: true,
    };
  }

  const key = env.IFTTT_MAKER_TASK_KEY;
  if (!key) {
    return {
      content: [
        {
          type: "text",
          text: "Error: IFTTT_MAKER_TASK_KEY is not configured on the server.",
        },
      ],
      isError: true,
    };
  }

  const payload: Record<string, string> = { title };

  if (typeof args.notes === "string" && args.notes.trim()) {
    payload.notes = args.notes.trim();
  }
  if (typeof args.due === "string" && args.due.trim()) {
    payload.due = args.due.trim();
  }

  const response = await fetch(
    `https://maker.ifttt.com/trigger/task/json/with/key/${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  const responseText = await response.text();

  if (!response.ok) {
    return {
      content: [
        {
          type: "text",
          text: `IFTTT webhook failed (HTTP ${response.status}): ${responseText}`,
        },
      ],
      isError: true,
    };
  }

  const parts: string[] = [`Task created: "${title}"`];
  if (payload.notes) parts.push(`Notes: ${payload.notes}`);
  if (payload.due) parts.push(`Due: ${payload.due}`);

  return {
    content: [{ type: "text", text: parts.join("\n") }],
  };
}

async function handleRpcMethod(
  method: string,
  params: Record<string, unknown> | undefined,
  env: Env,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          ...SERVER_INFO,
          ...(env.ICON_URL ? { icon: env.ICON_URL } : {}),
        },
      };

    case "notifications/initialized":
      return {};

    case "ping":
      return {};

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const name = params?.name;
      const args = (params?.arguments as Record<string, unknown>) ?? {};
      if (name !== "create_google_task") {
        throw { code: -32601, message: `Unknown tool: ${name}` };
      }
      return createGoogleTask(args, env);
    }

    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

async function handleMcpRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonResponse(
      rpcError(null, -32700, "Parse error: invalid JSON"),
      400,
    );
  }

  if (body.jsonrpc !== "2.0") {
    return jsonResponse(
      rpcError(
        body.id ?? null,
        -32600,
        "Invalid Request: jsonrpc must be 2.0",
      ),
      400,
    );
  }

  const id = body.id ?? null;
  const isNotification = body.id === undefined;

  try {
    const result = await handleRpcMethod(body.method, body.params, env);
    if (isNotification) {
      return new Response(null, { status: 202, headers: corsHeaders() });
    }
    return jsonResponse(rpcSuccess(id, result));
  } catch (err: unknown) {
    if (isNotification) {
      return new Response(null, { status: 202, headers: corsHeaders() });
    }
    const e = err as { code?: number; message?: string; data?: unknown };
    return jsonResponse(
      rpcError(
        id,
        e.code ?? -32603,
        e.message ?? "Internal error",
        e.data,
      ),
      e.code === -32601 ? 404 : 500,
    );
  }
}

function authorizeForm(baseUrl: string, query: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Google Task MCP — Authorize</title>
  <style>
    * { box-sizing:border-box;margin:0;padding:0 }
    body { font-family:system-ui,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh }
    .card { background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1);max-width:400px;width:100% }
    h1 { font-size:1.25rem;margin-bottom:1rem }
    p { color:#666;margin-bottom:1.5rem;font-size:.9rem }
    label { display:block;font-size:.85rem;font-weight:600;margin-bottom:.5rem }
    input { width:100%;padding:.6rem;border:1px solid #ddd;border-radius:6px;font-size:.9rem;margin-bottom:1rem }
    button { width:100%;padding:.6rem;background:#1a1a1a;color:#fff;border:none;border-radius:6px;font-size:.9rem;cursor:pointer }
    button:hover { background:#333 }
    .error { color:#d00;font-size:.85rem;margin-bottom:1rem }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Grok MCP Client</h1>
    <p>Enter the server API key to grant Grok access to your Google Tasks MCP server.</p>
    <form method="post">
      <label for="key">API Key</label>
      <input id="key" name="key" type="password" autofocus required>
      <input type="hidden" name="q" value="${query.replace(/"/g, "&quot;")}">
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: url.origin,
        authorization_endpoint: `${url.origin}/oauth/authorize`,
        token_endpoint: `${url.origin}/oauth/token`,
        grant_types_supported: ["authorization_code"],
        response_types_supported: ["code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
    }

    if (path === "/oauth/authorize" && request.method === "GET") {
      return htmlResponse(authorizeForm(url.origin, url.search));
    }

    if (path === "/oauth/authorize" && request.method === "POST") {
      const form = await request.formData();
      const key = form.get("key") as string | null;
      const q = form.get("q") as string | null;

      if (!key || key !== env.API_KEY) {
        return htmlResponse(
          authorizeForm(url.origin, q ?? "").replace(
            "</form>",
            '<p class="error">Invalid API key.</p></form>',
          ),
          403,
        );
      }

      if (!q) {
        return jsonResponse(
          { error: "missing_authorization_request" },
          400,
        );
      }

      const authParams = new URLSearchParams(q);
      const redirectUri = authParams.get("redirect_uri");
      const codeChallenge = authParams.get("code_challenge");
      const codeChallengeMethod = authParams.get("code_challenge_method");
      const state = authParams.get("state");

      if (
        !redirectUri ||
        !codeChallenge ||
        codeChallengeMethod !== "S256"
      ) {
        return jsonResponse(
          { error: "invalid_request", error_description: "Missing required OAuth parameters." },
          400,
        );
      }

      const code = generateCode();
      codes.set(code, {
        codeChallenge,
        redirectUri,
        expiresAt: Date.now() + 300_000,
      });

      const redirect = new URL(redirectUri);
      redirect.searchParams.set("code", code);
      if (state) redirect.searchParams.set("state", state);
      return Response.redirect(redirect.toString(), 302);
    }

    if (path === "/oauth/token" && request.method === "POST") {
      let body: Record<string, string>;
      try {
        body = (await request.json()) as Record<string, string>;
      } catch {
        return jsonResponse(
          { error: "invalid_request", error_description: "Invalid JSON." },
          400,
        );
      }

      if (body.grant_type !== "authorization_code") {
        return jsonResponse(
          { error: "unsupported_grant_type" },
          400,
        );
      }

      const { code, code_verifier } = body;
      if (!code || !code_verifier) {
        return jsonResponse(
          { error: "invalid_request", error_description: "code and code_verifier required." },
          400,
        );
      }

      const entry = codes.get(code);
      if (!entry || entry.expiresAt < Date.now()) {
        return jsonResponse(
          { error: "invalid_grant", error_description: "Invalid or expired authorization code." },
          400,
        );
      }
      codes.delete(code);

      const pkceOk = await verifyCodeChallenge(
        code_verifier,
        entry.codeChallenge,
      );
      if (!pkceOk) {
        return jsonResponse(
          { error: "invalid_grant", error_description: "code_verifier does not match." },
          400,
        );
      }

      if (!env.OAUTH_SIGNING_KEY) {
        return jsonResponse(
          { error: "server_error", error_description: "OAuth signing key not configured." },
          500,
        );
      }

      const now = Math.floor(Date.now() / 1000);
      const accessToken = await signJwt(
        {
          iss: url.origin,
          iat: now,
          exp: now + 3600,
        },
        env.OAUTH_SIGNING_KEY,
      );

      return jsonResponse({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: 3600,
      });
    }

    if (path !== "/mcp") {
      return jsonResponse(
        rpcError(null, -32600, `Not found: ${path}`),
        404,
      );
    }

    const token =
      request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");

    if (!token) {
      return jsonResponse(
        rpcError(null, -32001, "Unauthorized: missing bearer token"),
        401,
      );
    }

    let authed = false;

    if (env.API_KEY && token === env.API_KEY) {
      authed = true;
    } else if (env.OAUTH_SIGNING_KEY) {
      authed = await verifyJwt(token, env.OAUTH_SIGNING_KEY);
    }

    if (!authed) {
      return jsonResponse(
        rpcError(null, -32001, "Unauthorized: invalid token"),
        401,
      );
    }

    if (request.method === "POST") {
      return handleMcpRequest(request, env);
    }

    return jsonResponse(
      rpcError(null, -32600, "Method not allowed. Use POST for MCP requests."),
      405,
    );
  },
};
