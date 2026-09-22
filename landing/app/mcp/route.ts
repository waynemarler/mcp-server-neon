import '../../mcp-src/sentry/instrument';

import { createNeonRouteHandler } from '../../mcp-src/server/create-route-handler';
import {
  ONECONNECTER_PUBLIC_HANDLERS,
  ONECONNECTER_PUBLIC_TOOLS,
} from '../../mcp-src/tools/oneconnecter-public';

const handler = createNeonRouteHandler({
  tools: ONECONNECTER_PUBLIC_TOOLS,
  handlers: ONECONNECTER_PUBLIC_HANDLERS,
  basePath: '',
  disableSse: true,
  includePrompts: false,
});

export { handler as GET, handler as POST, handler as DELETE };
