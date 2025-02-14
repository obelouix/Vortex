import { IDeployedFile, IDeploymentMethod,
         IExtensionApi, IFileChange } from '../../../types/IExtensionContext';
import { ProcessCanceled } from '../../../util/CustomErrors';
import * as fs from '../../../util/fs';
import { log } from '../../../util/log';
import { activeGameId, activeProfile, profileById } from '../../../util/selectors';
import { getSafe } from '../../../util/storeHelper';
import { setdefault, truthy } from '../../../util/util';

import { showExternalChanges } from '../actions/session';
import { IFileEntry } from '../types/IFileEntry';

import * as Promise from 'bluebird';
import * as path from 'path';

/**
 * look at the file actions and act accordingly. Depending on the action this can
 * be a direct file operation or a modification to the previous manifest so that
 * the deployment ext runs the necessary operation
 * @param {string} sourcePath the "virtual" mod directory
 * @param {string} outputPath the destination directory where the game expects mods
 * @param {IDeployedFile[]} lastDeployment previous deployment to use as reference
 * @param {IFileEntry[]} fileActions actions the user selected for external changes
 * @returns {Promise<IDeployedFile[]>} an updated deployment manifest to use as a reference
 *                                     for the new one
 */
function applyFileActions(api: IExtensionApi,
                          profileId: string,
                          sourcePath: string,
                          outputPath: string,
                          lastDeployment: IDeployedFile[],
                          fileActions: IFileEntry[]): Promise<IDeployedFile[]> {
  if (fileActions === undefined) {
    return Promise.resolve(lastDeployment);
  }

  const actionGroups: { [type: string]: IFileEntry[] } = fileActions.reduce((prev, value) => {
    const action = (value.action === 'newest')
      ? (value.sourceModified > value.destModified) ? 'drop' : 'import'
      : value.action;

    setdefault(prev, action, []).push(value);
    return prev;
  }, {});

  // not doing anything with 'nop'. The regular deployment code is responsible for doing the right
  // thing in this case.

  // process the actions that the user selected in the dialog
  return Promise.map(actionGroups['drop'] || [],
      // delete the links the user wants to drop.
      (entry) => truthy(entry.filePath)
          ? fs.removeAsync(path.join(outputPath, entry.filePath))
          : Promise.reject(new Error('invalid file path')))
    .then(() => Promise.map(actionGroups['delete'] || [],
      entry => truthy(entry.filePath)
          ? fs.removeAsync(path.join(sourcePath, entry.source, entry.filePath))
          : Promise.reject(new Error('invalid file path'))))
    .then(() => Promise.map(actionGroups['import'] || [],
      // copy the files the user wants to import
      (entry) => {
        const source = path.join(sourcePath, entry.source, entry.filePath);
        const deployed = path.join(outputPath, entry.filePath);
        // Very rarely we have a case where the files are links of each other
        // (or at least node reports that) so the copy would fail.
        // Instead of handling the errors (when we can't be sure if it's due to a bug in node.js
        // or the files are actually identical), delete the target first, that way the move
        // can't fail
        return fs.removeAsync(source)
          .then(() => fs.moveAsync(deployed, source, { overwrite: true }))
          .catch({ code: 'ENOENT' }, (err: any) => log('warn', 'file disappeared', err.path));
      }))
    .then(() => {
      // remove files that the user wants to restore from
      // the activation list because then they get reinstalled.
      // this includes files that were deleted and those replaced
      const dropSet = new Set([].concat(
        (actionGroups['restore'] || []).map(entry => entry.filePath),
        (actionGroups['drop'] || []).map(entry => entry.filePath),
        // also remove the files that got deleted, except these won't be reinstalled
        (actionGroups['delete'] || []).map(entry => entry.filePath),
        // also remove the files that got imported because they too only exist in staging
        // at this point
        (actionGroups['import'] || []).map(entry => entry.filePath),
      ));
      const newDeployment = lastDeployment.filter(entry => !dropSet.has(entry.relPath));
      lastDeployment = newDeployment;
      return Promise.resolve();
    })
    .then(() => {
      const affectedMods = new Set<string>();

      fileActions.forEach(action => {
        if (['import', 'newest', 'nop', 'delete', 'drop'].indexOf(action.action) !== -1) {
          affectedMods.add(action.source);
        }
      });

      const state = api.store.getState();
      let gameId: string;

      if (profileId !== undefined) {
        const profile = profileById(state, profileId);
        if (profile !== undefined) {
          gameId = profile.id;
        }
      }

      if (gameId === undefined) {
        gameId = activeGameId(state);
      }

      affectedMods.forEach(affected => {
        api.events.emit('mod-content-changed', gameId, affected);
      });
    })
    .then(() => lastDeployment);
}

function checkForExternalChanges(api: IExtensionApi,
                                 activator: IDeploymentMethod,
                                 profileId: string,
                                 stagingPath: string,
                                 modPaths: { [typeId: string]: string },
                                 lastDeployment: { [typeId: string]: IDeployedFile[] }) {
  // for each mod type, check if the local files were changed outside vortex
  const changes: { [typeId: string]: IFileChange[] } = {};
  log('debug', 'determine external changes');
  // update mod state again because if the user did have to confirm,
  // it's more intuitive if we deploy the state at the time he confirmed, not when
  // the deployment was triggered
  const state = api.store.getState();

  const profile = profileId !== undefined
    ? getSafe(state, ['persistent', 'profiles', profileId], undefined)
    : activeProfile(state);
  if (profile === undefined) {
    return Promise.reject(new ProcessCanceled('Profile no longer exists.'));
  }
  return Promise.each(Object.keys(modPaths),
    typeId => {
      log('debug', 'checking external changes',
        { modType: typeId, count: lastDeployment[typeId].length });
      return activator.externalChanges(profile.gameId, stagingPath, modPaths[typeId],
        lastDeployment[typeId])
        .then(fileChanges => {
          if (fileChanges.length > 0) {
            changes[typeId] = fileChanges;
          }
        });
    })
    .then(() => changes);
}

export function dealWithExternalChanges(api: IExtensionApi,
                                        activator: IDeploymentMethod,
                                        profileId: string,
                                        stagingPath: string,
                                        modPaths: { [typeId: string]: string },
                                        lastDeployment: { [typeId: string]: IDeployedFile[] }) {
  return checkForExternalChanges(api, activator, profileId, stagingPath, modPaths, lastDeployment)
    .then((changes: { [typeId: string]: IFileChange[] }) => {
      const count = Object.keys(changes).length;
      if (count > 0) {
        log('info', 'found external changes', { count });
        return api.store.dispatch(showExternalChanges(changes));
      } else {
        return Promise.resolve([]);
      }
    })
    .then((fileActions: IFileEntry[]) => Promise.mapSeries(Object.keys(lastDeployment),
      typeId => applyFileActions(api, profileId, stagingPath, modPaths[typeId],
        lastDeployment[typeId],
        fileActions.filter(action => action.modTypeId === typeId))
        .then(newLastDeployment => lastDeployment[typeId] = newLastDeployment)));
}
