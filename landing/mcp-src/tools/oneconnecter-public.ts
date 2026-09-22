import { EndpointType } from '@neondatabase/api-client';
import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
import { z } from 'zod';

import { describeTable } from '../describeUtils';
import { NEON_DOCS_BASE_URL, NEON_DOCS_INDEX_URL } from '../resources';
import type { ToolHandlerExtraParams } from './types';
import { handleDescribeProject } from './handlers/decribe-project';
import { handleGetConnectionString } from './handlers/connection-string';
import { handleListOrganizations } from './handlers/list-orgs';
import { handleListProjects } from './handlers/list-projects';
import { generateConsoleUrl, CONSOLE_URLS } from './handlers/urls';
import { getOnlyProject } from './handlers/utils';

type PublicToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  readOnlySafe: boolean;
};

type PublicToolHandler = (
  args: { params: any },
  neonClient: any,
  extra: ToolHandlerExtraParams,
) => Promise<{
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
}>;

function jsonResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorResult(type: string, message: string, details?: unknown) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: {
              type,
              message,
              ...(details ? { details } : {}),
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

function asError(error: unknown) {
  if (error instanceof Error) {
    return errorResult('tool_execution_failed', error.message);
  }
  return errorResult('tool_execution_failed', 'Unknown error');
}

function mapProject(project: any) {
  return {
    project_id: project.id,
    project_name: project.name,
    organization_id: project.org_id ?? null,
    region_id: project.region_id ?? null,
    postgres_version: project.pg_version ?? null,
    created_at: project.created_at ?? null,
    updated_at: project.updated_at ?? null,
  };
}

function mapBranch(branch: any) {
  return {
    branch_id: branch.id,
    branch_name: branch.name,
    parent_branch_id: branch.parent_id ?? null,
    project_id: branch.project_id,
    is_default: branch.default ?? false,
    is_protected: branch.protected ?? false,
    created_at: branch.created_at ?? null,
    updated_at: branch.updated_at ?? null,
  };
}

function mapOrganization(org: any) {
  return {
    organization_id: org.id,
    organization_name: org.name,
    managed_by: org.managed_by ?? null,
    created_at: org.created_at ?? null,
    updated_at: org.updated_at ?? null,
  };
}

async function searchBranches(
  projectId: string,
  neonClient: any,
  searchTerm: string,
) {
  try {
    const { data } = await neonClient.listProjectBranches({ projectId });
    return data.branches
      .filter(
        (branch: any) =>
          branch.name.toLowerCase().includes(searchTerm) ||
          branch.id.toLowerCase().includes(searchTerm),
      )
      .map((branch: any) => ({
        resource_id: `branch:${projectId}/${branch.id}`,
        resource_type: 'branch',
        title: branch.name,
        project_id: projectId,
        url: generateConsoleUrl(CONSOLE_URLS.PROJECT_BRANCH, {
          projectId,
          branchId: branch.id,
        }),
      }));
  } catch {
    return [];
  }
}

function parseDocsIndex(markdown: string) {
  const resources = [];
  const linkPattern = /\[([^\]]+)\]\((https:\/\/neon\.com\/[^)]+)\)/g;
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(markdown)) !== null) {
    const url = match[2];
    resources.push({
      title: match[1],
      url,
      slug: url.replace(`${NEON_DOCS_BASE_URL}/`, ''),
    });
  }

  return resources;
}

function validateDocSlug(slug: string) {
  if (slug.includes('..')) {
    throw new Error('Invalid doc slug: path traversal ("..") is not allowed');
  }
  if (slug.includes('://')) {
    throw new Error('Invalid doc slug: absolute URLs are not allowed');
  }
  if (slug.startsWith('/')) {
    throw new Error('Invalid doc slug: slug must not start with "/"');
  }
}

function splitSqlStatements(sql: string) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function generateMigrationBranchName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `mcp-migration-${timestamp}`;
}

type QueryMetrics = {
  execution_time: number;
  planning_time: number;
  total_cost: number;
  actual_rows: number;
  buffer_usage: {
    shared: {
      hit: number;
      read: number;
      written: number;
      dirtied: number;
    };
    local: {
      hit: number;
      read: number;
      written: number;
      dirtied: number;
    };
  };
};

function extractExecutionMetrics(planJson: any): QueryMetrics {
  const metrics: QueryMetrics = {
    execution_time: 0,
    planning_time: 0,
    total_cost: 0,
    actual_rows: 0,
    buffer_usage: {
      shared: { hit: 0, read: 0, written: 0, dirtied: 0 },
      local: { hit: 0, read: 0, written: 0, dirtied: 0 },
    },
  };

  try {
    const root = Array.isArray(planJson) ? planJson[0] : planJson;
    if (root?.['Planning Time']) {
      metrics.planning_time = root['Planning Time'];
    }
    if (root?.['Execution Time']) {
      metrics.execution_time = root['Execution Time'];
    }

    function walk(node: any) {
      if (!node || typeof node !== 'object') return;

      if (node['Total Cost']) {
        metrics.total_cost = Math.max(metrics.total_cost, node['Total Cost']);
      }
      if (node['Actual Rows']) {
        metrics.actual_rows += node['Actual Rows'];
      }

      if (node['Shared Hit Blocks']) metrics.buffer_usage.shared.hit += node['Shared Hit Blocks'];
      if (node['Shared Read Blocks']) metrics.buffer_usage.shared.read += node['Shared Read Blocks'];
      if (node['Shared Written Blocks']) metrics.buffer_usage.shared.written += node['Shared Written Blocks'];
      if (node['Shared Dirtied Blocks']) metrics.buffer_usage.shared.dirtied += node['Shared Dirtied Blocks'];
      if (node['Local Hit Blocks']) metrics.buffer_usage.local.hit += node['Local Hit Blocks'];
      if (node['Local Read Blocks']) metrics.buffer_usage.local.read += node['Local Read Blocks'];
      if (node['Local Written Blocks']) metrics.buffer_usage.local.written += node['Local Written Blocks'];
      if (node['Local Dirtied Blocks']) metrics.buffer_usage.local.dirtied += node['Local Dirtied Blocks'];

      if (Array.isArray(node.Plans)) {
        node.Plans.forEach(walk);
      }
    }

    if (root?.Plan) {
      walk(root.Plan);
    }
  } catch {
    // Ignore extraction failures and return zeroed metrics.
  }

  return metrics;
}

function extractTableNamesFromPlan(planJson: any): string[] {
  const names = new Set<string>();

  function walk(node: any) {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    if (node['Relation Name'] && node.Schema) {
      names.add(`${node.Schema}.${node['Relation Name']}`);
    }

    Object.values(node).forEach(walk);
  }

  walk(planJson);
  return Array.from(names);
}

export const ONECONNECTER_PUBLIC_TOOLS = [
  {
    name: 'list_organizations',
    description:
      'List Neon organizations the authenticated user can access. Use when you need organization IDs before listing or creating projects.',
    inputSchema: z.object({
      search_term: z
        .string()
        .optional()
        .describe('Optional organization name or ID fragment. Example: "acme".'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'list_projects',
    description:
      'List Neon projects with optional organization scoping and search. Use when you need project IDs or want a compact project inventory.',
    inputSchema: z.object({
      organization_id: z
        .string()
        .optional()
        .describe('Optional Neon organization ID. Example: "org_123".'),
      search_term: z
        .string()
        .optional()
        .describe('Optional project name or ID fragment. Example: "prod".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(400)
        .optional()
        .default(10)
        .describe('Maximum number of projects to return. Example: 25.'),
      cursor: z
        .string()
        .optional()
        .describe('Pagination cursor from a previous response.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'list_shared_projects',
    description:
      'List Neon projects shared with the authenticated user. Use when the project may not belong to the user or organization directly.',
    inputSchema: z.object({
      search_term: z
        .string()
        .optional()
        .describe('Optional shared project name or ID fragment. Example: "analytics".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(400)
        .optional()
        .default(10)
        .describe('Maximum number of shared projects to return. Example: 25.'),
      cursor: z
        .string()
        .optional()
        .describe('Pagination cursor from a previous response.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'describe_project',
    description:
      'Get compact details for a Neon project, including branch summaries. Use when you already have a project ID.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'prepare_database_migration',
    description:
      'Create a temporary branch and apply migration SQL there for review. Use before applying schema changes to a parent branch.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      migration_sql: z
        .string()
        .describe('SQL migration to apply on the temporary branch.'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name. If omitted, the default database is used.'),
    }),
    readOnlySafe: false,
  },
  {
    name: 'complete_database_migration',
    description:
      'Apply or cancel a prepared database migration and clean up the temporary branch.',
    inputSchema: z.object({
      migration_id: z.string().describe('Migration ID from prepare_database_migration.'),
      migration_sql: z
        .string()
        .describe('Exact migration SQL returned by prepare_database_migration.'),
      database_name: z
        .string()
        .describe('Database name returned by prepare_database_migration.'),
      project_id: z
        .string()
        .describe('Project ID returned by prepare_database_migration.'),
      temporary_branch_id: z
        .string()
        .describe('Temporary branch ID returned by prepare_database_migration.'),
      parent_branch_id: z
        .string()
        .describe('Parent branch ID returned by prepare_database_migration.'),
      apply_changes: z
        .boolean()
        .optional()
        .default(true)
        .describe('Set to true to apply the migration, or false to cancel and only clean up.'),
    }),
    readOnlySafe: false,
  },
  {
    name: 'prepare_query_tuning',
    description:
      'Create a temporary branch and collect execution-plan context for query tuning. Use before proposing or applying performance changes.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      database_name: z
        .string()
        .describe('Database name to analyze. Example: "neondb".'),
      sql: z
        .string()
        .describe('SQL statement to analyze for tuning.'),
    }),
    readOnlySafe: false,
  },
  {
    name: 'complete_query_tuning',
    description:
      'Apply or discard a prepared query tuning session and optionally clean up the temporary branch.',
    inputSchema: z.object({
      tuning_id: z.string().describe('Tuning ID from prepare_query_tuning.'),
      project_id: z.string().describe('Project ID from prepare_query_tuning.'),
      database_name: z.string().describe('Database name from prepare_query_tuning.'),
      temporary_branch_id: z
        .string()
        .describe('Temporary branch ID from prepare_query_tuning.'),
      suggested_sql_statements: z
        .array(z.string())
        .optional()
        .default([])
        .describe('Optional SQL statements to apply if apply_changes is true.'),
      apply_changes: z
        .boolean()
        .optional()
        .default(false)
        .describe('Set to true to apply suggested SQL statements.'),
      target_branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID that should receive the tuning changes.'),
      should_delete_temporary_branch: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to delete the temporary branch after completion.'),
    }),
    readOnlySafe: false,
  },
  {
    name: 'describe_branch',
    description:
      'Get compact details for a Neon branch, including available databases. Use when you have a project ID and branch ID.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      branch_id: z
        .string()
        .describe('Neon branch ID. Example: "br-silent-river-a1b2c3".'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name to highlight in the response. Example: "neondb".'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'list_branch_computes',
    description:
      'List compute endpoints for a project or branch. Use when you need endpoint IDs or compute sizing details.',
    inputSchema: z.object({
      project_id: z
        .string()
        .optional()
        .describe('Optional Neon project ID. If omitted, the only accessible project is used.'),
      branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID to limit computes to a single branch.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'explain_sql_statement',
    description:
      'Run EXPLAIN for a SQL statement and return the execution plan. Use when diagnosing query performance.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      sql: z
        .string()
        .describe('SQL statement to explain. Example: "select * from users where id = 1".'),
      branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID. If omitted, the default branch is used.'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name. If omitted, the default database is used.'),
      analyze: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to run EXPLAIN ANALYZE. Example: true.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'get_connection_string',
    description:
      'Get a database connection string with structured parameters. Use when an external client needs to connect to a Neon database.',
    inputSchema: z.object({
      project_id: z
        .string()
        .optional()
        .describe('Optional Neon project ID. If omitted, the only accessible project is used.'),
      branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID. If omitted, the default branch is used.'),
      compute_id: z
        .string()
        .optional()
        .describe('Optional compute or endpoint ID.'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name. If omitted, the default database is used.'),
      role_name: z
        .string()
        .optional()
        .describe('Optional database role name. If omitted, the database owner is used.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'list_slow_queries',
    description:
      'List slow queries from pg_stat_statements. Use when investigating performance hotspots in a database.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID. If omitted, the default branch is used.'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name. If omitted, the default database is used.'),
      compute_id: z
        .string()
        .optional()
        .describe('Optional compute or endpoint ID.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(10)
        .describe('Maximum number of slow queries to return. Example: 10.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'get_database_tables',
    description:
      'List tables in a Neon database using structured parameters. Use when you need schema and table names before inspecting a table.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID. If omitted, the default branch is used.'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name. If omitted, the default database is used.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'describe_table_schema',
    description:
      'Describe one database table with compact column, index, and constraint details. Use when you know the table name.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID. If omitted, the default branch is used.'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name. If omitted, the default database is used.'),
      table_name: z
        .string()
        .describe('Table name, optionally schema-qualified. Example: "users" or "public.users".'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'compare_database_schema',
    description:
      'Compare a branch schema against its parent branch and return a compact diff. Use when checking migration drift.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      branch_id: z
        .string()
        .describe('Child branch ID to compare against its parent branch.'),
      database_name: z
        .string()
        .describe('Database name to compare. Example: "neondb".'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'list_docs_resources',
    description:
      'List available Neon documentation resources. Use before fetching a specific docs page.',
    inputSchema: z.object({}),
    readOnlySafe: true,
  },
  {
    name: 'get_doc_resource',
    description:
      'Fetch one Neon documentation resource as markdown. Use after finding a slug from list_docs_resources.',
    inputSchema: z.object({
      slug: z
        .string()
        .describe('Docs slug from list_docs_resources. Example: "docs/connect/connection-pooling.md".'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'run_sql',
    description:
      'Run a single SQL statement against a Neon database. Use when you already know the exact SQL to execute.',
    inputSchema: z.object({
      project_id: z
        .string()
        .describe('Neon project ID. Example: "cold-snowflake-123456".'),
      sql: z
        .string()
        .describe('SQL statement to execute. Example: "select * from users limit 10".'),
      branch_id: z
        .string()
        .optional()
        .describe('Optional branch ID. If omitted, the default branch is used.'),
      database_name: z
        .string()
        .optional()
        .describe('Optional database name. If omitted, the default database is used.'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'search',
    description:
      'Search Neon organizations, projects, and branches with one search term. Use when you need IDs for a later tool call.',
    inputSchema: z.object({
      search_term: z
        .string()
        .min(3)
        .describe('Text to search for in organization, project, or branch names and IDs. Example: "prod".'),
    }),
    readOnlySafe: true,
  },
  {
    name: 'fetch',
    description:
      'Fetch details for a resource returned by the search tool. Use with a resource ID like org:..., project:..., or branch:project_id/branch_id.',
    inputSchema: z.object({
      resource_id: z
        .string()
        .describe('Resource ID from the search tool. Example: "project:cold-snowflake-123456".'),
    }),
    readOnlySafe: true,
  },
] as const satisfies readonly PublicToolDefinition[];

export const ONECONNECTER_PUBLIC_HANDLERS: Record<string, PublicToolHandler> = {
  list_organizations: async ({ params }, neonClient, extra) => {
    try {
      const organizations = await handleListOrganizations(
        neonClient,
        extra.account,
        params.search_term,
      );
      return jsonResult({
        organizations: organizations.map(mapOrganization),
        count: organizations.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  list_projects: async ({ params }, neonClient, extra) => {
    try {
      const projects = await handleListProjects(
        {
          org_id: params.organization_id,
          search: params.search_term,
          limit: params.limit,
          cursor: params.cursor,
        },
        neonClient,
        extra,
      );
      return jsonResult({
        organization_id: params.organization_id ?? null,
        projects: projects.map(mapProject),
        count: projects.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  list_shared_projects: async ({ params }, neonClient) => {
    try {
      const response = await neonClient.listSharedProjects({
        search: params.search_term,
        limit: params.limit,
        cursor: params.cursor,
      });
      const projects = response.data.projects ?? [];

      return jsonResult({
        shared_projects: projects.map(mapProject),
        count: projects.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  describe_project: async ({ params }, neonClient) => {
    try {
      const { project, branches } = await handleDescribeProject(
        params.project_id,
        neonClient,
      );
      const defaultBranch = branches.find((branch: any) => branch.default);
      return jsonResult({
        project: {
          ...mapProject(project),
          default_branch_id: defaultBranch?.id ?? null,
        },
        branches: branches.map(mapBranch),
      });
    } catch (error) {
      return asError(error);
    }
  },

  prepare_database_migration: async ({ params }, neonClient, extra) => {
    let temporaryBranchId: string | undefined;

    try {
      const branchName = generateMigrationBranchName();
      const createBranchResponse = await neonClient.createProjectBranch(
        params.project_id,
        {
          branch: {
            name: branchName,
          },
          endpoints: [
            {
              type: EndpointType.ReadWrite,
              autoscaling_limit_min_cu: 0.25,
              autoscaling_limit_max_cu: 0.25,
              provisioner: 'k8s-neonvm',
            },
          ],
        },
      );

      const branch = createBranchResponse.data.branch;
      temporaryBranchId = branch.id;

      const connection = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: branch.id,
          databaseName: params.database_name,
        },
        neonClient,
        extra,
      );
      const sql = neon(connection.uri);
      const migrationResult = await sql.transaction(
        splitSqlStatements(params.migration_sql).map((statement) =>
          sql.query(statement),
        ),
      );
      const migrationId = crypto.randomUUID();

      return jsonResult({
        migration_id: migrationId,
        project_id: params.project_id,
        database_name: connection.databaseName,
        migration_sql: params.migration_sql,
        temporary_branch: {
          branch_id: branch.id,
          branch_name: branch.name,
          parent_branch_id: branch.parent_id ?? null,
        },
        migration_result: migrationResult,
        follow_up: {
          review_with: 'run_sql',
          completion_tool: 'complete_database_migration',
        },
      });
    } catch (error) {
      if (temporaryBranchId) {
        try {
          await neonClient.deleteProjectBranch(params.project_id, temporaryBranchId);
        } catch {
          // Ignore cleanup failures here and return the original error.
        }
      }
      return asError(error);
    }
  },

  complete_database_migration: async ({ params }, neonClient, extra) => {
    try {
      let migrationResult: unknown;

      if (params.apply_changes) {
        const connection = await handleGetConnectionString(
          {
            projectId: params.project_id,
            branchId: params.parent_branch_id,
            databaseName: params.database_name,
          },
          neonClient,
          extra,
        );
        const sql = neon(connection.uri);
        migrationResult = await sql.transaction(
          splitSqlStatements(params.migration_sql).map((statement) =>
            sql.query(statement),
          ),
        );
      }

      let cleanup_error: string | null = null;
      try {
        await neonClient.deleteProjectBranch(
          params.project_id,
          params.temporary_branch_id,
        );
      } catch (error) {
        cleanup_error = error instanceof Error ? error.message : 'Unknown cleanup error';
      }

      return jsonResult({
        migration_id: params.migration_id,
        project_id: params.project_id,
        applied: params.apply_changes,
        deleted_temporary_branch_id: cleanup_error
          ? null
          : params.temporary_branch_id,
        cleanup_error,
        migration_result: migrationResult ?? null,
      });
    } catch (error) {
      return asError(error);
    }
  },

  prepare_query_tuning: async ({ params }, neonClient, extra) => {
    let temporaryBranchId: string | undefined;

    try {
      const branchName = `mcp-tuning-${new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)}`;
      const createBranchResponse = await neonClient.createProjectBranch(
        params.project_id,
        {
          branch: {
            name: branchName,
          },
          endpoints: [
            {
              type: EndpointType.ReadWrite,
              autoscaling_limit_min_cu: 0.25,
              autoscaling_limit_max_cu: 0.25,
              provisioner: 'k8s-neonvm',
            },
          ],
        },
      );

      const branch = createBranchResponse.data.branch;
      temporaryBranchId = branch.id;

      const connection = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: branch.id,
          databaseName: params.database_name,
        },
        neonClient,
        extra,
      );
      const sql = neon(connection.uri);
      const plan = await sql.query(
        `EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FILECACHE, FORMAT JSON) ${params.sql}`,
      );
      const tableNames = extractTableNamesFromPlan(plan);

      const tableSchemas = await Promise.all(
        tableNames.map(async (tableName) => {
          const simpleTableName = tableName.split('.').pop() ?? tableName;
          const description = await describeTable(connection.uri, simpleTableName);
          return {
            table_name: tableName,
            schema: {
              columns: description.columns.map((column) => ({
                column_name: column.name,
                data_type: column.type,
                nullable: column.nullable,
                default_value: column.default,
              })),
              indexes: description.indexes.map((index) => ({
                index_name: index.name,
                definition: index.definition,
              })),
            },
          };
        }),
      );

      return jsonResult({
        tuning_id: crypto.randomUUID(),
        project_id: params.project_id,
        database_name: connection.databaseName,
        sql: params.sql,
        temporary_branch: {
          branch_id: branch.id,
          branch_name: branch.name,
          parent_branch_id: branch.parent_id ?? null,
        },
        execution_plan: plan,
        baseline_metrics: extractExecutionMetrics(plan),
        referenced_tables: tableNames,
        table_schemas: tableSchemas,
      });
    } catch (error) {
      if (temporaryBranchId) {
        try {
          await neonClient.deleteProjectBranch(params.project_id, temporaryBranchId);
        } catch {
          // Ignore cleanup failures here and return the original error.
        }
      }
      return asError(error);
    }
  },

  complete_query_tuning: async ({ params }, neonClient, extra) => {
    try {
      let execution_result: unknown = null;

      if (params.apply_changes) {
        if (!params.suggested_sql_statements.length) {
          return errorResult(
            'missing_suggested_sql_statements',
            'suggested_sql_statements is required when apply_changes is true',
          );
        }

        const connection = await handleGetConnectionString(
          {
            projectId: params.project_id,
            branchId: params.target_branch_id,
            databaseName: params.database_name,
          },
          neonClient,
          extra,
        );
        const sql = neon(connection.uri);
        execution_result = await sql.transaction(
          params.suggested_sql_statements.map((statement: string) =>
            sql.query(statement),
          ),
        );
      }

      let deleted_temporary_branch_id: string | null = null;
      let cleanup_error: string | null = null;

      if (params.should_delete_temporary_branch) {
        try {
          await neonClient.deleteProjectBranch(
            params.project_id,
            params.temporary_branch_id,
          );
          deleted_temporary_branch_id = params.temporary_branch_id;
        } catch (error) {
          cleanup_error = error instanceof Error ? error.message : 'Unknown cleanup error';
        }
      }

      return jsonResult({
        tuning_id: params.tuning_id,
        project_id: params.project_id,
        database_name: params.database_name,
        applied_changes: params.apply_changes,
        executed_sql_count: params.apply_changes
          ? params.suggested_sql_statements.length
          : 0,
        deleted_temporary_branch_id,
        cleanup_error,
        execution_result,
      });
    } catch (error) {
      return asError(error);
    }
  },

  describe_branch: async ({ params }, neonClient) => {
    try {
      const { data } = await neonClient.getProjectBranch(
        params.project_id,
        params.branch_id,
      );
      const databasesResponse = await neonClient.listProjectBranchDatabases(
        params.project_id,
        params.branch_id,
      );
      const databases = databasesResponse.data.databases ?? [];
      const selectedDatabase =
        databases.find((db: any) => db.name === params.database_name) ??
        databases[0] ??
        null;

      return jsonResult({
        branch: mapBranch(data.branch),
        databases: databases.map((db: any) => ({
          database_name: db.name,
          owner_name: db.owner_name ?? null,
        })),
        selected_database: selectedDatabase
          ? {
              database_name: selectedDatabase.name,
              owner_name: selectedDatabase.owner_name ?? null,
            }
          : null,
      });
    } catch (error) {
      return asError(error);
    }
  },

  list_branch_computes: async ({ params }, neonClient, extra) => {
    try {
      let projectId = params.project_id;
      if (!projectId) {
        projectId = (await getOnlyProject(neonClient, extra)).id;
      }

      const response = params.branch_id
        ? await neonClient.listProjectBranchEndpoints(projectId, params.branch_id)
        : await neonClient.listProjectEndpoints(projectId);

      const computes = (response.data.endpoints ?? []).map((endpoint: any) => ({
        compute_id: endpoint.id,
        branch_id: endpoint.branch_id ?? null,
        project_id: endpoint.project_id ?? projectId,
        compute_type: endpoint.type,
        compute_size:
          endpoint.autoscaling_limit_min_cu !== endpoint.autoscaling_limit_max_cu
            ? `${endpoint.autoscaling_limit_min_cu}-${endpoint.autoscaling_limit_max_cu}`
            : endpoint.autoscaling_limit_min_cu,
        last_active: endpoint.last_active ?? null,
        suspended_at: endpoint.suspended_at ?? null,
      }));

      return jsonResult({
        project_id: projectId,
        branch_id: params.branch_id ?? null,
        computes,
        count: computes.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  explain_sql_statement: async ({ params }, neonClient, extra) => {
    try {
      const connection = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: params.branch_id,
          databaseName: params.database_name,
        },
        neonClient,
        extra,
      );
      const sql = neon(connection.uri);
      const explainPrefix = params.analyze
        ? 'EXPLAIN (ANALYZE, VERBOSE, BUFFERS, FILECACHE, FORMAT JSON)'
        : 'EXPLAIN (VERBOSE, FORMAT JSON)';
      const plan = await sql.query(`${explainPrefix} ${params.sql}`);

      return jsonResult({
        project_id: connection.projectId,
        branch_id: connection.branchId ?? null,
        database_name: connection.databaseName,
        analyze: params.analyze,
        plan,
      });
    } catch (error) {
      return asError(error);
    }
  },

  get_connection_string: async ({ params }, neonClient, extra) => {
    try {
      const result = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: params.branch_id,
          computeId: params.compute_id,
          databaseName: params.database_name,
          roleName: params.role_name,
        },
        neonClient,
        extra,
      );

      return jsonResult({
        project_id: result.projectId,
        branch_id: result.branchId ?? null,
        compute_id: result.computeId ?? null,
        database_name: result.databaseName,
        role_name: result.roleName,
        connection_uri: result.uri,
      });
    } catch (error) {
      return asError(error);
    }
  },

  get_database_tables: async ({ params }, neonClient, extra) => {
    try {
      const connection = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: params.branch_id,
          databaseName: params.database_name,
        },
        neonClient,
        extra,
      );
      const sql = neon(connection.uri);
      const rows = await sql.query(`
        SELECT table_schema, table_name, table_type
        FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name;
      `);

      return jsonResult({
        project_id: connection.projectId,
        branch_id: connection.branchId ?? null,
        database_name: connection.databaseName,
        tables: rows.map((row: any) => ({
          schema_name: row.table_schema,
          table_name: row.table_name,
          table_type: row.table_type,
        })),
        count: rows.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  list_slow_queries: async ({ params }, neonClient, extra) => {
    try {
      const connection = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: params.branch_id,
          computeId: params.compute_id,
          databaseName: params.database_name,
        },
        neonClient,
        extra,
      );
      const sql = neon(connection.uri);

      const extensionCheck = await sql.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
        ) AS extension_exists;
      `);

      if (!extensionCheck[0]?.extension_exists) {
        return errorResult(
          'missing_extension',
          'pg_stat_statements extension is not installed on this database',
        );
      }

      const slowQueries = await sql.query(
        `
          SELECT
            query,
            calls,
            total_exec_time,
            mean_exec_time,
            rows,
            shared_blks_hit,
            shared_blks_read,
            shared_blks_written,
            shared_blks_dirtied,
            temp_blks_read,
            temp_blks_written,
            wal_records,
            wal_fpi,
            wal_bytes
          FROM pg_stat_statements
          WHERE query NOT LIKE '%pg_stat_statements%'
          AND query NOT LIKE '%EXPLAIN%'
          ORDER BY mean_exec_time DESC
          LIMIT $1;
        `,
        [params.limit],
      );

      return jsonResult({
        project_id: connection.projectId,
        branch_id: connection.branchId ?? null,
        database_name: connection.databaseName,
        slow_queries: slowQueries.map((query: any) => ({
          query: query.query,
          calls: query.calls,
          total_exec_time_ms: query.total_exec_time,
          mean_exec_time_ms: query.mean_exec_time,
          rows: query.rows,
          shared_blks_hit: query.shared_blks_hit,
          shared_blks_read: query.shared_blks_read,
          shared_blks_written: query.shared_blks_written,
          shared_blks_dirtied: query.shared_blks_dirtied,
          temp_blks_read: query.temp_blks_read,
          temp_blks_written: query.temp_blks_written,
          wal_records: query.wal_records,
          wal_fpi: query.wal_fpi,
          wal_bytes: query.wal_bytes,
        })),
        count: slowQueries.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  describe_table_schema: async ({ params }, neonClient, extra) => {
    try {
      const connection = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: params.branch_id,
          databaseName: params.database_name,
        },
        neonClient,
        extra,
      );

      const tableNameParts = params.table_name.split('.');
      const simpleTableName = tableNameParts[tableNameParts.length - 1];
      const description = await describeTable(connection.uri, simpleTableName);

      return jsonResult({
        project_id: connection.projectId,
        branch_id: connection.branchId ?? null,
        database_name: connection.databaseName,
        table_name: simpleTableName,
        columns: description.columns.map((column) => ({
          column_name: column.name,
          data_type: column.type,
          nullable: column.nullable,
          default_value: column.default,
          description: column.description,
        })),
        indexes: description.indexes.map((index) => ({
          index_name: index.name,
          definition: index.definition,
          size: index.size,
        })),
        constraints: description.constraints.map((constraint) => ({
          constraint_name: constraint.name,
          constraint_type: constraint.type,
          definition: constraint.definition,
        })),
        sizes: {
          table_size: description.tableSize,
          index_size: description.indexSize,
          total_size: description.totalSize,
        },
      });
    } catch (error) {
      return asError(error);
    }
  },

  compare_database_schema: async ({ params }, neonClient) => {
    try {
      const response = await neonClient.getProjectBranchSchemaComparison({
        projectId: params.project_id,
        branchId: params.branch_id,
        db_name: params.database_name,
      });
      const diff = response.data.diff ?? '';

      return jsonResult({
        project_id: params.project_id,
        branch_id: params.branch_id,
        database_name: params.database_name,
        has_changes: diff.length > 0,
        diff,
      });
    } catch (error) {
      return asError(error);
    }
  },

  run_sql: async ({ params }, neonClient, extra) => {
    try {
      const connection = await handleGetConnectionString(
        {
          projectId: params.project_id,
          branchId: params.branch_id,
          databaseName: params.database_name,
        },
        neonClient,
        extra,
      );
      const sql = neon(connection.uri);

      let result: any;
      if (extra.readOnly) {
        const transactionResult = await sql.transaction([sql.query(params.sql)], {
          readOnly: true,
        });
        result = transactionResult[0];
      } else {
        result = await sql.query(params.sql);
      }

      const rows = Array.isArray(result) ? result : [];

      return jsonResult({
        project_id: connection.projectId,
        branch_id: connection.branchId ?? null,
        database_name: connection.databaseName,
        row_count: rows.length,
        rows,
      });
    } catch (error) {
      return asError(error);
    }
  },

  list_docs_resources: async () => {
    try {
      const response = await fetch(NEON_DOCS_INDEX_URL);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch Neon docs index: ${response.status} ${response.statusText}`,
        );
      }

      const markdown = await response.text();
      const resources = parseDocsIndex(markdown);
      return jsonResult({
        resources,
        count: resources.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  get_doc_resource: async ({ params }) => {
    try {
      validateDocSlug(params.slug);
      const slug = params.slug.endsWith('.md') ? params.slug : `${params.slug}.md`;
      const response = await fetch(`${NEON_DOCS_BASE_URL}/${slug}`);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch doc page "${slug}": ${response.status} ${response.statusText}`,
        );
      }

      return jsonResult({
        slug,
        markdown: await response.text(),
      });
    } catch (error) {
      return asError(error);
    }
  },

  search: async ({ params }, neonClient, extra) => {
    try {
      const searchTerm = params.search_term.toLowerCase();
      const organizations = await handleListOrganizations(neonClient, extra.account);
      const organizationResults = organizations
        .filter(
          (org) =>
            org.name.toLowerCase().includes(searchTerm) ||
            org.id.toLowerCase().includes(searchTerm),
        )
        .map((org) => ({
          resource_id: `org:${org.id}`,
          resource_type: 'organization',
          title: org.name,
          url: generateConsoleUrl(CONSOLE_URLS.ORGANIZATION, { orgId: org.id }),
        }));

      const projects = await handleListProjects(
        {
          limit: 400,
          search: params.search_term,
        },
        neonClient,
        extra,
      );
      const projectResults = projects.map((project) => ({
        resource_id: `project:${project.id}`,
        resource_type: 'project',
        title: project.name,
        url: generateConsoleUrl(CONSOLE_URLS.PROJECT, {
          projectId: project.id,
        }),
      }));

      const branchResultsNested = await Promise.all(
        projects.map((project) => searchBranches(project.id, neonClient, searchTerm)),
      );

      const results = [
        ...organizationResults,
        ...projectResults,
        ...branchResultsNested.flat(),
      ];

      return jsonResult({
        results,
        count: results.length,
      });
    } catch (error) {
      return asError(error);
    }
  },

  fetch: async ({ params }, neonClient, _extra) => {
    try {
      const resourceId = params.resource_id;

      if (resourceId.startsWith('org:')) {
        const orgId = resourceId.slice(4);
        const { data } = await neonClient.getOrganization(orgId);
        const { data: projectsData } = await neonClient.listProjects({
          org_id: orgId,
          limit: 400,
        });
        return jsonResult({
          resource_type: 'organization',
          organization: mapOrganization(data),
          project_count: projectsData.projects?.length ?? 0,
        });
      }

      if (resourceId.startsWith('project:')) {
        const projectId = resourceId.slice(8);
        const { project, branches } = await handleDescribeProject(projectId, neonClient);
        return jsonResult({
          resource_type: 'project',
          project: mapProject(project),
          branches: branches.map(mapBranch),
        });
      }

      if (resourceId.startsWith('branch:')) {
        const [projectId, branchId] = resourceId.slice(7).split('/');
        if (!projectId || !branchId) {
          return errorResult(
            'invalid_resource_id',
            'Branch resource IDs must use the form branch:project_id/branch_id',
          );
        }

        const { data } = await neonClient.getProjectBranch(projectId, branchId);
        const databasesResponse = await neonClient.listProjectBranchDatabases(
          projectId,
          branchId,
        );
        return jsonResult({
          resource_type: 'branch',
          branch: mapBranch(data.branch),
          databases: (databasesResponse.data.databases ?? []).map((db: any) => ({
            database_name: db.name,
            owner_name: db.owner_name ?? null,
          })),
        });
      }

      return errorResult(
        'invalid_resource_id',
        'Expected a resource ID beginning with org:, project:, or branch:',
      );
    } catch (error) {
      return asError(error);
    }
  },
};
