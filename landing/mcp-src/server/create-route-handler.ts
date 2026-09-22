import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpHandler, withMcpAuth } from 'mcp-handler';
import { captureException, startSpan } from '@sentry/node';
import { waitUntil } from '@vercel/functions';

import { track, flushAnalytics } from '../analytics/analytics';
import { model } from '../oauth/model';
import { getApiKeys, type ApiKeyRecord } from '../oauth/kv-store';
import { NEON_PROMPTS, getPromptTemplate } from '../prompts';
import { createNeonClient } from './api';
import { handleToolError } from './errors';
import { resolveAccountFromAuth } from './account';
import { setSentryTags } from '../sentry/utils';
import { logger } from '../utils/logger';
import { generateTraceId } from '../utils/trace';
import { detectClientApplication } from '../utils/client-application';
import { isReadOnly } from '../utils/read-only';
import type { ToolHandlerExtraParams } from '../tools/types';
import { NEON_HANDLERS } from '../tools/index';
import type { AuthContext } from '../types/auth';
import type { ServerContext, AppContext } from '../types/context';
import pkg from '../../package.json';

type AuthenticatedExtra = {
  authInfo?: AuthInfo & {
    extra?: {
      apiKey?: string;
      account?: AuthContext['extra']['account'];
      readOnly?: boolean;
      client?: AuthContext['extra']['client'];
      transport?: AppContext['transport'];
      userAgent?: string;
    };
  };
  signal?: AbortSignal;
  sessionId?: string;
};

type RouteToolDefinition = {
  name: string;
  description: string;
  inputSchema: any;
  readOnlySafe: boolean;
};

type CreateRouteHandlerOptions = {
  tools: readonly RouteToolDefinition[];
  handlers?: Record<string, unknown>;
  basePath: string;
  disableSse?: boolean;
  normalizeLegacyPaths?: boolean;
  includePrompts?: boolean;
};

const API_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

const fetchAccountDetails = async (
  accessToken: string,
): Promise<ApiKeyRecord | null> => {
  try {
    const cached = await getApiKeys().get(accessToken);
    if (cached) {
      logger.info('API key cache hit', { accountId: cached.account.id });
      return cached;
    }
  } catch (error) {
    logger.warn('API key cache read failed', { error });
  }

  try {
    const neonClient = createNeonClient(accessToken);
    const { data: auth } = await neonClient.getAuthDetails();
    const account = await resolveAccountFromAuth(auth, neonClient, {
      context: { authMethod: auth.auth_method },
    });

    const record: ApiKeyRecord = {
      apiKey: accessToken,
      authMethod: auth.auth_method,
      account,
    };

    waitUntil(
      getApiKeys()
        .set(accessToken, record, API_KEY_CACHE_TTL_MS)
        .catch((err) => {
          logger.warn('API key cache write failed', { err });
        }),
    );

    logger.info('API key cache miss, verified and cached', {
      accountId: account.id,
    });
    return record;
  } catch (error) {
    const axiosError = error as {
      response?: { status?: number; data?: unknown };
      message?: string;
    };
    logger.error('API key verification failed', {
      message: axiosError.message,
      status: axiosError.response?.status,
      data: axiosError.response?.data,
    });
    return null;
  }
};

const verifyToken = async (
  req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> => {
  const userAgent = req.headers.get('user-agent') || undefined;
  const readOnlyHeader = req.headers.get('x-read-only');

  logger.info('verifyToken called', {
    hasBearerToken: !!bearerToken,
    bearerTokenLength: bearerToken?.length ?? 0,
    tokenPrefix: bearerToken?.substring(0, 10) ?? 'none',
    userAgent,
  });

  if (!bearerToken) {
    return undefined;
  }

  const url = new URL(req.url);
  const transport: AppContext['transport'] = url.pathname.includes('/mcp')
    ? 'stream'
    : 'sse';

  try {
    const token = await model.getAccessToken(bearerToken);
    if (token) {
      logger.info('OAuth token found', { clientId: token.client.id });

      const readOnly = isReadOnly({
        headerValue: readOnlyHeader,
        scope: token.scope,
      });

      return {
        token: token.accessToken,
        scopes: Array.isArray(token.scope)
          ? token.scope
          : (token.scope?.split(' ') ?? ['read', 'write']),
        clientId: token.client.id,
        expiresAt: token.expires_at
          ? Math.floor(token.expires_at / 1000)
          : undefined,
        extra: {
          account: {
            id: token.user.id,
            name: token.user.name,
            email: token.user.email,
            isOrg: token.user.isOrg ?? false,
          },
          apiKey: bearerToken,
          readOnly,
          client: {
            id: token.client.id,
            name: token.client.client_name,
          },
          transport,
          userAgent,
        },
      };
    }
  } catch (error) {
    logger.warn('OAuth token lookup failed, trying API key path', { error });
  }

  logger.info('Trying API key verification path', {
    tokenPrefix: bearerToken.substring(0, 10),
  });

  const apiKeyRecord = await fetchAccountDetails(bearerToken);
  if (!apiKeyRecord) {
    return undefined;
  }

  const readOnly = isReadOnly({
    headerValue: readOnlyHeader,
  });

  return {
    token: bearerToken,
    scopes: ['*'],
    clientId: 'api-key',
    extra: {
      account: apiKeyRecord.account,
      apiKey: bearerToken,
      readOnly,
      transport,
      userAgent,
    },
  };
};

export function createNeonRouteHandler({
  tools,
  handlers = NEON_HANDLERS,
  basePath,
  disableSse = false,
  normalizeLegacyPaths = false,
  includePrompts = true,
}: CreateRouteHandlerOptions) {
  const handler = createMcpHandler(
    (server: McpServer) => {
      let clientName = 'unknown';
      let clientApplication = detectClientApplication(clientName);
      let hasTrackedServerInit = false;
      let lastKnownContext: ServerContext | undefined;

      const defaultAppContext: AppContext = {
        name: 'mcp-server-neon',
        transport: disableSse ? 'stream' : 'sse',
        environment: (process.env.NODE_ENV ??
          'production') as AppContext['environment'],
        version: pkg.version,
      };

      function trackServerInit(context: ServerContext) {
        if (hasTrackedServerInit) return;
        hasTrackedServerInit = true;

        const properties = {
          clientName,
          clientApplication,
          readOnly: String(context.readOnly ?? false),
        };

        track({
          userId: context.account.id,
          event: 'server_init',
          properties,
          context: {
            client: context.client,
            app: context.app,
          },
        });
        waitUntil(flushAnalytics());
        logger.info('Server initialized:', {
          clientName,
          clientApplication,
          readOnly: context.readOnly,
        });
      }

      function getAuthContext(extra: AuthenticatedExtra) {
        const authInfo = extra.authInfo;
        if (!authInfo?.extra?.apiKey || !authInfo?.extra?.account) {
          throw new Error('Authentication required');
        }

        const apiKey = authInfo.extra.apiKey;
        const account = authInfo.extra.account;
        const readOnly = authInfo.extra.readOnly ?? false;
        const client = authInfo.extra.client;
        const transport = authInfo.extra.transport ?? defaultAppContext.transport;
        const neonClient = createNeonClient(apiKey);

        if (clientName === 'unknown' && authInfo.extra.userAgent) {
          clientName = authInfo.extra.userAgent;
          clientApplication = detectClientApplication(clientName);
        }

        const dynamicAppContext: AppContext = {
          name: 'mcp-server-neon',
          transport,
          environment: (process.env.NODE_ENV ??
            'production') as AppContext['environment'],
          version: pkg.version,
        };

        const context: ServerContext = {
          apiKey,
          account,
          app: dynamicAppContext,
          readOnly,
          client,
        };
        lastKnownContext = context;

        return {
          account,
          readOnly,
          neonClient,
          clientApplication,
          clientName,
          client,
          context,
        };
      }

      server.server.oninitialized = () => {
        const clientInfo = server.server.getClientVersion();
        logger.info('MCP oninitialized:', {
          clientInfo,
          hasName: !!clientInfo?.name,
          currentClientName: clientName,
        });
        if (clientInfo?.name) {
          clientName = clientInfo.name;
          clientApplication = detectClientApplication(clientName);
        }
      };

      server.server.onerror = (error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error('Server error:', {
          message,
          error,
        });

        const userId = lastKnownContext?.account?.id ?? 'unknown';
        const contexts = {
          app: lastKnownContext?.app ?? defaultAppContext,
          client: lastKnownContext?.client,
        };

        const eventId = captureException(error, {
          user: lastKnownContext?.account
            ? { id: lastKnownContext.account.id }
            : undefined,
          contexts,
        });

        track({
          userId,
          event: 'server_error',
          properties: { message, error, eventId },
          context: contexts,
        });
        waitUntil(flushAnalytics());
      };

      tools.forEach((tool) => {
        const toolHandler = handlers[tool.name];
        if (!toolHandler) {
          throw new Error(`Handler for tool ${tool.name} not found`);
        }

        server.registerTool(
          tool.name,
          {
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          async (args: any, extra: any) => {
            const {
              account,
              readOnly,
              neonClient,
              clientApplication: clientApp,
              clientName: cName,
              client,
              context,
            } = getAuthContext(extra as AuthenticatedExtra);

            trackServerInit(context);

            if (readOnly && !tool.readOnlySafe) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: `Tool "${tool.name}" is not available in read-only mode`,
                  },
                ],
              };
            }

            const traceId = generateTraceId();
            return await startSpan(
              {
                name: 'tool_call',
                attributes: {
                  tool_name: tool.name,
                  trace_id: traceId,
                },
              },
              async (span) => {
                const properties = {
                  tool_name: tool.name,
                  readOnly: String(readOnly),
                  clientName: cName,
                  traceId,
                };

                logger.info('tool call:', properties);
                setSentryTags(context);

                track({
                  userId: account.id,
                  event: 'tool_call',
                  properties,
                  context: {
                    client,
                    app: context.app,
                    clientName: cName,
                  },
                });
                waitUntil(flushAnalytics());

                const extraArgs: ToolHandlerExtraParams = {
                  ...extra,
                  account,
                  readOnly,
                  clientApplication: clientApp,
                };

                try {
                  const result = await (toolHandler as any)(
                    { params: args },
                    neonClient,
                    extraArgs,
                  );
                  if (result.isError) {
                    logger.warn('tool error response:', {
                      ...properties,
                      isError: true,
                      contentLength: result.content?.length,
                      firstContentType: result.content?.[0]?.type,
                    });
                  }
                  return result;
                } catch (error) {
                  span.setStatus({ code: 2 });
                  const errorResult = handleToolError(error, properties, traceId);
                  logger.warn('tool error response:', {
                    ...properties,
                    isError: true,
                    contentLength: errorResult.content?.length,
                    firstContentType: errorResult.content?.[0]?.type,
                  });
                  return errorResult;
                }
              },
            );
          },
        );
      });

      if (includePrompts) {
        NEON_PROMPTS.forEach((prompt) => {
          server.registerPrompt(
            prompt.name,
            {
              description: prompt.description,
              argsSchema: prompt.argsSchema,
            },
            async (args: any, extra: any) => {
              const {
                account,
                readOnly,
                clientApplication: clientApp,
                clientName: cName,
                client,
                context,
              } = getAuthContext(extra as AuthenticatedExtra);

              trackServerInit(context);

              const traceId = generateTraceId();
              const properties = {
                prompt_name: prompt.name,
                clientName: cName,
                traceId,
              };
              logger.info('prompt call:', properties);
              setSentryTags(context);

              track({
                userId: account.id,
                event: 'prompt_call',
                properties,
                context: { client, app: context.app },
              });
              waitUntil(flushAnalytics());

              try {
                const extraArgs: ToolHandlerExtraParams = {
                  ...extra,
                  account,
                  readOnly,
                  clientApplication: clientApp,
                };
                const template = await getPromptTemplate(
                  prompt.name,
                  extraArgs,
                  args,
                );
                return {
                  messages: [
                    {
                      role: 'user' as const,
                      content: {
                        type: 'text' as const,
                        text: template,
                      },
                    },
                  ],
                };
              } catch (error) {
                captureException(error, {
                  extra: properties,
                });
                throw error;
              }
            },
          );
        });
      }
    },
    {
      serverInfo: {
        name: 'mcp-server-neon',
        version: pkg.version,
      },
      capabilities: {
        tools: {},
        prompts: includePrompts
          ? {
              listChanged: true,
            }
          : undefined,
      },
    },
    {
      redisUrl: process.env.KV_URL || process.env.REDIS_URL,
      basePath,
      maxDuration: 800,
      verboseLogs: process.env.NODE_ENV !== 'production',
      disableSse,
      onEvent: (event) => {
        switch (event.type) {
          case 'SESSION_STARTED':
            logger.info('MCP session started', {
              sessionId: event.sessionId,
              transport: event.transport,
              clientInfo: event.clientInfo,
            });
            break;
          case 'SESSION_ENDED':
            logger.info('MCP session ended', {
              sessionId: event.sessionId,
              transport: event.transport,
            });
            break;
          case 'REQUEST_COMPLETED':
            if (event.status === 'error') {
              logger.warn('MCP request failed', {
                sessionId: event.sessionId,
                requestId: event.requestId,
                method: event.method,
                duration: event.duration,
              });
            }
            break;
          case 'ERROR':
            const isConnectionError =
              typeof event.error === 'string'
                ? event.error.includes('No connection established')
                : event.error?.message?.includes('No connection established');

            if (isConnectionError) {
              logger.warn('MCP connection lost', {
                sessionId: event.sessionId,
                source: event.source,
                severity: event.severity,
                context: event.context,
              });
            } else if (event.severity === 'fatal') {
              logger.error('MCP fatal error', {
                sessionId: event.sessionId,
                error: event.error,
                source: event.source,
                context: event.context,
              });
              captureException(
                event.error instanceof Error
                  ? event.error
                  : new Error(String(event.error)),
              );
            }
            break;
        }
      },
    },
  );

  const authHandler = withMcpAuth(handler, verifyToken, {
    required: true,
    resourceMetadataPath: '/.well-known/oauth-protected-resource',
  });

  return (req: Request) => {
    if (!normalizeLegacyPaths) {
      return authHandler(req);
    }

    const url = new URL(req.url);
    if (url.pathname === '/mcp') {
      url.pathname = '/api/mcp';
    } else if (url.pathname === '/sse') {
      url.pathname = '/api/sse';
    }

    const normalizedReq = new Request(url.toString(), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      // @ts-expect-error duplex is required for streaming bodies
      duplex: 'half',
    });

    return authHandler(normalizedReq);
  };
}
