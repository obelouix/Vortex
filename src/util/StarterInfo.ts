import { setToolRunning } from '../actions';
import { IDiscoveredTool } from '../types/IDiscoveredTool';
import { IGame } from '../types/IGame';
import { log } from '../util/log';
import opn from '../util/opn';
import Steam, { GamePathNotMatched } from '../util/Steam';
import { getSafe } from '../util/storeHelper';

import { IDiscoveryResult } from '../extensions/gamemode_management/types/IDiscoveryResult';
import { IGameStored } from '../extensions/gamemode_management/types/IGameStored';
import { IToolStored } from '../extensions/gamemode_management/types/IToolStored';
import { getGame } from '../extensions/gamemode_management/util/getGame';

import { IExtensionApi } from '../types/IExtensionContext';

import { MissingDependency, MissingInterpreter,
         ProcessCanceled, UserCanceled } from './CustomErrors';

import * as Promise from 'bluebird';
import { remote } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface IStarterInfo {
  id: string;
  gameId: string;
  isGame: boolean;
  iconPath: string;
  iconOutPath: string;
  name: string;
  exePath: string;
  commandLine: string[];
  workingDirectory: string;
  exclusive: boolean;
  environment: { [key: string]: string };
}

const userDataPath = ((): () => string => {
  let cache: string;
  return () => {
    if (cache === undefined) {
      cache = remote.app.getPath('userData');
    }
    return cache;
  };
})();

type OnShowErrorFunc =
  (message: string, details?: string | Error | any, allowReport?: boolean) => void;

/**
 * holds info about an executable to start
 *
 * @class StarterInfo
 */
class StarterInfo implements IStarterInfo {
  public static getGameIcon(game: IGameStored, gameDiscovery: IDiscoveryResult): string {
    const extensionPath = gameDiscovery.extensionPath || game.extensionPath;
    const logoName = gameDiscovery.logo || game.logo;
    return StarterInfo.gameIcon(game.id, extensionPath, logoName);
  }

  public static toolIconRW(gameId: string, toolId: string) {
    return path.join(userDataPath(), gameId, 'icons', toolId + '.png');
  }

  public static run(info: StarterInfo, api: IExtensionApi, onShowError: OnShowErrorFunc) {
    const game: IGame = getGame(info.gameId);
    const launcherPromise: Promise<{ launcher: string, addInfo?: any }> =
      (game.requiresLauncher !== undefined) && info.isGame
      ? game.requiresLauncher(path.dirname(info.exePath))
        .catch(err => {
          onShowError('Failed to determine if launcher is required', err, true);
          return Promise.resolve(undefined);
        })
      : Promise.resolve(undefined);

    const onSpawned = () => {
      api.store.dispatch(setToolRunning(info.exePath, Date.now(), info.exclusive));
    };

    return launcherPromise.then(res => {
      if (res !== undefined) {
        return StarterInfo.runThroughLauncher(res.launcher, info, api, res.addInfo)
          .then(() => {
            // assuming that runThroughLauncher returns immediately on handing things off
            // to the launcher
            api.store.dispatch(setToolRunning(info.exePath, Date.now(), info.exclusive));
          })
          .catch(UserCanceled, () => null)
          .catch(GamePathNotMatched, err => {
            const errorMsg = [err.message, err.gamePath, err.steamEntryPaths].join(' - ');
            log('error', errorMsg);
            onShowError('Failed to start game through launcher', err, true);
            return StarterInfo.runGameExecutable(info, api, onShowError, onSpawned);
          })
          .catch(err => {
            onShowError('Failed to start game through launcher', err, true);
            return StarterInfo.runGameExecutable(info, api, onShowError, onSpawned);
          });
      } else {
        return StarterInfo.runGameExecutable(info, api, onShowError, onSpawned);
      }
    });
  }

  private static executeWithSteam(info: StarterInfo, api: IExtensionApi): Promise<void> {
    // Should never happen but it's worth adding
    //  the game check just in case.
    if (!info.isGame) {
      return Promise.reject(new Error(`Attempted to execute a tool via Steam - ${info.exePath}`));
    }

    return new Promise((resolve, reject) => {
      Steam.getGameExecutionInfo(path.dirname(info.exePath),
                                 getSafe(info.details, ['steamAppId'], undefined))
        .then(execInfo =>
          api.runExecutable(execInfo.steamPath, execInfo.arguments, {
            cwd: path.dirname(execInfo.steamPath),
            env: info.environment,
            suggestDeploy: true,
            shell: true,
          }))
        .then(() => resolve())
        .catch(err => reject(err));
    });
  }

  private static executeWithEpic(info: StarterInfo,
                                 api: IExtensionApi,
                                 addInfo: any): Promise<void> {
    return opn(`com.epicgames.launcher://apps/${addInfo}?action=launch&silent=true`)
      .catch(err => null);
  }

  private static runGameExecutable(info: StarterInfo,
                                   api: IExtensionApi,
                                   onShowError: OnShowErrorFunc,
                                   onSpawned: () => void,
                                   ): Promise<void> {
    return api.runExecutable(info.exePath, info.commandLine, {
      cwd: info.workingDirectory,
      env: info.environment,
      suggestDeploy: true,
      shell: info.shell,
      onSpawned,
    })
    .catch(ProcessCanceled, () => undefined)
    .catch(UserCanceled, () => undefined)
    .catch(MissingDependency, () => {
      onShowError('Failed to run tool', {
        executable: info.exePath,
        message: 'An Application/Tool dependency is missing, please consult the '
               + 'Application/Tool documentation for required dependencies.',
      }, false);
    })
    .catch(err => {
      if (err.errno === 'ENOENT') {
        onShowError('Failed to run tool', {
          Executable: info.exePath,
          message: 'Executable doesn\'t exist, please check the configuration for the '
                 + 'tool you tried to start.',
          stack: err.stack,
        }, false);
      } else if (err.errno === 'EBUSY') {
        // Application is still running in the background. Let the user know and suppress
        //  the report button.
        onShowError('Failed to run tool', {
          Executable: info.exePath,
          message: 'The executable is running in the background or is being locked by an '
                 + 'external application. Please close any running instances of the tool/game '
                 + 'and/or external applications which may be locking the executable and retry.',
          stack: err.stack,
        }, false);
      } else if (err.errno === 'UNKNOWN') {
        // info sucks but node.js doesn't give us too much information about what went wrong
        // and we can't have users misconfigure their tools and then report the error they
        // get as feedback
        onShowError('Failed to run tool', {
          Executable: info.exePath,
          message: 'File is not executable, please check the configuration for the '
                 + 'tool you tried to start.',
          stack: err.stack,
        }, false);
      } else if (err instanceof MissingInterpreter) {
        const par = {
          Error: err.message,
        };
        if (err.url !== undefined) {
          par['Download url'] = err.url;
        }
        onShowError('Failed to run tool', par, false);
      } else {
        onShowError('Failed to run tool', {
          executable: info.exePath,
          error: err,
        });
      }
    });
  }

  private static runThroughLauncher(launcher: string,
                                    info: StarterInfo,
                                    api: IExtensionApi,
                                    addInfo: any): Promise<void> {
    const launchFunc = {
      steam: this.executeWithSteam,
      epic: this.executeWithEpic,
    }[launcher];
    if (launchFunc !== undefined) {
      return launchFunc(info, api, addInfo);
    } else {
      return Promise.reject(new Error(`Unsupported launcher ${launcher}`));
    }
  }

  private static gameIcon(gameId: string, extensionPath: string, logo: string) {
    try {
      const iconPath = this.gameIconRW(gameId);
      fs.statSync(iconPath);
      return iconPath;
    } catch (err) {
      if (logo !== undefined) {
        return path.join(extensionPath, logo);
      } else {
        return undefined;
      }
    }
  }

  private static gameIconRW(gameId: string) {
    return path.join(userDataPath(), gameId, 'icon.png');
  }

  private static toolIcon(gameId: string, extensionPath: string,
                          toolId: string, toolLogo: string): string {
    try {
      const iconPath = this.toolIconRW(gameId, toolId);
      fs.statSync(iconPath);
      return iconPath;
    } catch (err) {
      if (toolLogo === undefined) {
        return undefined;
      }
      try {
        const iconPath = path.join(extensionPath, toolLogo);
        fs.statSync(iconPath);
        return iconPath;
      } catch (err) {
        return undefined;
      }
    }
  }
  public id: string;
  public gameId: string;
  public isGame: boolean;
  public iconOutPath: string;
  public name: string;
  public exePath: string;
  public commandLine: string[];
  public workingDirectory: string;
  public environment: { [key: string]: string };
  public originalEnvironment: { [key: string]: string };
  public shell: boolean;
  public details: { [key: string]: any } = {};
  public exclusive: boolean;
  private mExtensionPath: string;
  private mLogoName: string;
  private mIconPathCache: string;

  constructor(game: IGameStored, gameDiscovery: IDiscoveryResult,
              tool?: IToolStored, toolDiscovery?: IDiscoveredTool) {
    this.gameId = gameDiscovery.id || game.id;
    this.mExtensionPath = gameDiscovery.extensionPath || game.extensionPath;

    if ((tool === undefined) && (toolDiscovery === undefined)) {
      this.id = this.gameId;
      this.isGame = true;
      this.initFromGame(game, gameDiscovery);
    } else {
      this.id = getSafe(toolDiscovery, ['id'], getSafe(tool, ['id'], undefined));
      this.isGame = false;
      this.initFromTool(this.gameId, tool, toolDiscovery);
    }
    if ((this.id === undefined) || (this.name === undefined)) {
      throw new Error('invalid starter information');
    }
  }

  public get iconPath(): string {
    if (this.mIconPathCache === undefined) {
      if (this.isGame) {
        this.mIconPathCache = StarterInfo.gameIcon(
            this.gameId, this.mExtensionPath, this.mLogoName);
      } else {
        this.mIconPathCache = StarterInfo.toolIcon(
            this.gameId, this.mExtensionPath, this.id, this.mLogoName);
      }
    }

    return this.mIconPathCache;
  }

  private initFromGame(game: IGameStored, gameDiscovery: IDiscoveryResult) {
    this.name = gameDiscovery.name || game.name;
    this.exePath = path.join(gameDiscovery.path, gameDiscovery.executable || game.executable);
    this.commandLine = getSafe(gameDiscovery, ['parameters'], getSafe(game, ['parameters'], []));
    this.workingDirectory = path.dirname(this.exePath);
    this.originalEnvironment = getSafe(game, ['environment'], {});
    this.environment = getSafe(gameDiscovery, ['envCustomized'], false)
      ? getSafe(gameDiscovery, ['environment'], {})
      : this.originalEnvironment;
    this.iconOutPath = StarterInfo.gameIconRW(this.gameId);
    this.shell = gameDiscovery.shell || game.shell;
    this.mLogoName = gameDiscovery.logo || game.logo;
    this.details = game.details;
    this.exclusive = true;
  }

  private initFromTool(gameId: string, tool: IToolStored, toolDiscovery: IDiscoveredTool) {
    if (toolDiscovery !== undefined) {
      this.name = getSafe(toolDiscovery, ['name'], getSafe(tool, ['name'], undefined));
      // TODO: umm, the discovery path here stores the path to the exe, whereas for a game it
      //   stores the base path of the game? That's not confusing at all...
      this.exePath = toolDiscovery.path;
      this.commandLine = getSafe(toolDiscovery, ['parameters'], getSafe(tool, ['parameters'], []));
      this.environment =
        getSafe(toolDiscovery, ['environment'], getSafe(tool, ['environment'], {})) || {};
      this.mLogoName = getSafe(toolDiscovery, ['logo'], getSafe(tool, ['logo'], undefined));
      this.workingDirectory = toolDiscovery.workingDirectory !== undefined
        ? toolDiscovery.workingDirectory
        : path.dirname(toolDiscovery.path || '');
      this.shell = getSafe(toolDiscovery, ['shell'], getSafe(tool, ['shell'], undefined));
      this.exclusive = getSafe(tool, ['exclusive'], false) || false;
    } else {
      // defaults for undiscovered & unconfigured tools
      this.name = tool.name;
      this.exePath = '';
      this.commandLine = tool.parameters;
      this.workingDirectory = '';
      this.environment = tool.environment || {};
      this.mLogoName = tool.logo;
      this.shell = tool.shell;
    }
    this.iconOutPath = StarterInfo.toolIconRW(gameId, this.id);
  }

}

export default StarterInfo;
