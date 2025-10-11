import fetch from 'node-fetch'
import { TOOL_ARGS_PREFIX } from '../../../src/agents'
import { handleGoogleAPIResponse } from '../shared/access-control-utils'

/**
 * Adds trashed=false filter to Google Drive queries when includeTrashed is false
 * @param query - The original Google Drive query
 * @param includeTrashed - Whether to include trashed files (default: false)
 * @returns Modified query with trashed filter if needed
 */
export function addTrashedFilter(query: string, includeTrashed: boolean = false): string {
    if (includeTrashed) {
        return query
    }

    if (!query.includes('trashed')) {
        const connector = query.trim().length > 0 ? ' and ' : ''
        return query + connector + 'trashed=false'
    }

    return query
}

interface FolderCache {
    id: string
    name: string
    parentId: string | null
    path: string
    lastUpdated: Date
    children?: FolderCache[]
}

interface CacheEntry {
    data: FolderCache
    accessTokenHash: string
    expiresAt: number
}

const folderCache: Map<string, CacheEntry> = new Map()
const CACHE_EXPIRY = 3600000 // 1 hour

/**
 * Generates a hashed representation of an access token by extracting the last 8 characters.
 * This function is useful for creating a simplified or obfuscated version of the token
 * without exposing its full value.
 *
 * @param accessToken - The access token string to be hashed.
 * @returns A string containing the last 8 characters of the provided access token.
 */
function hashAccessToken(accessToken: string): string {
    return accessToken.slice(-8)
}

/**
 * Generates a unique cache key based on the provided access token and folder ID.
 *
 * @param accessToken - The access token used for authentication.
 * @param folderId - The ID of the folder to be accessed.
 * @returns A string representing the cache key, combining a hashed version of the access token and the folder ID.
 */
function createCacheKey(accessToken: string, folderId: string): string {
    return `${hashAccessToken(accessToken)}:${folderId}`
}

/**
 * Find folders by name with exact or partial matching
 */
export async function findFolderByName(
    accessToken: string,
    folderName: string,
    exactMatch: boolean = false,
    includeTrashed: boolean = false
): Promise<any> {
    const escapedFolderName = folderName.replace(/'/g, "\\'")

    const baseQuery = exactMatch
        ? `mimeType='application/vnd.google-apps.folder' and name='${escapedFolderName}'`
        : `mimeType='application/vnd.google-apps.folder' and name contains '${escapedFolderName}'`

    const searchQuery = addTrashedFilter(baseQuery, includeTrashed)

    const queryParams = new URLSearchParams()
    queryParams.append('q', searchQuery)
    queryParams.append('pageSize', '10')
    queryParams.append('fields', 'files(id,name,parents)')

    const endpoint = `files?${queryParams.toString()}`
    const response = await makeGoogleDriveRequest(accessToken, { endpoint, params: {} })
    const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

    return {
        folders: responseData.files || [],
        count: responseData.files ? responseData.files.length : 0
    }
}

/**
 * Find files by name with exact or partial matching
 */
export async function findFileByName(
    accessToken: string,
    fileName: string,
    exactMatch: boolean = false,
    folderId?: string,
    maxResults: number = 10,
    includeTrashed: boolean = false
): Promise<any> {
    let searchQuery = ''
    let folderConstraint = ''

    if (folderId) {
        folderConstraint = ` and '${folderId}' in parents`
    }

    const escapedFileName = fileName.replace(/'/g, "\\'")
    if (exactMatch) {
        searchQuery = `name='${escapedFileName}'${folderConstraint}`
    } else {
        searchQuery = `name contains '${escapedFileName}'${folderConstraint}`
    }

    searchQuery += ` and mimeType != 'application/vnd.google-apps.folder'`
    searchQuery = addTrashedFilter(searchQuery, includeTrashed)

    const queryParams = new URLSearchParams()
    queryParams.append('q', searchQuery)
    queryParams.append('pageSize', maxResults.toString())
    queryParams.append('fields', 'files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,parents)')
    queryParams.append('orderBy', 'modifiedTime desc')
    const endpoint = `files?${queryParams.toString()}`
    const response = await makeGoogleDriveRequest(accessToken, { endpoint, params: {} })
    const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

    return {
        files: responseData.files || [],
        count: responseData.files ? responseData.files.length : 0
    }
}

/**
 * Search folders with fallback strategies for better matching
 */
export async function searchFoldersWithFallback(
    accessToken: string,
    folderName: string,
    parentConstraint: string,
    maxResults: number,
    exactMatch: boolean = false,
    useFullTextSearch: boolean = true,
    includeTrashed: boolean = false
): Promise<any> {
    let searchResults = await performPrimarySearch(accessToken, folderName, parentConstraint, exactMatch, maxResults, includeTrashed)
    if ((!searchResults.files || searchResults.files.length === 0) && !exactMatch && useFullTextSearch) {
        searchResults = await performFallbackSearch(accessToken, folderName, parentConstraint, maxResults, includeTrashed)
    }

    return searchResults
}

/**
 * Build folder path from folder ID and folder list
 */
export function buildFolderPath(folderId: string, folders: any[]): string {
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

/**
 * Make Google Drive API request
 */
export async function makeGoogleDriveRequest(
    accessToken: string,
    {
        endpoint,
        method = 'GET',
        body,
        params,
        accessControlContext
    }: {
        endpoint: string
        method?: string
        body?: any
        params?: any
        accessControlContext?: any
    }
): Promise<string> {
    const baseUrl = 'https://www.googleapis.com/drive/v3'
    const url = `${baseUrl}/${endpoint}`

    const headers: { [key: string]: string } = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
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
        let errorResponse = null

        try {
            errorResponse = JSON.parse(errorText)
        } catch (parseError) {
            // Not JSON, continue with text error
        }

        const error = new Error(`Google Drive API Error ${response.status}: ${response.statusText} - ${errorText}`)
        return await handleGoogleAPIResponse(error, response.status, params, accessControlContext, errorResponse)
    }

    const data = await response.text()
    return data + TOOL_ARGS_PREFIX + JSON.stringify(params)
}

/**
 * Clear expired cache entries
 */
export function clearExpiredCache(): void {
    const now = Date.now()
    for (const [key, entry] of folderCache.entries()) {
        if (now > entry.expiresAt) {
            folderCache.delete(key)
        }
    }
}

/**
 * Get folder cache entry for specific access token and folder ID
 */
export function getCacheEntry(accessToken: string, folderId: string): FolderCache | null {
    const key = createCacheKey(accessToken, folderId)
    const entry = folderCache.get(key)

    if (!entry) {
        return null
    }

    if (Date.now() > entry.expiresAt) {
        folderCache.delete(key)
        return null
    }

    if (entry.accessTokenHash !== hashAccessToken(accessToken)) {
        folderCache.delete(key)
        return null
    }

    return entry.data
}

/**
 * Set folder cache entry with access token isolation
 */
export function setCacheEntry(accessToken: string, folderId: string, folderData: FolderCache): void {
    const key = createCacheKey(accessToken, folderId)
    const entry: CacheEntry = {
        data: folderData,
        accessTokenHash: hashAccessToken(accessToken),
        expiresAt: Date.now() + CACHE_EXPIRY
    }
    folderCache.set(key, entry)
}

/**
 * Get all folder cache entries for a specific access token (for debugging/monitoring)
 */
export function getFolderCacheForToken(accessToken: string): Map<string, FolderCache> {
    const tokenHash = hashAccessToken(accessToken)
    const result = new Map<string, FolderCache>()

    for (const [key, entry] of folderCache.entries()) {
        if (entry.accessTokenHash === tokenHash && Date.now() <= entry.expiresAt) {
            // Extraer el folderId de la clave (después del ':')
            const folderId = key.split(':')[1]
            result.set(folderId, entry.data)
        }
    }

    return result
}

/**
 * Primary search implementation
 */
async function performPrimarySearch(
    accessToken: string,
    folderName: string,
    parentConstraint: string,
    exactMatch: boolean,
    maxResults: number,
    includeTrashed: boolean = false
): Promise<any> {
    let searchQuery = `mimeType='application/vnd.google-apps.folder'`
    let searchMethod = ''

    const escapedFolderName = folderName.replace(/'/g, "\\'")
    if (exactMatch) {
        searchQuery += ` and name='${escapedFolderName}'${parentConstraint}`
        searchMethod = 'exact_match'
    } else {
        searchQuery += ` and name contains '${escapedFolderName}'${parentConstraint}`
        searchMethod = 'contains_match'
    }

    searchQuery = addTrashedFilter(searchQuery, includeTrashed)

    const queryParams = new URLSearchParams()
    queryParams.append('q', searchQuery)
    queryParams.append('pageSize', maxResults.toString())
    queryParams.append('fields', 'files(id,name,parents,createdTime,modifiedTime,webViewLink)')

    const endpoint = `files?${queryParams.toString()}`
    const response = await makeGoogleDriveRequest(accessToken, { endpoint, params: {} })
    const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

    return {
        files: responseData.files || [],
        searchMethod
    }
}

/**
 * Fallback search implementation
 */
async function performFallbackSearch(
    accessToken: string,
    folderName: string,
    parentConstraint: string,
    maxResults: number,
    includeTrashed: boolean = false
): Promise<any> {
    const escapedFolderName = folderName.replace(/'/g, "\\'")
    let searchQuery = `mimeType='application/vnd.google-apps.folder' and fullText contains '${escapedFolderName}'${parentConstraint}`
    searchQuery = addTrashedFilter(searchQuery, includeTrashed)

    const queryParams = new URLSearchParams()
    queryParams.append('q', searchQuery)
    queryParams.append('pageSize', maxResults.toString())
    queryParams.append('fields', 'files(id,name,parents,createdTime,modifiedTime,webViewLink)')
    const endpoint = `files?${queryParams.toString()}`
    const response = await makeGoogleDriveRequest(accessToken, { endpoint, params: {} })
    const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])

    return {
        files: responseData.files || [],
        searchMethod: 'fulltext_fuzzy'
    }
}

/**
 * Resolve folder path to folder ID
 */
export async function resolveFolderPath(accessToken: string, path: string, includeTrashed: boolean = false): Promise<string | null> {
    try {
        if (!path || path.trim() === '' || path.toLowerCase() === 'root' || path.toLowerCase() === '/') {
            return 'root'
        }

        const pathParts = path.split('/').filter((part) => part.trim().length > 0)
        let currentFolderId = 'root'

        for (const folderName of pathParts) {
            if (folderName.toLowerCase() === 'root' || folderName.toLowerCase() === 'my drive') {
                currentFolderId = 'root'
                continue
            }

            const parentConstraint = currentFolderId === 'root' ? ` and 'root' in parents` : ` and '${currentFolderId}' in parents`
            const escapedFolderName = folderName.replace(/'/g, "\\'")
            const baseQuery = `mimeType='application/vnd.google-apps.folder' and name='${escapedFolderName}'${parentConstraint}`
            const searchQuery = addTrashedFilter(baseQuery, includeTrashed)
            const queryParams = new URLSearchParams()
            queryParams.append('q', searchQuery)
            queryParams.append('pageSize', '1')
            queryParams.append('fields', 'files(id,name)')
            const response = await makeGoogleDriveRequest(accessToken, {
                endpoint: `files?${queryParams.toString()}`,
                params: {}
            })

            const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
            if (responseData.files && responseData.files.length > 0) {
                currentFolderId = responseData.files[0].id
            } else {
                return null // Folder not found in path
            }
        }

        return currentFolderId
    } catch (error) {
        console.error('Error resolving folder path:', error)
        return null
    }
}

/**
 * Check if file exists in a specific folder
 */
export async function checkFileExists(
    accessToken: string,
    fileName: string,
    folderId: string,
    includeTrashed: boolean = false
): Promise<any> {
    try {
        const escapedFileName = fileName.replace(/'/g, "\\'")
        const baseQuery = `name='${escapedFileName}' and '${folderId}' in parents`
        const searchQuery = addTrashedFilter(baseQuery, includeTrashed)
        const queryParams = new URLSearchParams()
        queryParams.append('q', searchQuery)
        queryParams.append('pageSize', '1')
        queryParams.append('fields', 'files(id,name)')
        const response = await makeGoogleDriveRequest(accessToken, {
            endpoint: `files?${queryParams.toString()}`,
            params: {}
        })

        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
        return responseData.files && responseData.files.length > 0 ? responseData.files[0] : null
    } catch (error) {
        console.error('Error checking file existence:', error)
        return null
    }
}

/**
 * Create folder if it doesn't exist
 */
export async function createFolderIfNotExists(accessToken: string, folderName: string, parentId: string = 'root'): Promise<string | null> {
    try {
        const existingFolder = await checkFolderExists(accessToken, folderName, parentId)
        if (existingFolder) {
            return existingFolder.id
        }

        const folderMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId]
        }

        const response = await makeGoogleDriveRequest(accessToken, {
            endpoint: 'files',
            method: 'POST',
            body: folderMetadata,
            params: {}
        })

        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
        return responseData.id
    } catch (error) {
        console.error('Error creating folder:', {
            folderName,
            parentId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
        })
        return null
    }
}

/**
 * Check if folder exists in a specific parent folder
 */
export async function checkFolderExists(
    accessToken: string,
    folderName: string,
    parentId: string,
    includeTrashed: boolean = false
): Promise<any> {
    try {
        const parentConstraint = parentId === 'root' ? ` and 'root' in parents` : ` and '${parentId}' in parents`
        const escapedFolderName = folderName.replace(/'/g, "\\'")
        const baseQuery = `mimeType='application/vnd.google-apps.folder' and name='${escapedFolderName}'${parentConstraint}`
        const searchQuery = addTrashedFilter(baseQuery, includeTrashed)
        const queryParams = new URLSearchParams()
        queryParams.append('q', searchQuery)
        queryParams.append('pageSize', '1')
        queryParams.append('fields', 'files(id,name,webViewLink)')
        const response = await makeGoogleDriveRequest(accessToken, {
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

/**
 * Create folder path (creates all folders in the path if they don't exist)
 */
export async function createFolderPath(accessToken: string, path: string): Promise<string | null> {
    try {
        if (!path || path.trim() === '' || path.toLowerCase() === 'root' || path.toLowerCase() === '/') {
            return 'root'
        }

        const pathParts = path.split('/').filter((part) => part.trim().length > 0)
        let currentFolderId = 'root'

        for (const folderName of pathParts) {
            if (folderName.toLowerCase() === 'root' || folderName.toLowerCase() === 'my drive') {
                currentFolderId = 'root'
                continue
            }

            const existingFolder = await checkFolderExists(accessToken, folderName, currentFolderId)
            if (existingFolder) {
                currentFolderId = existingFolder.id
            } else {
                const newFolderId = await createFolderIfNotExists(accessToken, folderName, currentFolderId)
                if (!newFolderId) {
                    return null
                }
                currentFolderId = newFolderId
            }
        }

        return currentFolderId
    } catch (error) {
        console.error('Error creating folder path:', error)
        return null
    }
}

/**
 * Get file by ID
 */
export async function getFileById(accessToken: string, fileId: string): Promise<any> {
    try {
        const queryParams = new URLSearchParams()
        queryParams.append('fields', 'id,name,mimeType,size,createdTime,modifiedTime,webViewLink,webContentLink,parents')
        const response = await makeGoogleDriveRequest(accessToken, {
            endpoint: `files/${encodeURIComponent(fileId)}?${queryParams.toString()}`,
            params: {}
        })

        const responseData = JSON.parse(response.split(TOOL_ARGS_PREFIX)[0])
        return responseData
    } catch (error) {
        console.error('Error getting file by ID:', error)
        return null
    }
}
