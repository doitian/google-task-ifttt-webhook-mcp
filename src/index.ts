interface Env {
  IFTTT_MAKER_TASK_KEY: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
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

const MCP_VERSION = "2024-11-05";

const SERVER_INFO = {
  name: "google-task-ifttt-webhook-mcp",
  version: "1.0.0",
} as const;

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
      "Content-Type, Accept, Authorization, Cf-Access-Jwt-Assertion, Mcp-Session-Id",
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
    return JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

function verifyAccessJwt(jwt: string, env: Env): boolean {
  const payload = decodeJwtPayload(jwt);
  if (!payload) return false;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) return false;

  if (typeof payload.iss === "string" && env.CF_ACCESS_TEAM_DOMAIN) {
    if (payload.iss !== `https://${env.CF_ACCESS_TEAM_DOMAIN}`) return false;
  }

  if (typeof payload.aud === "string" && env.CF_ACCESS_AUD) {
    if (payload.aud !== env.CF_ACCESS_AUD) return false;
  }

  return true;
}

async function createGoogleTask(
  args: Record<string, unknown>,
  env: Env,
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) {
    return {
      content: [{ type: "text", text: "Error: title is required and must be a non-empty string." }],
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
        serverInfo: SERVER_INFO,
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
    body = await request.json() as JsonRpcRequest;
  } catch {
    return jsonResponse(
      rpcError(null, -32700, "Parse error: invalid JSON"),
      400,
    );
  }

  if (body.jsonrpc !== "2.0") {
    return jsonResponse(
      rpcError(body.id ?? null, -32600, "Invalid Request: jsonrpc must be 2.0"),
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (
      request.method === "GET" &&
      url.pathname === "/.well-known/oauth-authorization-server"
    ) {
      if (!env.CF_ACCESS_TEAM_DOMAIN) {
        return jsonResponse(
          { error: "CF_ACCESS_TEAM_DOMAIN not configured" },
          500,
        );
      }
      return jsonResponse(
        {
          issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
          authorization_endpoint: `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/authorize`,
          token_endpoint: `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/token`,
          grant_types_supported: ["authorization_code"],
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        },
      );
    }

    const jwt =
      request.headers.get("Cf-Access-Jwt-Assertion") ??
      request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!jwt || !verifyAccessJwt(jwt, env)) {
      return jsonResponse(
        rpcError(null, -32001, "Unauthorized: Cloudflare Access authentication required"),
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
