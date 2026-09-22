import { describe, expect, it } from 'vitest';

import {
  ONECONNECTER_PUBLIC_HANDLERS,
  ONECONNECTER_PUBLIC_TOOLS,
} from '../tools/oneconnecter-public';

describe('ONECONNECTER_PUBLIC_TOOLS', () => {
  it('exposes the expected initial public tool slice', () => {
    expect(ONECONNECTER_PUBLIC_TOOLS.map((tool) => tool.name)).toEqual([
      'list_organizations',
      'list_projects',
      'list_shared_projects',
      'describe_project',
      'prepare_database_migration',
      'complete_database_migration',
      'prepare_query_tuning',
      'complete_query_tuning',
      'describe_branch',
      'list_branch_computes',
      'explain_sql_statement',
      'get_connection_string',
      'list_slow_queries',
      'get_database_tables',
      'describe_table_schema',
      'compare_database_schema',
      'list_docs_resources',
      'get_doc_resource',
      'run_sql',
      'search',
      'fetch',
    ]);
  });

  it('uses structured schemas for every public tool', () => {
    for (const tool of ONECONNECTER_PUBLIC_TOOLS) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it('keeps migration tools writable and the rest read-only safe', () => {
    const writableTools = ONECONNECTER_PUBLIC_TOOLS.filter(
      (tool) => !tool.readOnlySafe,
    ).map((tool) => tool.name);

    expect(writableTools).toEqual([
      'prepare_database_migration',
      'complete_database_migration',
      'prepare_query_tuning',
      'complete_query_tuning',
    ]);
  });

  it('has a corresponding handler for every public tool', () => {
    for (const tool of ONECONNECTER_PUBLIC_TOOLS) {
      expect(ONECONNECTER_PUBLIC_HANDLERS[tool.name]).toBeDefined();
      expect(typeof ONECONNECTER_PUBLIC_HANDLERS[tool.name]).toBe('function');
    }
  });
});
