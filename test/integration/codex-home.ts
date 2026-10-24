import { constants, copyFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Never share native test state, configuration or credential refreshes with the desktop. */
export function isolatedCodexHome(directory: string, authFile?: string) {
  const home = join(directory, 'codex-home');
  mkdirSync(home, { mode: 0o700 });
  try {
    // Keep refreshed credentials in this home, not in the user's OS keychain.
    writeFileSync(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    if (authFile) {
      copyFileSync(authFile, join(home, 'auth.json'), constants.COPYFILE_EXCL);
      chmodSync(join(home, 'auth.json'), 0o600);
    }
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
