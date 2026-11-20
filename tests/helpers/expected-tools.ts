/**
 * Every tool the server is expected to register, by wire name.
 *
 * Spelled out rather than derived so a rename or a dropped
 * `setup*Tool()` call fails here instead of silently shrinking the API that
 * clients see. Handler-level unit tests cannot notice either.
 *
 * Shared by the stdio and HTTP protocol suites, so the two transports are held
 * to one list and cannot drift apart.
 */
export const EXPECTED_TOOLS = [
  'create_collection',
  'create_environment',
  'update_environment',
  'set_environment_variable',
  'remove_environment_variable',
  'write_request',
  'move_request',
  'add_test_script',
  'remove_script',
  'delete_request',
  'list_collections',
  'list_requests',
  'get_collection_stats',
  'run_collection',
  'read_request',
  'read_environment',
  'unregister_collection',
  'delete_collection',
];
