// rollup module for just the modules we want to be
// part of the api
// (excluding log, which is exported separately to give
//  it a more accessible name)

export * from './message';
export * from './storeHelper';

import { installIconSet } from '../controls/Icon';
import { resolveCategoryName,
         resolveCategoryPath } from '../extensions/category_management/util/retrieveCategoryPath';
import { getGame, getGames } from '../extensions/gamemode_management/util/getGame';
import deriveModInstallName from '../extensions/mod_management/modIdManager';
import { getManifest } from '../extensions/mod_management/util/activationStore';
import { getActivator,
         getCurrentActivator } from '../extensions/mod_management/util/deploymentMethods';
import renderModName from '../extensions/mod_management/util/modName';
import sortMods, { CycleError } from '../extensions/mod_management/util/sort';
import testModReference from '../extensions/mod_management/util/testModReference';
import { Archive } from './archives';
import copyRecursive from './copyRecursive';
import { ArgumentInvalid, DataInvalid, MissingInterpreter, NotFound, NotSupportedError,
         ProcessCanceled, SetupError, UserCanceled } from './CustomErrors';
import Debouncer from './Debouncer';
import epicGamesLauncher from './EpicGamesLauncher';
import { getVisibleWindow, terminate } from './errorHandling';
import { extend } from './ExtensionProvider';
import { copyFileAtomic, fileMD5 } from './fsAtomic';
import getNormalizeFunc, { Normalize } from './getNormalizeFunc';
import getVortexPath from './getVortexPath';
import github from './github';
import { getCurrentLanguage } from './i18n';
import LazyComponent from './LazyComponent';
import lazyRequire from './lazyRequire';
import makeReactive from './makeReactive';
import onceCB from './onceCB';
import opn from './opn';
import { getReduxLog } from './reduxLogger';
import ReduxProp from './ReduxProp';
import relativeTime from './relativeTime';
import steam, { GameNotFound, ISteamEntry } from './Steam';
import { bytesToString, deBOM, isChildPath, makeQueue, objDiff,
         pad, sanitizeCSSId, setdefault } from './util';
import walk from './walk';

import { runElevated, runThreaded } from 'vortex-run';

export {
  Archive,
  ArgumentInvalid,
  bytesToString,
  copyFileAtomic,
  copyRecursive,
  CycleError,
  DataInvalid,
  Debouncer,
  deBOM,
  deriveModInstallName as deriveInstallName,
  epicGamesLauncher,
  extend,
  fileMD5,
  GameNotFound,
  getActivator,
  getCurrentActivator,
  getCurrentLanguage,
  getGame,
  getGames,
  getManifest,
  getNormalizeFunc,
  getReduxLog,
  getVisibleWindow,
  getVortexPath,
  github,
  installIconSet,
  isChildPath,
  LazyComponent,
  lazyRequire,
  makeQueue,
  makeReactive,
  MissingInterpreter,
  Normalize,
  NotFound,
  NotSupportedError,
  objDiff,
  onceCB,
  opn,
  pad,
  ProcessCanceled,
  ReduxProp,
  relativeTime,
  renderModName,
  resolveCategoryName,
  resolveCategoryPath,
  runElevated,
  runThreaded,
  sanitizeCSSId,
  setdefault,
  SetupError,
  sortMods,
  steam,
  ISteamEntry,
  terminate,
  testModReference,
  UserCanceled,
  walk,
};

// getText functions are rolled up into one function
export type TextGroup = 'mod';
import getTextModManagement from '../extensions/mod_management/texts';

import I18next from 'i18next';

export function getText(group: TextGroup, textId: string, t: I18next.TFunction) {
  if (group === 'mod') {
    return getTextModManagement(textId, t);
  }
  throw new Error('invalid text group: ' + group);
}
