import { describe, it, expect } from 'vitest';
import { githubIdentity, parseGithubRemote } from './githubRemote.js';

describe('parseGithubRemote', () => {
  it('reads the three github.com forms', () => {
    for (const url of [
      'git@github.com:aerius/calculator',
      'ssh://git@github.com/aerius/calculator',
      'https://github.com/aerius/calculator',
    ]) {
      expect(parseGithubRemote(url)).toEqual({ owner: 'aerius', name: 'calculator' });
    }
  });

  it('drops a .git suffix and one trailing slash', () => {
    const expected = { owner: 'o', name: 'n' };
    expect(parseGithubRemote('git@github.com:o/n.git')).toEqual(expected);
    expect(parseGithubRemote('ssh://git@github.com/o/n.git')).toEqual(expected);
    expect(parseGithubRemote('https://github.com/o/n.git')).toEqual(expected);
    expect(parseGithubRemote('https://github.com/o/n/')).toEqual(expected);
    expect(parseGithubRemote('https://github.com/o/n.git/')).toEqual(expected);
  });

  it('compares the host case-insensitively and keeps the name as written', () => {
    expect(parseGithubRemote('git@GitHub.com:JornC/Calculator.git')).toEqual({
      owner: 'JornC',
      name: 'Calculator',
    });
    expect(parseGithubRemote('HTTPS://GITHUB.COM/o/n')).toEqual({ owner: 'o', name: 'n' });
  });

  it('accepts userinfo on https', () => {
    expect(parseGithubRemote('https://user:token@github.com/o/n.git')).toEqual({
      owner: 'o',
      name: 'n',
    });
  });

  it('refuses anything else', () => {
    for (const url of [
      'https://github.com.evil.com/o/n',
      'https://evil.com/github.com/o/n',
      'git@github.com.evil.com:o/n',
      'git@gitlab.com:o/n',
      'ssh://git@gitlab.com/o/n',
      'https://github.com/o/n/extra',
      'https://github.com//n',
      'git@github.com:/n',
      'https://github.com/o',
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- the plain-http form must be refused
      'http://github.com/o/n',
      '/home/me/repos/calculator',
      '../calculator.git',
      'file:///srv/git/o/n.git',
      '',
    ]) {
      expect(parseGithubRemote(url)).toBeNull();
    }
  });
});

describe('githubIdentity', () => {
  it('is owner/name, lowercased', () => {
    expect(githubIdentity({ owner: 'Aerius', name: 'Calculator' })).toBe('aerius/calculator');
  });
});
