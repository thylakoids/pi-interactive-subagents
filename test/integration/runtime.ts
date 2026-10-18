import { delimiter, dirname, isAbsolute } from 'node:path';

/** npm injects its peer Pi binary; terminal tests must use the user's Pi runtime. */
export function integrationRuntime(env: NodeJS.ProcessEnv = process.env) {
  const executable = env.PI_TEST_PI?.trim() || 'pi';
  const entries = (env.PATH ?? '').split(delimiter).filter(entry =>
    !/[\\/]node_modules[\\/]\.bin[\\/]?$/.test(entry) && !entry.includes('node-gyp-bin'));
  if (isAbsolute(executable)) entries.unshift(dirname(executable));
  return { executable, path: entries.join(delimiter) };
}
