import { z } from 'zod'
import { TOOL_ARGS_PREFIX } from '../../../src/agents'
import { BaseSmartGoogleDriveTool } from './smart-tools'

const SmartFolderCreatorSchema = z.object({
    folderName: z.string().describe('Name of the folder to create'),
    parentFolderName: z.string().optional().describe('Parent folder name (search by name)'),
    parentFolderId: z.string().optional().describe('Parent folder ID (alternative to name)'),
    folderPath: z.string().optional().describe('Hierarchical folder path to create (e.g., "Projects/2024/Client1")'),
    createParentsIfNotExist: z.boolean().optional().default(true).describe('Create parent folders if they do not exist'),
    description: z.string().optional().describe('Folder description')
})

export class SmartFolderCreatorTool extends BaseSmartGoogleDriveTool {
    defaultParams: any

    constructor(args: any) {
        const toolInput = {
            name: 'smart_folder_creator',
            description: 'Create folders intelligently with support for hierarchical paths and automatic parent creation',
            schema: SmartFolderCreatorSchema,
            baseUrl: '',
            method: 'POST',
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
            this.clearExpiredCache()
            if (params.folderPath) {
                return await this.createFolderPath(params.folderPath, params.description)
            }

            let parentId = 'root'
            if (params.parentFolderId) {
                parentId = params.parentFolderId
            } else if (params.parentFolderName) {
                const parentResult = await this.findParentFolder(params.parentFolderName, params.createParentsIfNotExist)
                if (!parentResult.success) {
                    return JSON.stringify(parentResult) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                }
                parentId = parentResult.folderId
            }

            const existingFolder = await this.checkFolderExists(params.folderName, parentId)
            if (existingFolder) {
                const result = {
                    success: true,
                    folderId: existingFolder.id,
                    folderName: params.folderName,
                    parentId: parentId,
                    message: 'Folder already exists',
                    alreadyExisted: true,
                    webViewLink: existingFolder.webViewLink
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            const createdFolder = await this.createFolder(params.folderName, parentId, params.description)
            if (!createdFolder) {
                const result = {
                    success: false,
                    error: 'FOLDER_CREATION_FAILED',
                    folderName: params.folderName,
                    parentId: parentId
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            const result = {
                success: true,
                folderId: createdFolder.id,
                folderName: params.folderName,
                parentId: parentId,
                message: 'Folder created successfully',
                alreadyExisted: false,
                webViewLink: createdFolder.webViewLink
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            const result = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
                folderName: params.folderName,
                timestamp: new Date().toISOString()
            }
            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        }
    }

    private async createFolderPath(path: string, description?: string): Promise<string> {
        try {
            if (!path || path.trim() === '' || path.toLowerCase() === 'root' || path.toLowerCase() === '/') {
                const result = {
                    success: false,
                    error: 'INVALID_PATH',
                    message: 'Invalid folder path provided'
                }

                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify({ folderPath: path })
            }

            const pathParts = path.split('/').filter((part) => part.trim().length > 0)
            let currentFolderId = 'root'
            const createdFolders: any[] = []
            const existingFolders: any[] = []

            for (let i = 0; i < pathParts.length; i++) {
                const folderName = pathParts[i]

                if (folderName.toLowerCase() === 'root' || folderName.toLowerCase() === 'my drive') {
                    currentFolderId = 'root'
                    continue
                }

                const existingFolder = await this.checkFolderExists(folderName, currentFolderId)

                if (existingFolder) {
                    currentFolderId = existingFolder.id
                    existingFolders.push({
                        name: folderName,
                        id: existingFolder.id,
                        path: pathParts.slice(0, i + 1).join('/')
                    })
                } else {
                    const isLastFolder = i === pathParts.length - 1
                    const folderDescription = isLastFolder ? description : undefined
                    const newFolder = await this.createFolder(folderName, currentFolderId, folderDescription)
                    if (!newFolder) {
                        const result = {
                            success: false,
                            error: 'FOLDER_CREATION_FAILED',
                            failedAt: folderName,
                            path: pathParts.slice(0, i + 1).join('/'),
                            createdFolders: createdFolders,
                            existingFolders: existingFolders
                        }

                        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify({ folderPath: path })
                    }

                    currentFolderId = newFolder.id
                    createdFolders.push({
                        name: folderName,
                        id: newFolder.id,
                        path: pathParts.slice(0, i + 1).join('/'),
                        webViewLink: newFolder.webViewLink
                    })
                }
            }

            const result = {
                success: true,
                finalFolderId: currentFolderId,
                folderPath: path,
                createdFolders: createdFolders,
                existingFolders: existingFolders,
                totalCreated: createdFolders.length,
                totalExisting: existingFolders.length,
                message: `Folder path created successfully. Created ${createdFolders.length} new folders, found ${existingFolders.length} existing folders.`
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify({ folderPath: path })
        } catch (error) {
            const result = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
                folderPath: path,
                timestamp: new Date().toISOString()
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify({ folderPath: path })
        }
    }

    private async findParentFolder(parentFolderName: string, createIfNotExists: boolean): Promise<any> {
        try {
            const searchQuery = `mimeType='application/vnd.google-apps.folder' and name='${parentFolderName}'`
            const queryParams = new URLSearchParams()
            queryParams.append('q', searchQuery)
            queryParams.append('pageSize', '1')
            queryParams.append('fields', 'files(id,name,webViewLink)')
            const response = await this.makeGoogleDriveRequest({
                endpoint: `files?${queryParams.toString()}`,
                params: {}
            })
            const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
            if (responseData.files && responseData.files.length > 0) {
                return {
                    success: true,
                    folderId: responseData.files[0].id,
                    folderName: parentFolderName
                }
            }

            if (createIfNotExists) {
                const newFolder = await this.createFolder(parentFolderName, 'root')
                if (newFolder) {
                    return {
                        success: true,
                        folderId: newFolder.id,
                        folderName: parentFolderName,
                        created: true
                    }
                }
            }

            return {
                success: false,
                error: 'PARENT_FOLDER_NOT_FOUND',
                folderName: parentFolderName,
                message: `Parent folder "${parentFolderName}" not found and createParentsIfNotExist is ${createIfNotExists}`
            }
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                folderName: parentFolderName
            }
        }
    }

    private async checkFolderExists(folderName: string, parentId: string): Promise<any> {
        try {
            const parentConstraint = parentId === 'root' ? ` and 'root' in parents` : ` and '${parentId}' in parents`
            const searchQuery = `mimeType='application/vnd.google-apps.folder' and name='${folderName}'${parentConstraint}`
            const queryParams = new URLSearchParams()
            queryParams.append('q', searchQuery)
            queryParams.append('pageSize', '1')
            queryParams.append('fields', 'files(id,name,webViewLink)')
            const response = await this.makeGoogleDriveRequest({
                endpoint: `files?${queryParams.toString()}`,
                params: {}
            })

            const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
            return responseData.files && responseData.files.length > 0 ? responseData.files[0] : null
        } catch (error) {
            console.error('Error checking folder existence:', error)
            return null
        }
    }

    private async createFolder(folderName: string, parentId: string, description?: string): Promise<any> {
        try {
            const folderMetadata: any = {
                name: folderName,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parentId]
            }

            if (description) {
                folderMetadata.description = description
            }

            const response = await this.makeGoogleDriveRequest({
                endpoint: 'files',
                method: 'POST',
                body: folderMetadata,
                params: {}
            })

            const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
            return responseData
        } catch (error) {
            console.error('Error creating folder:', error)
            return null
        }
    }
}
