/**
 * GitHub remote URLs to `owner/name`. Pure: the Work page matches a PR to
 * a repo by the repo's remotes (docs/work-page.md §4.4).
 */

export interface GithubRepo {
  owner: string;
  name: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The `o/n` part after the host, or null when the URL is not one of the three github.com forms. */
function pathAfterHost(url: string): string | null {
  const scp = /^git@([^:/]+):(.*)$/.exec(url);
  if (scp) return scp[1].toLowerCase() === 'github.com' ? scp[2] : null;

  const ssh = /^ssh:\/\/git@([^/]+)\/(.*)$/.exec(url);
  if (ssh) return ssh[1].toLowerCase() === 'github.com' ? ssh[2] : null;

  // userinfo may carry a token: `https://user:token@github.com/o/n`.
  const https = /^https:\/\/(?:[^@/]*@)?([^/@]+)\/(.*)$/i.exec(url);
  if (https) return https[1].toLowerCase() === 'github.com' ? https[2] : null;

  return null;
}

/** null for anything that is not one of the three github.com forms. */
export function parseGithubRemote(url: string): GithubRepo | null {
  const rest = pathAfterHost(url.trim());
  if (rest === null) return null;
  const trimmed = rest.replace(/\/$/, '').replace(/\.git$/, '');
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  return { owner, name };
}

/** `owner/name`, lowercased. */
export function githubIdentity(repo: GithubRepo): string {
  return `${repo.owner}/${repo.name}`.toLowerCase();
}
