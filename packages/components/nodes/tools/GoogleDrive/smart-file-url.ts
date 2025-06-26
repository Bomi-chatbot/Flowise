import { z } from 'zod'
import { TOOL_ARGS_PREFIX } from '../../../src/agents'
import { BaseSmartGoogleDriveTool } from './smart-tools'
import {
    clearExpiredCache,
    getFileById,
    resolveFolderPath,
    findFolderByName,
    findFileByName,
    makeGoogleDriveRequest
} from './google-drive-utils'

const SmartFileUrlSchema = z.object({
    fileName: z.string().optional().describe('File name to search for'),
    fileId: z.string().optional().describe('File ID (direct access)'),
    folderName: z.string().optional().describe('Folder name to search in'),
    folderId: z.string().optional().describe('Folder ID to search in'),
    folderPath: z.string().optional().describe('Hierarchical folder path (e.g., "Projects/2024")'),
    urlType: z.enum(['view', 'download', 'share']).default('view').describe('Type of URL to generate'),
    exactMatch: z.boolean().optional().default(false).describe('Exact file name match vs partial'),
    maxResults: z.number().optional().default(10).describe('Maximum number of files to return if multiple matches')
})

export class SmartFileUrlTool extends BaseSmartGoogleDriveTool {
    defaultParams: any

    constructor(args: any) {
        const toolInput = {
            name: 'smart_file_url',
            description: 'Get file URLs intelligently by searching files by name, folder, or path with support for different URL types',
            schema: SmartFileUrlSchema,
            baseUrl: '',
            method: 'GET',
            headers: {}
        }
        super({
            ...toolInput,
            accessToken: args.accessToken
        })
        this.defaultParams = args.defaultParams || {}
    }

    async _call(arg: any): Promise<string> {
        const params = { ...arg, ...this.defaultParams }

        try {
            clearExpiredCache()
            if (!params.fileId && !params.fileName && !params.folderName && !params.folderId) {
                const result = {
                    success: false,
                    error: 'MISSING_REQUIRED_PARAMS',
                    message: 'Either fileId, fileName, folderId, or folderName is required'
                }

                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            let files: any[] = []
            if (params.fileId) {
                const file = await getFileById(this.accessToken, params.fileId)
                if (file) {
                    files = [file]
                } else {
                    const result = {
                        success: false,
                        error: 'FILE_NOT_FOUND',
                        fileId: params.fileId,
                        message: `File with ID "${params.fileId}" not found`
                    }
                    return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                }
            } else if (params.folderId) {
                const folder = await getFileById(this.accessToken, params.folderId)
                if (folder) {
                    files = [folder]
                } else {
                    const result = {
                        success: false,
                        error: 'FOLDER_NOT_FOUND',
                        folderId: params.folderId,
                        message: `Folder with ID "${params.folderId}" not found`
                    }
                    return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                }
            } else if (params.fileName) {
                files = await this.searchFilesByName(params)
                if (files.length === 0) {
                    const result = {
                        success: false,
                        error: 'FILE_NOT_FOUND',
                        fileName: params.fileName,
                        searchCriteria: {
                            folderName: params.folderName,
                            folderId: params.folderId,
                            folderPath: params.folderPath,
                            exactMatch: params.exactMatch
                        },
                        message: `No files found matching "${params.fileName}"`
                    }

                    return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                }
            } else if (params.folderName) {
                files = await this.searchFoldersByName(params)
                if (files.length === 0) {
                    const result = {
                        success: false,
                        error: 'FOLDER_NOT_FOUND',
                        folderName: params.folderName,
                        searchCriteria: {
                            folderPath: params.folderPath,
                            exactMatch: params.exactMatch
                        },
                        message: `No folders found matching "${params.folderName}"`
                    }

                    return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                }
            }

            const filesWithUrls = await Promise.all(
                files.map(async (file) => {
                    const urls = await this.generateFileUrls(file, params.urlType)
                    return {
                        ...file,
                        urls: urls
                    }
                })
            )

            const result = {
                success: true,
                files: filesWithUrls,
                count: filesWithUrls.length,
                urlType: params.urlType,
                searchCriteria: params.fileId
                    ? { fileId: params.fileId }
                    : {
                          fileName: params.fileName,
                          folderName: params.folderName,
                          folderId: params.folderId,
                          folderPath: params.folderPath,
                          exactMatch: params.exactMatch
                      },
                message: `Found ${filesWithUrls.length} file(s) with ${params.urlType} URLs`
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            const result = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
                searchParams: params,
                timestamp: new Date().toISOString()
            }
            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        }
    }

    private async searchFilesByName(params: any): Promise<any[]> {
        try {
            let folderId: string | undefined = undefined
            if (params.folderId) {
                folderId = params.folderId
            } else if (params.folderName || params.folderPath) {
                folderId = (await this.resolveFolderId(params)) || undefined
            }

            const result = await findFileByName(this.accessToken, params.fileName, params.exactMatch, folderId, params.maxResults)
            return result.files || []
        } catch (error) {
            console.error('Error searching files by name:', error)
            return []
        }
    }

    private async searchFoldersByName(params: any): Promise<any[]> {
        try {
            const result = await findFolderByName(this.accessToken, params.folderName, params.exactMatch)
            if (params.folderPath && result.folders && result.folders.length > 0) {
                const parentFolderId = await resolveFolderPath(this.accessToken, params.folderPath)
                if (parentFolderId) {
                    return result.folders.filter((folder: any) => folder.parents && folder.parents.includes(parentFolderId))
                }
            }

            return result.folders || []
        } catch (error) {
            console.error('Error searching folders by name:', error)
            return []
        }
    }

    private async resolveFolderId(params: any): Promise<string | null> {
        try {
            if (params.folderId) {
                return params.folderId
            }

            if (params.folderPath) {
                return await resolveFolderPath(this.accessToken, params.folderPath)
            }

            if (params.folderName) {
                const result = await findFolderByName(this.accessToken, params.folderName, true)
                if (result.folders && result.folders.length > 0) {
                    return result.folders.at(0).id
                }
                return null
            }

            return null
        } catch (error) {
            console.error('Error resolving folder ID:', error)
            return null
        }
    }

    private async generateFileUrls(file: any, urlType: string): Promise<any> {
        try {
            const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
            const urls: any = {}
            if (isFolder) {
                urls.view = file.webViewLink || `https://drive.google.com/drive/folders/${file.id}`
                urls.download = null // Folders can't be downloaded directly
            } else {
                urls.view = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`
                urls.download = file.webContentLink || `https://drive.google.com/uc?id=${file.id}&export=download`
            }

            if (urlType === 'share' || urlType === 'all') {
                try {
                    const shareUrl = await this.getOrCreateShareUrl(file.id)
                    urls.share = shareUrl
                } catch (error) {
                    console.warn(`Could not generate share URL for ${isFolder ? 'folder' : 'file'} ${file.id}:`, error)
                    urls.share = urls.view
                }
            }

            switch (urlType) {
                case 'view':
                    return { view: urls.view }
                case 'download':
                    if (isFolder) {
                        return {
                            download: null,
                            message: 'Folders cannot be downloaded directly. Use view or share URL instead.'
                        }
                    }
                    return { download: urls.download }
                case 'share':
                    return { share: urls.share }
                default:
                    return urls
            }
        } catch (error) {
            console.error('Error generating URLs:', error)
            const isFolder = file.mimeType === 'application/vnd.google-apps.folder'
            if (isFolder) {
                return {
                    view: `https://drive.google.com/drive/folders/${file.id}`,
                    download: null,
                    error: 'Could not generate all URLs'
                }
            } else {
                return {
                    view: `https://drive.google.com/file/d/${file.id}/view`,
                    download: `https://drive.google.com/uc?id=${file.id}&export=download`,
                    error: 'Could not generate all URLs'
                }
            }
        }
    }

    private async getOrCreateShareUrl(fileId: string): Promise<string> {
        try {
            const fileInfo = await getFileById(this.accessToken, fileId)
            const isFolder = fileInfo?.mimeType === 'application/vnd.google-apps.folder'
            const permissionsResponse = await makeGoogleDriveRequest(this.accessToken, {
                endpoint: `files/${encodeURIComponent(fileId)}/permissions`,
                params: {}
            })

            const permissionsData = JSON.parse(permissionsResponse.split(TOOL_ARGS_PREFIX)[0])
            const publicPermission = permissionsData.permissions?.find((p: any) => p.type === 'anyone')

            const baseUrl = isFolder
                ? `https://drive.google.com/drive/folders/${fileId}?usp=sharing`
                : `https://drive.google.com/file/d/${fileId}/view?usp=sharing`

            if (publicPermission) {
                return baseUrl
            }

            const permissionData = {
                role: 'reader',
                type: 'anyone'
            }

            await makeGoogleDriveRequest(this.accessToken, {
                endpoint: `files/${encodeURIComponent(fileId)}/permissions`,
                method: 'POST',
                body: permissionData,
                params: {}
            })

            return baseUrl
        } catch (error) {
            console.warn('Could not create share permission:', error)
            // Fallback - try to determine if it's a folder from the fileId pattern or default to file
            return `https://drive.google.com/file/d/${fileId}/view`
        }
    }
}
