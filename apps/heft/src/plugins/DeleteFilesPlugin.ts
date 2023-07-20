// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type * as fs from 'fs';
import { FileSystem, Async, ITerminal } from '@rushstack/node-core-library';

import { Constants } from '../utilities/Constants';
import {
  getFileSelectionSpecifierPathsAsync,
  normalizeFileSelectionSpecifier,
  type IFileSelectionSpecifier
} from './FileGlobSpecifier';
import type { HeftConfiguration } from '../configuration/HeftConfiguration';
import type { IHeftTaskPlugin } from '../pluginFramework/IHeftPlugin';
import type { IHeftTaskSession, IHeftTaskFileOperations } from '../pluginFramework/HeftTaskSession';

/**
 * Used to specify a selection of source files to delete from the specified source folder.
 *
 * @public
 */
export interface IDeleteOperation extends IFileSelectionSpecifier {}

interface IDeleteFilesPluginOptions {
  deleteOperations: IDeleteOperation[];
}

interface IGetPathsToDeleteResult {
  filesToDelete: Set<string>;
  foldersToDelete: Set<string>;
}

async function _getPathsToDeleteAsync(
  rootFolderPath: string,
  deleteOperations: Iterable<IDeleteOperation>
): Promise<IGetPathsToDeleteResult> {
  const result: IGetPathsToDeleteResult = {
    filesToDelete: new Set<string>(),
    foldersToDelete: new Set<string>()
  };

  await Async.forEachAsync(
    deleteOperations,
    async (deleteOperation: IDeleteOperation) => {
      normalizeFileSelectionSpecifier(rootFolderPath, deleteOperation);

      // Glob the files under the source path and add them to the set of files to delete
      const sourcePaths: Map<string, fs.Dirent> = await getFileSelectionSpecifierPathsAsync({
        fileGlobSpecifier: deleteOperation,
        includeFolders: true
      });
      for (const [sourcePath, dirent] of sourcePaths) {
        if (dirent.isDirectory()) {
          result.foldersToDelete.add(sourcePath);
        } else {
          result.filesToDelete.add(sourcePath);
        }
      }
    },
    { concurrency: Constants.maxParallelism }
  );

  return result;
}

export async function deleteFilesAsync(
  rootFolderPath: string,
  deleteOperations: Iterable<IDeleteOperation>,
  terminal: ITerminal
): Promise<void> {
  const pathsToDelete: IGetPathsToDeleteResult = await _getPathsToDeleteAsync(
    rootFolderPath,
    deleteOperations
  );
  await _deleteFilesInnerAsync(pathsToDelete, terminal);
}

async function _deleteFilesInnerAsync(
  pathsToDelete: IGetPathsToDeleteResult,
  terminal: ITerminal
): Promise<void> {
  let deletedFiles: number = 0;
  let deletedFolders: number = 0;

  const { filesToDelete, foldersToDelete } = pathsToDelete;

  await Async.forEachAsync(
    filesToDelete,
    async (pathToDelete: string) => {
      try {
        await FileSystem.deleteFileAsync(pathToDelete, { throwIfNotExists: true });
        terminal.writeVerboseLine(`Deleted "${pathToDelete}".`);
        deletedFiles++;
      } catch (error) {
        // If it doesn't exist, we can ignore the error.
        if (!FileSystem.isNotExistError(error)) {
          throw error;
        }
      }
    },
    { concurrency: Constants.maxParallelism }
  );

  // Clear out any folders that were encountered during the file deletion process. These
  // folders should already be empty.
  await Async.forEachAsync(
    foldersToDelete,
    async (folderToDelete: string) => {
      try {
        await FileSystem.deleteFolderAsync(folderToDelete);
        terminal.writeVerboseLine(`Deleted folder "${folderToDelete}".`);
        deletedFolders++;
      } catch (error) {
        // If it doesn't exist, we can ignore the error.
        if (!FileSystem.isNotExistError(error)) {
          throw error;
        }
      }
    },
    { concurrency: Constants.maxParallelism }
  );

  if (deletedFiles > 0 || deletedFolders > 0) {
    terminal.writeLine(
      `Deleted ${deletedFiles} file${deletedFiles !== 1 ? 's' : ''} ` +
        `and ${deletedFolders} folder${deletedFolders !== 1 ? 's' : ''}`
    );
  }
}

const PLUGIN_NAME: 'delete-files-plugin' = 'delete-files-plugin';

export default class DeleteFilesPlugin implements IHeftTaskPlugin<IDeleteFilesPluginOptions> {
  public apply(
    taskSession: IHeftTaskSession,
    heftConfiguration: HeftConfiguration,
    pluginOptions: IDeleteFilesPluginOptions
  ): void {
    taskSession.hooks.registerFileOperations.tap(
      PLUGIN_NAME,
      (fileOperations: IHeftTaskFileOperations): IHeftTaskFileOperations => {
        for (const deleteOperation of pluginOptions.deleteOperations) {
          fileOperations.deleteOperations.add(deleteOperation);
        }
        return fileOperations;
      }
    );
  }
}
