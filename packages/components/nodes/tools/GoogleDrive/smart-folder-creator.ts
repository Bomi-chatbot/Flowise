import { z } from 'zod'
import { TOOL_ARGS_PREFIX, formatToolError } from '../../../src/agents'
import { BaseSmartGoogleDriveTool } from './smart-tools'
import { findFolderByName, clearExpiredCache, checkFolderExists, createFolderIfNotExists, createFolderPath } from './google-drive-utils'

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
            clearExpiredCache()
            if (params.folderPath) {
                const folderId = await createFolderPath(this.accessToken, params.folderPath)
                if (!folderId) {
                    const result = {
                        success: false,
                        error: 'FOLDER_CREATION_FAILED',
                        folderPath: params.folderPath,
                        message: `Could not create folder path: ${params.folderPath}`
                    }
                    return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                }

                const result = {
                    success: true,
                    folderId: folderId,
                    folderPath: params.folderPath,
                    message: 'Folder path created successfully',
                    alreadyExisted: false
                }

                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
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

            const existingFolder = await checkFolderExists(this.accessToken, params.folderName, parentId)
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

            const createdFolderId = await createFolderIfNotExists(this.accessToken, params.folderName, parentId)
            if (!createdFolderId) {
                const result = {
                    success: false,
                    error: 'FOLDER_CREATION_FAILED',
                    folderName: params.folderName,
                    parentId: parentId,
                    message:
                        'Failed to create folder. Check server logs for details. Common causes: invalid/expired access token, insufficient permissions, or API quota exceeded.'
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            const createdFolder = await checkFolderExists(this.accessToken, params.folderName, parentId)
            const result = {
                success: true,
                folderId: createdFolderId,
                folderName: params.folderName,
                parentId: parentId,
                message: 'Folder created successfully',
                alreadyExisted: false,
                webViewLink: createdFolder?.webViewLink || `https://drive.google.com/drive/folders/${createdFolderId}`
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            return formatToolError(`Error in smart folder creator: ${error instanceof Error ? error.message : String(error)}`, params)
        }
    }

    private async findParentFolder(parentFolderName: string, createIfNotExists: boolean): Promise<any> {
        try {
            const findResult = await findFolderByName(this.accessToken, parentFolderName, true)
            if (findResult.folders && findResult.folders.length > 0) {
                return {
                    success: true,
                    folderId: findResult.folders.at(0).id,
                    folderName: parentFolderName
                }
            }

            if (createIfNotExists) {
                const newFolderId = await createFolderIfNotExists(this.accessToken, parentFolderName, 'root')
                if (newFolderId) {
                    return {
                        success: true,
                        folderId: newFolderId,
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
}
