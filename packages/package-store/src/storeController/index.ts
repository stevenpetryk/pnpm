import { promises as fs } from 'fs'
import path from 'path'
import createCafs, {
  getFilePathByModeInCafs,
  PackageFilesIndex,
} from '@pnpm/cafs'
import { FetchFunction, PackageFilesResponse } from '@pnpm/fetcher-base'
import createPackageRequester from '@pnpm/package-requester'
import { ResolveFunction } from '@pnpm/resolver-base'
import {
  ImportPackageFunction,
  PackageFileInfo,
  StoreController,
} from '@pnpm/store-controller-types'
import loadJsonFile from 'load-json-file'
import memoize from 'mem'
import pathTemp from 'path-temp'
import writeJsonFile from 'write-json-file'
import createImportPackage from './createImportPackage'
import prune from './prune'

function createPackageImporter (
  opts: {
    packageImportMethod?: 'auto' | 'hardlink' | 'copy' | 'clone'
    cafsDir: string
  }
): ImportPackageFunction {
  const cachedImporterCreator = memoize(createImportPackage)
  const packageImportMethod = opts.packageImportMethod
  const gfm = getFlatMap.bind(null, opts.cafsDir)
  return async (to, opts) => {
    const { filesMap, isBuilt } = gfm(opts.filesResponse, opts.targetEngine)
    const pkgImportMethod = (opts.requiresBuild && !isBuilt)
      ? 'clone-or-copy'
      : (opts.filesResponse.packageImportMethod ?? packageImportMethod)
    const impPkg = cachedImporterCreator(pkgImportMethod)
    const importMethod = await impPkg(to, { filesMap, fromStore: opts.filesResponse.fromStore, force: opts.force })
    return { importMethod, isBuilt }
  }
}

function getFlatMap (
  cafsDir: string,
  filesResponse: PackageFilesResponse,
  targetEngine?: string
): { filesMap: Record<string, string>, isBuilt: boolean } {
  if (filesResponse.local) {
    return {
      filesMap: filesResponse.filesIndex,
      isBuilt: false,
    }
  }
  let isBuilt!: boolean
  let filesIndex!: Record<string, PackageFileInfo>
  if (targetEngine && ((filesResponse.sideEffects?.[targetEngine]) != null)) {
    filesIndex = filesResponse.sideEffects?.[targetEngine]
    isBuilt = true
  } else {
    filesIndex = filesResponse.filesIndex
    isBuilt = false
  }
  const filesMap = {}
  for (const [fileName, fileMeta] of Object.entries(filesIndex)) {
    filesMap[fileName] = getFilePathByModeInCafs(cafsDir, fileMeta.integrity, fileMeta.mode)
  }
  return { filesMap, isBuilt }
}

export function createCafsStore (
  storeDir: string,
  opts?: {
    ignoreFile?: (filename: string) => boolean
    packageImportMethod?: 'auto' | 'hardlink' | 'copy' | 'clone'
  }
) {
  const cafsDir = path.join(storeDir, 'files')
  const baseTempDir = path.join(storeDir, 'tmp')
  const importPackage = createPackageImporter({
    packageImportMethod: opts?.packageImportMethod,
    cafsDir,
  })
  return {
    ...createCafs(cafsDir, opts?.ignoreFile),
    importPackage,
    tempDir: async () => {
      const tmpDir = pathTemp(baseTempDir)
      await fs.mkdir(tmpDir, { recursive: true })
      return tmpDir
    },
  }
}

export default async function (
  resolve: ResolveFunction,
  fetchers: {[type: string]: FetchFunction},
  initOpts: {
    engineStrict?: boolean
    force?: boolean
    nodeVersion?: string
    pnpmVersion?: string
    ignoreFile?: (filename: string) => boolean
    storeDir: string
    networkConcurrency?: number
    packageImportMethod?: 'auto' | 'hardlink' | 'copy' | 'clone'
    verifyStoreIntegrity: boolean
  }
): Promise<StoreController> {
  const storeDir = initOpts.storeDir
  const cafs = createCafsStore(storeDir, initOpts)
  const packageRequester = createPackageRequester({
    force: initOpts.force,
    engineStrict: initOpts.engineStrict,
    nodeVersion: initOpts.nodeVersion,
    pnpmVersion: initOpts.pnpmVersion,
    resolve,
    fetchers,
    cafs,
    ignoreFile: initOpts.ignoreFile,
    networkConcurrency: initOpts.networkConcurrency,
    storeDir: initOpts.storeDir,
    verifyStoreIntegrity: initOpts.verifyStoreIntegrity,
  })

  return {
    close: async () => {}, // eslint-disable-line:no-empty
    fetchPackage: packageRequester.fetchPackageToStore,
    importPackage: cafs.importPackage,
    prune: prune.bind(null, storeDir),
    requestPackage: packageRequester.requestPackage,
    upload,
  }

  async function upload (builtPkgLocation: string, opts: {filesIndexFile: string, engine: string}) {
    const sideEffectsIndex = await cafs.addFilesFromDir(builtPkgLocation)
    // TODO: move this to a function
    // This is duplicated in @pnpm/package-requester
    const integrity: Record<string, PackageFileInfo> = {}
    await Promise.all(
      Object.keys(sideEffectsIndex)
        .map(async (filename) => {
          const {
            checkedAt,
            integrity: fileIntegrity,
          } = await sideEffectsIndex[filename].writeResult
          integrity[filename] = {
            checkedAt,
            integrity: fileIntegrity.toString(), // TODO: use the raw Integrity object
            mode: sideEffectsIndex[filename].mode,
            size: sideEffectsIndex[filename].size,
          }
        })
    )
    let filesIndex!: PackageFilesIndex
    try {
      filesIndex = await loadJsonFile<PackageFilesIndex>(opts.filesIndexFile)
    } catch (err: any) { // eslint-disable-line
      filesIndex = { files: integrity }
    }
    filesIndex.sideEffects = filesIndex.sideEffects ?? {}
    filesIndex.sideEffects[opts.engine] = integrity
    await writeJsonFile(opts.filesIndexFile, filesIndex, { indent: undefined })
  }
}
