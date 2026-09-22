import '../../../mcp-src/sentry/instrument';

import { NEON_TOOLS } from '../../../mcp-src/tools';
import { createNeonRouteHandler } from '../../../mcp-src/server/create-route-handler';

const handleRequest = createNeonRouteHandler({
  tools: NEON_TOOLS,
  basePath: '/api',
  normalizeLegacyPaths: true,
  includePrompts: true,
});

export { handleRequest as GET, handleRequest as POST, handleRequest as DELETE };
