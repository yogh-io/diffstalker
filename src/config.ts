import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface Config {
  pager?: string;
  targetFile: string;
  watcherEnabled: boolean;
  debug: boolean;
}

const defaultConfig: Config = {
  targetFile: path.join(os.homedir(), '.cache', 'diffstalker', 'target'),
  watcherEnabled: false,  // Watcher is opt-in via --follow
  debug: false,
};

export function loadConfig(): Config {
  const config = { ...defaultConfig };

  // Override from environment
  if (process.env.DIFFSTALKER_PAGER) {
    config.pager = process.env.DIFFSTALKER_PAGER;
  }

  // Try to load from config file
  const configPath = path.join(os.homedir(), '.config', 'diffstalker', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (fileConfig.pager) config.pager = fileConfig.pager;
      if (fileConfig.targetFile) config.targetFile = fileConfig.targetFile;
    } catch {
      // Ignore config file errors
    }
  }

  return config;
}

export function ensureTargetDir(targetFile: string): void {
  const dir = path.dirname(targetFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function shortenPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return '~' + fullPath.slice(home.length);
  }
  return fullPath;
}
