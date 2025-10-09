import { z } from 'zod'
import fetch from 'node-fetch'
import { randomUUID } from 'crypto'
import sanitizeFilename from 'sanitize-filename'
import { lookup } from 'mime-types'
import { TOOL_ARGS_PREFIX, formatToolError } from '../../../src/agents'
import { BaseSmartGoogleDriveTool } from './smart-tools'
import { findFolderByName, resolveFolderPath, checkFileExists, createFolderIfNotExists, createFolderPath } from './google-drive-utils'

const URLFileUploaderSchema = z.object({
    fileUrl: z
        .union([z.string().describe('URL of the file to download'), z.array(z.string()).describe('Array of URLs of files to download')])
        .describe('URL(s) of the file(s) to download - can be a single URL string or array of URLs'),
    targetFolderName: z.string().describe('Name of the target folder'),
    targetFolderId: z.string().optional().describe('ID of the target folder (alternative to name)'),
    fileName: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
            'Custom name(s) for the file(s) - can be a single string or array of strings corresponding to fileUrl array. If not provided or array is shorter than URLs, automatic names will be generated'
        ),
    folderPath: z.string().optional().describe('Hierarchical folder path (e.g., "Projects/2024")'),
    overwriteExisting: z.boolean().optional().default(false).describe('Overwrite file if it already exists'),
    requireConfirmationToCreateFolder: z
        .boolean()
        .optional()
        .default(false)
        .describe(
            'Require user confirmation before creating folders that do not exist (deprecated - folders are now created automatically)'
        ),
    userConfirmedFolderCreation: z
        .boolean()
        .optional()
        .default(false)
        .describe('User has confirmed folder creation (used internally after human input - deprecated)')
})

interface TwilioAuthConfig {
    accountSid: string
    authToken: string
    baseUrl?: string
    timeout?: number
    retryAttempts?: number
}

export class URLFileUploaderTool extends BaseSmartGoogleDriveTool {
    defaultParams: any
    private twilioCredentials: TwilioAuthConfig | null = null
    requiresHumanInput?: boolean

    constructor(args: any) {
        const toolInput = {
            name: 'url_file_uploader',
            description:
                'Downloads single or multiple files from URLs (especially Twilio) and uploads them to Google Drive with intelligent folder search. Supports batch processing with detailed success/failure reporting. Automatically creates folders if they do not exist and provides detailed location information including folder ID and path.',
            schema: URLFileUploaderSchema,
            baseUrl: '',
            method: 'POST',
            headers: {}
        }
        super({
            ...toolInput,
            accessToken: args.accessToken
        })

        this.defaultParams = args.defaultParams || {}
        this.twilioCredentials = args.twilioCredentials || null
    }

    /**
     * Check if the given folder name or path refers to the root directory
     */
    private isRootFolder(folderNameOrPath: string): boolean {
        if (!folderNameOrPath || typeof folderNameOrPath !== 'string') {
            return false
        }

        const normalized = folderNameOrPath.trim().toLowerCase()
        const rootVariations = ['root', 'my drive', 'mydrive', '/', '', 'drive', 'google drive', 'googledrive']
        return rootVariations.includes(normalized)
    }

    async _call(arg: any): Promise<string> {
        const params = { ...arg, ...this.defaultParams }

        try {
            const rawUrls = Array.isArray(params.fileUrl) ? params.fileUrl : [params.fileUrl]
            const urlValidationResult = this.validateAndDeduplicateUrls(rawUrls)
            if (urlValidationResult.validUrls.length === 0) {
                const result = {
                    success: false,
                    error: 'ALL_URLS_INVALID',
                    message: 'No valid URLs found to process',
                    invalidUrls: urlValidationResult.invalidUrls,
                    details: 'All provided URLs failed validation. Please check the URLs and try again.'
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            const fileUrls = urlValidationResult.validUrls
            let fileNames: string[] = []
            if (params.fileName) {
                fileNames = Array.isArray(params.fileName) ? params.fileName : [params.fileName]
            }

            while (fileNames.length < fileUrls.length) {
                fileNames.push('')
            }

            const { accountSid, authToken } = this.twilioCredentials || {}
            const hasTwilioUrls = fileUrls.some((url: string) => this.isTwilioURL(url))
            if (hasTwilioUrls && !(accountSid && authToken)) {
                const result = {
                    success: false,
                    error: 'TWILIO_CREDENTIALS_MISSING',
                    message: 'Twilio credentials are required for Twilio URLs. Please configure Twilio API credentials in Flowise.',
                    debug: {
                        urls: fileUrls,
                        twilioUrls: fileUrls.filter((url: string) => this.isTwilioURL(url)),
                        twilioCredentialsPresent: !!this.twilioCredentials,
                        defaultParams: this.defaultParams
                    }
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            let targetFolderId = params.targetFolderId
            if (!targetFolderId) {
                if (!params.folderPath && !params.targetFolderName) {
                    throw new Error('Required targetFolderName, targetFolderId or folderPath')
                }

                if (params.folderPath) {
                    targetFolderId = await resolveFolderPath(this.accessToken, params.folderPath)
                } else if (params.targetFolderName) {
                    const folderResult = await findFolderByName(this.accessToken, params.targetFolderName, true)
                    if (folderResult.folders && folderResult.folders.length > 0) {
                        targetFolderId = folderResult.folders.at(0).id
                    }
                }

                if (!targetFolderId) {
                    const folderToCreate = params.targetFolderName || params.folderPath
                    let createdFolderInfo = null

                    if (params.targetFolderName && this.isRootFolder(params.targetFolderName)) {
                        targetFolderId = 'root'
                        createdFolderInfo = {
                            type: 'root',
                            name: 'My Drive (Root)',
                            id: 'root',
                            wasExisting: true
                        }
                    } else if (params.folderPath && this.isRootFolder(params.folderPath)) {
                        targetFolderId = 'root'
                        createdFolderInfo = {
                            type: 'root',
                            path: 'My Drive (Root)',
                            id: 'root',
                            wasExisting: true
                        }
                    } else if (params.folderPath) {
                        targetFolderId = await createFolderPath(this.accessToken, params.folderPath)
                        if (targetFolderId) {
                            createdFolderInfo = {
                                type: 'path',
                                path: params.folderPath,
                                id: targetFolderId,
                                wasExisting: false
                            }
                        }
                    } else if (params.targetFolderName) {
                        targetFolderId = await createFolderIfNotExists(this.accessToken, params.targetFolderName)
                        if (targetFolderId) {
                            createdFolderInfo = {
                                type: 'folder',
                                name: params.targetFolderName,
                                id: targetFolderId,
                                wasExisting: false
                            }
                        }
                    }

                    if (!targetFolderId) {
                        const result = {
                            success: false,
                            targetFolder: folderToCreate,
                            error: 'FOLDER_CREATION_FAILED',
                            message: `Could not create folder: ${folderToCreate}. Please check permissions and try again.`
                        }

                        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                    }

                    // Store folder creation info for later use in the response
                    params._createdFolderInfo = createdFolderInfo
                }
            }

            const successfulUploads: any[] = []
            const failedUploads: any[] = []
            const usedFileNames = new Set<string>()

            for (let i = 0; i < fileUrls.length; i++) {
                const fileUrl = fileUrls[i]
                try {
                    let fileName: string
                    if (fileNames[i]) {
                        const sanitized = sanitizeFilename(fileNames[i].trim())
                        fileName = sanitized || `custom_file_${Date.now()}_${i}`
                    } else {
                        const extractedName = this.extractFileNameFromURL(fileUrl)
                        fileName = extractedName || `downloaded_file_${Date.now()}_${i}`
                    }

                    fileName = this.ensureUniqueFileName(fileName, usedFileNames)
                    usedFileNames.add(fileName)
                    const downloadResult = await this.downloadFromURL(fileUrl, this.twilioCredentials || undefined)
                    if (!downloadResult.success) {
                        failedUploads.push({
                            url: fileUrl,
                            fileName: fileName,
                            error: downloadResult.error,
                            details: downloadResult.details || downloadResult.message,
                            stage: 'download'
                        })

                        continue
                    }

                    const mimeType = this.detectMimeType(downloadResult.buffer, fileName)
                    if (!params.overwriteExisting) {
                        const existingFile = await checkFileExists(this.accessToken, fileName, targetFolderId)
                        if (existingFile) {
                            failedUploads.push({
                                url: fileUrl,
                                fileName: fileName,
                                error: 'FILE_EXISTS',
                                details: `File already exists with ID: ${existingFile.id}`,
                                existingFileId: existingFile.id,
                                stage: 'upload'
                            })

                            continue
                        }
                    }

                    const uploadResult = await this.uploadToGoogleDrive({
                        fileName,
                        fileContent: downloadResult.buffer,
                        mimeType,
                        parentFolderId: targetFolderId
                    })

                    successfulUploads.push({
                        url: fileUrl,
                        fileId: uploadResult.id,
                        fileName: fileName,
                        fileSize: downloadResult.size,
                        mimeType: mimeType,
                        webViewLink: uploadResult.webViewLink,
                        downloadUrl: `https://drive.google.com/uc?id=${uploadResult.id}&export=download`
                    })
                } catch (error) {
                    const fileName = fileNames[i] || this.extractFileNameFromURL(fileUrl) || `file_${i}`
                    failedUploads.push({
                        url: fileUrl,
                        fileName: fileName,
                        error: error instanceof Error ? error.message : String(error),
                        errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
                        stage: 'processing'
                    })
                }
            }

            let folderInfo = {
                id: targetFolderId,
                name: params.targetFolderName || 'Unknown',
                path: params.folderPath || 'Unknown',
                webViewLink: `https://drive.google.com/drive/folders/${targetFolderId}`,
                wasCreated: false,
                type: 'folder'
            }

            if (params._createdFolderInfo) {
                const creationInfo = params._createdFolderInfo
                folderInfo = {
                    id: creationInfo.id,
                    name: creationInfo.name || creationInfo.path || params.targetFolderName || 'Unknown',
                    path: creationInfo.path || creationInfo.name || params.folderPath || 'Unknown',
                    webViewLink: `https://drive.google.com/drive/folders/${creationInfo.id}`,
                    wasCreated: !creationInfo.wasExisting,
                    type: creationInfo.type
                }
            }

            const result = {
                success: successfulUploads.length > 0,
                totalFiles: fileUrls.length,
                successfulUploads: successfulUploads.length,
                failedUploads: failedUploads.length,
                targetFolder: folderInfo,
                targetFolderId: targetFolderId, // Keep for backward compatibility
                uploads: successfulUploads,
                failures: failedUploads,
                summary: `Successfully uploaded ${successfulUploads.length} of ${fileUrls.length} files to Google Drive folder "${folderInfo.name}" (ID: ${folderInfo.id})`,
                processingInfo: {
                    totalProcessed: fileUrls.length,
                    successRate: Math.round((successfulUploads.length / fileUrls.length) * 100),
                    totalSizeUploaded: successfulUploads.reduce((sum, upload) => sum + (upload.fileSize || 0), 0),
                    averageFileSize:
                        successfulUploads.length > 0
                            ? Math.round(
                                  successfulUploads.reduce((sum, upload) => sum + (upload.fileSize || 0), 0) / successfulUploads.length
                              )
                            : 0,
                    folderLocation: {
                        id: folderInfo.id,
                        name: folderInfo.name,
                        path: folderInfo.path,
                        webViewLink: folderInfo.webViewLink,
                        wasCreated: folderInfo.wasCreated || false
                    }
                },
                ...(urlValidationResult.invalidUrls.length > 0 || urlValidationResult.duplicateUrls.length > 0
                    ? {
                          urlValidation: {
                              message: urlValidationResult.message,
                              invalidUrls: urlValidationResult.invalidUrls,
                              duplicateUrls: urlValidationResult.duplicateUrls,
                              originalUrlCount: rawUrls.length,
                              validUrlCount: fileUrls.length
                          }
                      }
                    : {})
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            return formatToolError(`Error in URL file uploader: ${error instanceof Error ? error.message : String(error)}`, params)
        }
    }

    private async downloadFromURL(url: string, twilioAuth?: TwilioAuthConfig): Promise<any> {
        try {
            const headers: { [key: string]: string } = {
                'User-Agent': 'Flowise-GoogleDrive-Tool/1.0'
            }

            if (twilioAuth && this.isTwilioURL(url)) {
                const authString = Buffer.from(`${twilioAuth.accountSid}:${twilioAuth.authToken}`).toString('base64')
                headers['Authorization'] = `Basic ${authString}`
            }

            const response = await fetch(url, {
                method: 'GET',
                headers
            })

            if (!response.ok) {
                let errorDetails = `${response.status} ${response.statusText}`
                let errorBody = null

                try {
                    const errorText = await response.text()
                    if (errorText) {
                        errorDetails += ` - ${errorText}`
                        errorBody = errorText
                    }
                } catch (e) {
                    // Ignore error reading response body
                }

                const errorResult = {
                    success: false,
                    error: 'DOWNLOAD_FAILED',
                    statusCode: response.status,
                    statusText: response.statusText,
                    details: errorDetails,
                    errorBody: errorBody,
                    url: url,
                    isTwilioURL: this.isTwilioURL(url),
                    headers: Object.fromEntries(response.headers.entries())
                }

                return errorResult
            }

            const buffer = await response.buffer()
            const contentLength = response.headers.get('content-length')
            const contentType = response.headers.get('content-type')
            return {
                success: true,
                buffer: buffer,
                size: contentLength ? parseInt(contentLength) : buffer.length,
                contentType: contentType
            }
        } catch (error) {
            return {
                success: false,
                error: 'DOWNLOAD_ERROR',
                details: error instanceof Error ? error.message : String(error),
                url: url,
                isTwilioURL: this.isTwilioURL(url)
            }
        }
    }

    private async uploadToGoogleDrive(uploadParams: {
        fileName: string
        fileContent: Buffer
        mimeType: string
        parentFolderId: string
    }): Promise<any> {
        const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
        const boundary = '-------314159265358979323846'
        const metadata = {
            name: uploadParams.fileName,
            parents: [uploadParams.parentFolderId]
        }

        let body = `--${boundary}\r\n`
        body += 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
        body += JSON.stringify(metadata) + '\r\n'
        body += `--${boundary}\r\n`
        body += `Content-Type: ${uploadParams.mimeType}\r\n\r\n`

        const fileContentString = uploadParams.fileContent.toString('binary')
        body += fileContentString + '\r\n'
        body += `--${boundary}--`

        const headers = {
            Authorization: `Bearer ${this.accessToken}`,
            'Content-Type': `multipart/related; boundary="${boundary}"`,
            'Content-Length': Buffer.byteLength(body, 'binary').toString()
        }

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: Buffer.from(body, 'binary')
        })

        if (!response.ok) {
            const errorText = await response.text()
            throw new Error(`Google Drive upload failed: ${response.status} ${response.statusText} - ${errorText}`)
        }

        return await response.json()
    }

    private extractFileNameFromURL(url: string): string | null {
        try {
            const urlObj = new URL(url)
            const pathname = urlObj.pathname
            const fileName = pathname.split('/').pop()
            return fileName && fileName.length > 0 ? fileName : null
        } catch {
            return null
        }
    }

    private detectMimeType(buffer: Buffer, fileName: string): string {
        const mimeType = lookup(fileName)
        if (mimeType) {
            return mimeType
        }

        const extension = fileName.split('.').pop()?.toLowerCase()
        const mimeTypes: { [key: string]: string } = {
            // Images
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            gif: 'image/gif',
            webp: 'image/webp',
            bmp: 'image/bmp',
            svg: 'image/svg+xml',

            // Documents
            pdf: 'application/pdf',
            txt: 'text/plain',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt: 'application/vnd.ms-powerpoint',
            pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',

            // Audio/Video
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            mp4: 'video/mp4',
            avi: 'video/x-msvideo',

            // Archives
            zip: 'application/zip',
            rar: 'application/x-rar-compressed',

            // Web
            html: 'text/html',
            css: 'text/css',
            js: 'application/javascript',
            json: 'application/json'
        }

        return extension && mimeTypes[extension] ? mimeTypes[extension] : 'application/octet-stream'
    }

    private ensureUniqueFileName(fileName: string, usedNames: Set<string>): string {
        if (!usedNames.has(fileName)) {
            return fileName
        }

        const lastDotIndex = fileName.lastIndexOf('.')
        const baseName = lastDotIndex > 0 ? fileName.substring(0, lastDotIndex) : fileName
        const extension = lastDotIndex > 0 ? fileName.substring(lastDotIndex) : ''
        const uniqueId = randomUUID().substring(0, 8) // Use first 8 characters of UUID
        return `${baseName}_${uniqueId}${extension}`
    }

    private validateAndDeduplicateUrls(urls: string[]): {
        success: boolean
        validUrls: string[]
        invalidUrls: string[]
        duplicateUrls: string[]
        message?: string
    } {
        const cleanUrls = urls.filter((url) => url && typeof url === 'string' && url.trim() !== '').map((url) => url.trim())
        const uniqueUrls = [...new Set(cleanUrls)]
        const duplicateUrls = cleanUrls.filter((url, index) => cleanUrls.indexOf(url) !== index)
        const validUrls = uniqueUrls.filter((url) => this.isValidUrl(url))
        const invalidUrls = uniqueUrls.filter((url) => !this.isValidUrl(url))
        const success = validUrls.length > 0
        let message = ''
        if (!success) {
            message = 'No valid URLs found'
        } else if (invalidUrls.length > 0 || duplicateUrls.length > 0) {
            const issues = []
            if (invalidUrls.length > 0) issues.push(`${invalidUrls.length} invalid`)
            if (duplicateUrls.length > 0) issues.push(`${duplicateUrls.length} duplicates`)
            message = `Found ${validUrls.length} valid URLs. Skipped: ${issues.join(', ')}`
        }

        return {
            success,
            validUrls,
            invalidUrls,
            duplicateUrls,
            message
        }
    }

    private isValidUrl(url: string): boolean {
        try {
            const urlObj = new URL(url)
            return ['http:', 'https:'].includes(urlObj.protocol) && urlObj.hostname.length > 0
        } catch {
            return false
        }
    }

    private isTwilioURL(url: string): boolean {
        try {
            const urlObj = new URL(url)
            const hostname = urlObj.hostname.toLowerCase()
            const pathname = urlObj.pathname.toLowerCase()
            const isTwilioDomain = hostname.includes('twilio.com') || hostname.includes('twiml.com')
            const isTwilioAPI = hostname === 'api.twilio.com' || (hostname.includes('twilio.com') && pathname.includes('/accounts/'))

            return isTwilioDomain || isTwilioAPI
        } catch (error) {
            return false
        }
    }
}
