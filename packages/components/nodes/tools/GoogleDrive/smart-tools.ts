import { z } from 'zod'
import { DynamicStructuredTool } from '../OpenAPIToolkit/core'
import { TOOL_ARGS_PREFIX } from '../../../src/agents'
import {
    findFolderByName,
    clearExpiredCache,
    buildFolderPath,
    makeGoogleDriveRequest,
    setCacheEntry,
    searchFoldersWithFallback,
    addTrashedFilter
} from './google-drive-utils'

export class BaseSmartGoogleDriveTool extends DynamicStructuredTool {
    protected accessToken: string = ''

    constructor(args: any) {
        super(args)
        this.accessToken = args.accessToken ?? ''
    }
}

const SmartFolderFinderSchema = z.object({
    folderName: z.string().describe('Name of the folder to search for'),
    exactMatch: z
        .boolean()
        .optional()
        .default(false)
        .describe('Exact or partial search (Google Drive search is case-insensitive by default)'),
    parentFolderId: z.string().optional().describe('Parent folder ID to limit search'),
    parentFolderName: z.string().optional().describe('Parent folder name for hierarchical search'),
    maxResults: z.number().optional().default(10).describe('Maximum number of results'),
    useFullTextSearch: z.boolean().optional().default(true).describe('Use Google Drive fullText search for better fuzzy matching'),
    includeTrashed: z.boolean().optional().default(false).describe('Include trashed/deleted files in search results')
})

export class SmartFolderFinderTool extends BaseSmartGoogleDriveTool {
    defaultParams: any

    constructor(args: any) {
        const toolInput = {
            name: 'smart_folder_finder',
            description:
                'Search folders by name with case-insensitive matching, fuzzy search for typos, and fallback strategies. Uses Google Drive native search capabilities for optimal results.',
            schema: SmartFolderFinderSchema,
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
            let parentConstraint = ''
            if (params.parentFolderId) {
                parentConstraint = ` and '${params.parentFolderId}' in parents`
            } else if (params.parentFolderName) {
                const parentResult = await findFolderByName(this.accessToken, params.parentFolderName, true, params.includeTrashed)
                if (parentResult.folders && parentResult.folders.length > 0) {
                    const parentId = parentResult.folders[0].id
                    parentConstraint = ` and '${parentId}' in parents`
                }
            }

            let searchResults = await searchFoldersWithFallback(
                this.accessToken,
                params.folderName,
                parentConstraint,
                params.maxResults,
                params.exactMatch,
                params.useFullTextSearch,
                params.includeTrashed
            )

            if (searchResults.files && searchResults.files.length > 0) {
                const allFoldersQuery = new URLSearchParams()
                const baseQuery = `mimeType='application/vnd.google-apps.folder'`
                const filteredQuery = addTrashedFilter(baseQuery, params.includeTrashed)
                allFoldersQuery.append('q', filteredQuery)
                allFoldersQuery.append('pageSize', '1000')
                allFoldersQuery.append('fields', 'files(id,name,parents)')

                const allFoldersResponse = await makeGoogleDriveRequest(this.accessToken, {
                    endpoint: `files?${allFoldersQuery.toString()}`,
                    params: {}
                })
                const allFoldersData = JSON.parse(allFoldersResponse.split(TOOL_ARGS_PREFIX)[0])
                const enhancedFolders = searchResults.files.map((folder: any) => ({
                    ...folder,
                    path: buildFolderPath(folder.id, allFoldersData.files || []),
                    fullPath:
                        folder.parents && folder.parents.length > 0
                            ? buildFolderPath(folder.id, allFoldersData.files || []) + '/' + folder.name
                            : folder.name,
                    searchMethod: searchResults.searchMethod
                }))

                enhancedFolders.forEach((folder: any) => {
                    setCacheEntry(this.accessToken, folder.id, {
                        id: folder.id,
                        name: folder.name,
                        parentId: folder.parents ? folder.parents[0] : null,
                        path: folder.fullPath,
                        lastUpdated: new Date()
                    })
                })

                const result = {
                    success: true,
                    folders: enhancedFolders,
                    count: enhancedFolders.length,
                    searchQuery: params.folderName,
                    searchMethod: searchResults.searchMethod,
                    exactMatch: params.exactMatch
                }

                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            } else {
                const result = {
                    success: false,
                    folders: [],
                    count: 0,
                    searchQuery: params.folderName,
                    searchMethod: searchResults.searchMethod,
                    exactMatch: params.exactMatch
                }

                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }
        } catch (error) {
            return `Error searching folders: ${error}`
        }
    }
}

const HierarchicalFolderNavigatorSchema = z.object({
    operation: z.enum(['listRoot', 'listSubfolders', 'listContents', 'getFolderStructure']).describe('Type of operation'),
    parentFolderName: z.string().optional().describe('Parent folder name'),
    parentFolderId: z.string().optional().describe('Parent folder ID'),
    includeFiles: z.boolean().optional().default(false).describe('Include files in listing'),
    maxDepth: z.number().optional().default(1).describe('Maximum navigation depth'),
    sortBy: z.enum(['name', 'modifiedTime', 'createdTime']).optional().default('name').describe('Sort criteria'),
    maxResults: z.number().optional().default(50).describe('Maximum number of results'),
    searchInShared: z.boolean().optional().default(false).describe('Search in shared files when explicitly requested by user'),
    includeTrashed: z.boolean().optional().default(false).describe('Include trashed/deleted files in search results')
})

export class HierarchicalFolderNavigatorTool extends BaseSmartGoogleDriveTool {
    defaultParams: any

    constructor(args: any) {
        const toolInput = {
            name: 'hierarchical_folder_navigator',
            description: 'Navigate hierarchically through folders with support for root listing, subfolders and content',
            schema: HierarchicalFolderNavigatorSchema,
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

            switch (params.operation) {
                case 'listRoot':
                    return await this.listRootFolders(params)
                case 'listSubfolders':
                    return await this.listSubfolders(params)
                case 'listContents':
                    return await this.listFolderContents(params)
                case 'getFolderStructure':
                    return await this.getFolderStructure(params)
                default:
                    throw new Error(`Unsupported operation: ${params.operation}`)
            }
        } catch (error) {
            return `Error in hierarchical navigation: ${error}`
        }
    }

    private async listRootFolders(params: any): Promise<string> {
        const queryParams = new URLSearchParams()
        const baseQuery = `mimeType='application/vnd.google-apps.folder' and 'root' in parents`
        const filteredQuery = addTrashedFilter(baseQuery, params.includeTrashed)
        queryParams.append('q', filteredQuery)
        queryParams.append('pageSize', params.maxResults.toString())
        queryParams.append('orderBy', params.sortBy)
        queryParams.append('fields', 'files(id,name,createdTime,modifiedTime,webViewLink,size)')

        const endpoint = `files?${queryParams.toString()}`
        const response = await makeGoogleDriveRequest(this.accessToken, { endpoint, params })
        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

        const result = {
            success: true,
            operation: 'listRoot',
            folders: responseData.files || [],
            count: responseData.files ? responseData.files.length : 0,
            message: `Found ${responseData.files ? responseData.files.length : 0} folders in root`
        }

        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
    }

    private async listSubfolders(params: any): Promise<string> {
        let parentId = params.parentFolderId
        if (!parentId && params.parentFolderName) {
            const findResult = await findFolderByName(this.accessToken, params.parentFolderName, true, params.includeTrashed)

            if (findResult.folders && findResult.folders.length > 0) {
                parentId = findResult.folders.at(0).id
            } else {
                const result = {
                    success: false,
                    message: `Parent folder not found: "${params.parentFolderName}"`,
                    folders: [],
                    count: 0
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }
        }

        if (!parentId) {
            throw new Error('Required parentFolderId or parentFolderName')
        }

        const queryParams = new URLSearchParams()
        const baseQuery = `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents`
        const filteredQuery = addTrashedFilter(baseQuery, params.includeTrashed)
        queryParams.append('q', filteredQuery)
        queryParams.append('pageSize', params.maxResults.toString())
        queryParams.append('orderBy', params.sortBy)
        queryParams.append('fields', 'files(id,name,createdTime,modifiedTime,webViewLink)')

        const endpoint = `files?${queryParams.toString()}`
        const response = await makeGoogleDriveRequest(this.accessToken, { endpoint, params })
        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

        const result = {
            success: true,
            operation: 'listSubfolders',
            parentFolderId: parentId,
            parentFolderName: params.parentFolderName,
            folders: responseData.files || [],
            count: responseData.files ? responseData.files.length : 0,
            message: `Found ${responseData.files ? responseData.files.length : 0} subfolders`
        }

        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
    }

    private async listFolderContents(params: any): Promise<string> {
        if (params.searchInShared) {
            return await this.searchInSharedFiles(params)
        }

        let folderId = params.parentFolderId
        if (!folderId && params.parentFolderName) {
            const findResult = await findFolderByName(this.accessToken, params.parentFolderName, true, params.includeTrashed)

            if (findResult.folders && findResult.folders.length > 0) {
                folderId = findResult.folders.at(0).id
            } else {
                const result = {
                    success: false,
                    message: `Folder not found: "${params.parentFolderName}"`,
                    contents: [],
                    count: 0
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }
        }

        if (!folderId) {
            throw new Error('Required parentFolderId or parentFolderName')
        }

        const queryParams = new URLSearchParams()
        const baseQuery = `'${folderId}' in parents`
        const filteredQuery = addTrashedFilter(baseQuery, params.includeTrashed)
        queryParams.append('q', filteredQuery)
        queryParams.append('pageSize', params.maxResults.toString())
        queryParams.append('orderBy', params.sortBy)
        queryParams.append('fields', 'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink)')
        const endpoint = `files?${queryParams.toString()}`
        const response = await makeGoogleDriveRequest(this.accessToken, { endpoint, params })
        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
        const contents = responseData.files || []
        const folders = contents.filter((item: any) => item.mimeType === 'application/vnd.google-apps.folder')
        const files = contents.filter((item: any) => item.mimeType !== 'application/vnd.google-apps.folder')

        const result = {
            success: true,
            operation: 'listContents',
            folderId: folderId,
            folderName: params.parentFolderName,
            contents: params.includeFiles ? contents : folders,
            folders: folders,
            files: files,
            folderCount: folders.length,
            fileCount: files.length,
            totalCount: contents.length,
            message: `Folder contains ${folders.length} folders and ${files.length} files`
        }

        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
    }

    private async getFolderStructure(params: any): Promise<string> {
        const rootResult = await this.listRootFolders(params)
        const rootData = JSON.parse(rootResult.split(TOOL_ARGS_PREFIX)[0])

        const result = {
            success: true,
            operation: 'getFolderStructure',
            structure: rootData.folders,
            message: 'Folder structure obtained (root level)'
        }

        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
    }

    private async searchInSharedFiles(params: any): Promise<string> {
        try {
            const queryParams = new URLSearchParams()
            let query = 'sharedWithMe=true'
            // Only search for files, not folders
            query += ` and mimeType != 'application/vnd.google-apps.folder'`
            if (params.parentFolderName) {
                query += ` and name contains '${params.parentFolderName}'`
            }

            queryParams.append('q', query)
            queryParams.append('pageSize', params.maxResults.toString())
            queryParams.append('orderBy', params.sortBy)
            queryParams.append('fields', 'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,owners)')
            const endpoint = `files?${queryParams.toString()}`
            const response = await makeGoogleDriveRequest(this.accessToken, { endpoint, params })
            const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
            const files = responseData.files || []

            const result = {
                success: true,
                operation: 'listContents',
                searchInShared: true,
                contents: files,
                files: files,
                folders: [],
                folderCount: 0,
                fileCount: files.length,
                totalCount: files.length,
                message: `Found ${files.length} shared files`
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            const result = {
                success: false,
                operation: 'listContents',
                searchInShared: true,
                contents: [],
                files: [],
                folders: [],
                folderCount: 0,
                fileCount: 0,
                totalCount: 0,
                message: `Error searching shared files: ${error}`
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        }
    }
}
