import { z } from 'zod'
import fetch from 'node-fetch'
import { DynamicStructuredTool } from '../OpenAPIToolkit/core'
import { TOOL_ARGS_PREFIX } from '../../../src/agents'

interface FolderCache {
    id: string
    name: string
    parentId: string | null
    path: string
    lastUpdated: Date
    children?: FolderCache[]
}

export class BaseSmartGoogleDriveTool extends DynamicStructuredTool {
    protected accessToken: string = ''
    protected static folderCache: Map<string, FolderCache> = new Map()
    protected static cacheExpiry: number = 3600000

    constructor(args: any) {
        super(args)
        this.accessToken = args.accessToken ?? ''
    }

    async makeGoogleDriveRequest({
        endpoint,
        method = 'GET',
        body,
        params
    }: {
        endpoint: string
        method?: string
        body?: any
        params?: any
    }): Promise<string> {
        const baseUrl = 'https://www.googleapis.com/drive/v3'
        const url = `${baseUrl}/${endpoint}`

        const headers: { [key: string]: string } = {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'application/json',
            ...this.headers
        }

        if (method !== 'GET' && body) {
            headers['Content-Type'] = 'application/json'
        }

        const response = await fetch(url, {
            method,
            headers,
            body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Google Drive API Error ${response.status}: ${response.statusText} - ${errorText}`)
        }

        const data = await response.text()
        return data + TOOL_ARGS_PREFIX + JSON.stringify(params)
    }

    protected clearExpiredCache(): void {
        const now = new Date()
        for (const [key, folder] of BaseSmartGoogleDriveTool.folderCache.entries()) {
            if (now.getTime() - folder.lastUpdated.getTime() > BaseSmartGoogleDriveTool.cacheExpiry) {
                BaseSmartGoogleDriveTool.folderCache.delete(key)
            }
        }
    }

    protected buildFolderPath(folderId: string, folders: any[]): string {
        const folderMap = new Map(folders.map((f) => [f.id, f]))
        const path: string[] = []
        let currentId = folderId

        while (currentId && folderMap.has(currentId)) {
            const folder = folderMap.get(currentId)
            if (folder.name === 'My Drive' || !folder.parents || folder.parents.length === 0) {
                break
            }
            path.unshift(folder.name)
            currentId = folder.parents[0]
        }

        return path.join('/')
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
    useFullTextSearch: z.boolean().optional().default(true).describe('Use Google Drive fullText search for better fuzzy matching')
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
            this.clearExpiredCache()
            let parentConstraint = ''
            if (params.parentFolderId) {
                parentConstraint = ` and '${params.parentFolderId}' in parents`
            } else if (params.parentFolderName) {
                const parentResult = await this.findFolderByName(params.parentFolderName, true)
                if (parentResult.folders && parentResult.folders.length > 0) {
                    const parentId = parentResult.folders[0].id
                    parentConstraint = ` and '${parentId}' in parents`
                }
            }

            let searchResults = await this.performPrimarySearch(params.folderName, parentConstraint, params.exactMatch, params.maxResults)
            if ((!searchResults.files || searchResults.files.length === 0) && !params.exactMatch && params.useFullTextSearch) {
                searchResults = await this.performFallbackSearch(params.folderName, parentConstraint, params.maxResults)
            }

            if (searchResults.files && searchResults.files.length > 0) {
                const allFoldersQuery = new URLSearchParams()
                allFoldersQuery.append('q', `mimeType='application/vnd.google-apps.folder'`)
                allFoldersQuery.append('pageSize', '1000')
                allFoldersQuery.append('fields', 'files(id,name,parents)')

                const allFoldersResponse = await this.makeGoogleDriveRequest({
                    endpoint: `files?${allFoldersQuery.toString()}`,
                    params: {}
                })
                const allFoldersData = JSON.parse(allFoldersResponse.split(TOOL_ARGS_PREFIX)[0])
                const enhancedFolders = searchResults.files.map((folder: any) => ({
                    ...folder,
                    path: this.buildFolderPath(folder.id, allFoldersData.files || []),
                    fullPath:
                        folder.parents && folder.parents.length > 0
                            ? this.buildFolderPath(folder.id, allFoldersData.files || []) + '/' + folder.name
                            : folder.name,
                    searchMethod: searchResults.searchMethod
                }))

                enhancedFolders.forEach((folder: any) => {
                    BaseSmartGoogleDriveTool.folderCache.set(folder.id, {
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

    private async performPrimarySearch(
        folderName: string,
        parentConstraint: string,
        exactMatch: boolean,
        maxResults: number
    ): Promise<any> {
        let searchQuery = `mimeType='application/vnd.google-apps.folder'`
        let searchMethod = ''

        if (exactMatch) {
            searchQuery += ` and name='${folderName}'${parentConstraint}`
            searchMethod = 'exact_match'
        } else {
            searchQuery += ` and name contains '${folderName}'${parentConstraint}`
            searchMethod = 'contains_match'
        }

        const queryParams = new URLSearchParams()
        queryParams.append('q', searchQuery)
        queryParams.append('pageSize', maxResults.toString())
        queryParams.append('fields', 'files(id,name,parents,createdTime,modifiedTime,webViewLink)')

        const endpoint = `files?${queryParams.toString()}`
        const response = await this.makeGoogleDriveRequest({ endpoint, params: {} })
        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

        return {
            files: responseData.files || [],
            searchMethod
        }
    }

    private async performFallbackSearch(folderName: string, parentConstraint: string, maxResults: number): Promise<any> {
        const searchQuery = `mimeType='application/vnd.google-apps.folder' and fullText contains '${folderName}'${parentConstraint}`
        const queryParams = new URLSearchParams()
        queryParams.append('q', searchQuery)
        queryParams.append('pageSize', maxResults.toString())
        queryParams.append('fields', 'files(id,name,parents,createdTime,modifiedTime,webViewLink)')
        const endpoint = `files?${queryParams.toString()}`
        const response = await this.makeGoogleDriveRequest({ endpoint, params: {} })
        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

        return {
            files: responseData.files || [],
            searchMethod: 'fulltext_fuzzy'
        }
    }

    private async findFolderByName(folderName: string, exactMatch: boolean = false): Promise<any> {
        const searchQuery = exactMatch
            ? `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`
            : `mimeType='application/vnd.google-apps.folder' and name contains '${folderName}'`

        const queryParams = new URLSearchParams()
        queryParams.append('q', searchQuery)
        queryParams.append('pageSize', '10')
        queryParams.append('fields', 'files(id,name,parents)')

        const endpoint = `files?${queryParams.toString()}`
        const response = await this.makeGoogleDriveRequest({ endpoint, params: {} })
        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

        return {
            folders: responseData.files || [],
            count: responseData.files ? responseData.files.length : 0
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
    maxResults: z.number().optional().default(50).describe('Maximum number of results')
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
            this.clearExpiredCache()

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
        queryParams.append('q', `mimeType='application/vnd.google-apps.folder' and 'root' in parents`)
        queryParams.append('pageSize', params.maxResults.toString())
        queryParams.append('orderBy', params.sortBy)
        queryParams.append('fields', 'files(id,name,createdTime,modifiedTime,webViewLink,size)')

        const endpoint = `files?${queryParams.toString()}`
        const response = await this.makeGoogleDriveRequest({ endpoint, params })
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
            const smartFinder = new SmartFolderFinderTool({ accessToken: this.accessToken })
            const findResult = await smartFinder._call({
                folderName: params.parentFolderName,
                exactMatch: true,
                maxResults: 1
            })
            const findData = JSON.parse(findResult.split(TOOL_ARGS_PREFIX)[0])

            if (findData.success && findData.folders.length > 0) {
                parentId = findData.folders[0].id
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
        queryParams.append('q', `mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents`)
        queryParams.append('pageSize', params.maxResults.toString())
        queryParams.append('orderBy', params.sortBy)
        queryParams.append('fields', 'files(id,name,createdTime,modifiedTime,webViewLink)')

        const endpoint = `files?${queryParams.toString()}`
        const response = await this.makeGoogleDriveRequest({ endpoint, params })
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
        let folderId = params.parentFolderId
        if (!folderId && params.parentFolderName) {
            const smartFinder = new SmartFolderFinderTool({ accessToken: this.accessToken })
            const findResult = await smartFinder._call({
                folderName: params.parentFolderName,
                exactMatch: true,
                maxResults: 1
            })
            const findData = JSON.parse(findResult.split(TOOL_ARGS_PREFIX)[0])

            if (findData.success && findData.folders.length > 0) {
                folderId = findData.folders[0].id
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
        queryParams.append('q', `'${folderId}' in parents`)
        queryParams.append('pageSize', params.maxResults.toString())
        queryParams.append('orderBy', params.sortBy)
        queryParams.append('fields', 'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink)')
        const endpoint = `files?${queryParams.toString()}`
        const response = await this.makeGoogleDriveRequest({ endpoint, params })
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
}
