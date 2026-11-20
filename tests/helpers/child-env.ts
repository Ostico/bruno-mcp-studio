/**
 * Environment for a spawned server: the parent's, minus any BRUNO_* the
 * developer running the suite happens to have exported, plus the caller's
 * explicit overrides. Without the filter a local BRUNO_SSRF_ALLOWLIST would
 * change what these tests prove.
 *
 * BRUNO_WORKSPACE_PATH is the exception, and passes through. tests/setup-workspace-isolation.ts
 * has already replaced whatever the developer exported with a throwaway file, so
 * it is no longer a local setting that could change an outcome — and stripping it
 * sent the child to the Bruno app's own workspace instead, which is how this suite
 * came to leave three entries per run in a maintainer's real registry, each of
 * them pointing at a temp directory that is deleted before the next run.
 */
export function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('BRUNO_') && key !== 'BRUNO_WORKSPACE_PATH') continue;
    base[key] = value;
  }
  return { ...base, ...overrides };
}
