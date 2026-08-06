/**
 * Repo-wide content search.
 *
 * **POST, and that is not a style choice.** `guardRequest` exempts GET and
 * HEAD from the CSRF check (`security.ts`), because a GET is not supposed to
 * change anything. A search endpoint is a read, so GET is the instinctive
 * shape — and it is the wrong one here: repo ids are
 * `sha256(worktreeRoot).slice(0,12)`, computable offline from a guessed path,
 * so a GET search would let any page in the browser fire cross-site probes at
 * a local daemon and time the answers. CORS blocks reading the response; it
 * does not block measuring it. POST puts the endpoint behind the same CSRF
 * guard as every mutation. Do not "correct" this to a GET.
 *
 * Registered for both API modes: the web UI is the client this exists for.
 */

import { grepRepo, GrepQueryTooShortError, GREP_MIN_QUERY } from '@diffstalker/core/git/grep';
import { Router, HttpError, sendJson } from '../router.js';
import { requireRepo, requireStringField, type RouteDeps } from './shared.js';

export function registerSearchRoutes(router: Router, deps: RouteDeps): void {
  const { registry } = deps;

  router.post('/repos/:id/search', async ({ params, body, res }) => {
    const handle = requireRepo(registry, params.id);
    const query = requireStringField(body, 'query');

    try {
      const result = await grepRepo(handle.path, query);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof GrepQueryTooShortError) {
        throw new HttpError(400, `Query must be at least ${GREP_MIN_QUERY} characters`);
      }
      throw err;
    }
  });
}
