import type * as AndroidTvRemote from '@kud/androidtv-remote';

type AndroidTvRemoteModule = typeof AndroidTvRemote;

const importEsm = new Function(
  'specifier',
  'return import(specifier)',
) as (specifier: string) => Promise<AndroidTvRemoteModule>;

export function loadAndroidTvRemote(): Promise<AndroidTvRemoteModule> {
  return importEsm('@kud/androidtv-remote');
}
