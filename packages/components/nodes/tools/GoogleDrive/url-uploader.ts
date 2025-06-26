import { z } from 'zod'
import fetch from 'node-fetch'
import { TOOL_ARGS_PREFIX } from '../../../src/agents'
import { BaseSmartGoogleDriveTool } from './smart-tools'
import { findFolderByName, resolveFolderPath, checkFileExists, createFolderIfNotExists, createFolderPath } from './google-drive-utils'

const URLFileUploaderSchema = z.object({
    fileUrl: z.string().describe('URL of the file to download'),
    targetFolderName: z.string().describe('Name of the target folder'),
    targetFolderId: z.string().optional().describe('ID of the target folder (alternative to name)'),
    fileName: z.string().optional().describe('Custom name for the file'),
    folderPath: z.string().optional().describe('Hierarchical folder path (e.g., "Projects/2024")'),
    overwriteExisting: z.boolean().optional().default(false).describe('Overwrite file if it already exists'),
    requireConfirmationToCreateFolder: z
        .boolean()
        .optional()
        .default(true)
        .describe('Require user confirmation before creating folders that do not exist'),
    userConfirmedFolderCreation: z
        .boolean()
        .optional()
        .default(false)
        .describe('User has confirmed folder creation (used internally after human input)')
})

interface TwilioAuthConfig {
    accountSid: string
    authToken: string
    baseUrl?: string
    timeout?: number
    retryAttempts?: number
}

export class URLFileUploaderTool extends BaseSmartGoogleDriveTool {
    protected accessToken: string = ''
    defaultParams: any
    private twilioCredentials: TwilioAuthConfig | null = null
    requiresHumanInput?: boolean

    constructor(args: any) {
        const toolInput = {
            name: 'url_file_uploader',
            description:
                'Downloads files from URLs (especially Twilio) and uploads them to Google Drive with intelligent folder search. Can request user confirmation before creating new folders.',
            schema: URLFileUploaderSchema,
            baseUrl: '',
            method: 'POST',
            headers: {}
        }
        super({
            ...toolInput,
            accessToken: args.accessToken
        })
        this.accessToken = args.accessToken ?? ''
        this.defaultParams = args.defaultParams || {}
        this.twilioCredentials = args.twilioCredentials || null
    }

    async _call(arg: any): Promise<string> {
        const params = { ...arg, ...this.defaultParams }

        try {
            const { accountSid, authToken } = this.twilioCredentials || {}

            if (this.isTwilioURL(params.fileUrl) && !(accountSid && authToken)) {
                const result = {
                    success: false,
                    error: 'TWILIO_CREDENTIALS_MISSING',
                    message: 'Twilio credentials are required for Twilio URLs. Please configure Twilio API credentials in Flowise.',
                    debug: {
                        url: params.fileUrl,
                        isTwilioURL: this.isTwilioURL(params.fileUrl),
                        twilioCredentialsPresent: !!this.twilioCredentials,
                        twilioAuthPresent: !!params.twilioAuth,
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

                // If folder is not found, check if we need confirmation
                if (!targetFolderId) {
                    if (params.requireConfirmationToCreateFolder && !params.userConfirmedFolderCreation) {
                        this.requiresHumanInput = true
                        const folderToCreate = params.targetFolderName || params.folderPath
                        const result = {
                            success: false,
                            error: 'FOLDER_NOT_FOUND_REQUIRES_CONFIRMATION',
                            targetFolder: folderToCreate,
                            message: `Folder "${folderToCreate}" not found. Would you like me to create it before uploading the file?`,
                            requiresUserConfirmation: true,
                            confirmationPrompt: `The folder "${folderToCreate}" does not exist. Would you like me to create it before uploading the file?`,
                            nextAction: {
                                tool: 'url_file_uploader',
                                params: {
                                    ...params,
                                    userConfirmedFolderCreation: true
                                }
                            }
                        }

                        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                    }

                    if (params.folderPath) {
                        targetFolderId = await createFolderPath(this.accessToken, params.folderPath)
                    } else if (params.targetFolderName) {
                        targetFolderId = await createFolderIfNotExists(this.accessToken, params.targetFolderName)
                    }

                    if (!targetFolderId) {
                        const result = {
                            success: false,
                            targetFolder: params.targetFolderName || params.folderPath,
                            error: 'FOLDER_NOT_FOUND_AND_CREATION_FAILED',
                            message: `Could not find or create folder: ${params.targetFolderName || params.folderPath}`
                        }

                        return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                    }
                }
            }

            const downloadResult = await this.downloadFromURL(params.fileUrl, this.twilioCredentials || undefined)
            if (!downloadResult.success) {
                return JSON.stringify(downloadResult) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            const fileName = params.fileName || this.extractFileNameFromURL(params.fileUrl) || `downloaded_file_${Date.now()}`
            const mimeType = this.detectMimeType(downloadResult.buffer, fileName)
            if (!params.overwriteExisting) {
                const existingFile = await checkFileExists(this.accessToken, fileName, targetFolderId)
                if (existingFile) {
                    const result = {
                        success: false,
                        existingFileId: existingFile.id,
                        fileName: fileName,
                        error: 'FILE_EXISTS'
                    }
                    return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
                }
            }

            const uploadResult = await this.uploadToGoogleDrive({
                fileName,
                fileContent: downloadResult.buffer,
                mimeType,
                parentFolderId: targetFolderId
            })

            const result = {
                success: true,
                fileId: uploadResult.id,
                fileName: fileName,
                fileSize: downloadResult.size,
                mimeType: mimeType,
                targetFolderId: targetFolderId,
                webViewLink: uploadResult.webViewLink,
                downloadUrl: `https://drive.google.com/uc?id=${uploadResult.id}&export=download`
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            const result = {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
                url: params.fileUrl,
                timestamp: new Date().toISOString()
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
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
        const extension = fileName.split('.').pop()?.toLowerCase()
        if (buffer.length >= 4) {
            const signature = buffer.toString('hex', 0, 4)

            switch (signature) {
                case '89504e47':
                    return 'image/png'
                case 'ffd8ffe0':
                case 'ffd8ffe1':
                case 'ffd8ffe2':
                    return 'image/jpeg'
                case '47494638':
                    return 'image/gif'
                case '25504446':
                    return 'application/pdf'
                case '504b0304':
                    return 'application/zip'
            }
        }

        const mimeTypes: { [key: string]: string } = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            gif: 'image/gif',
            pdf: 'application/pdf',
            txt: 'text/plain',
            doc: 'application/msword',
            docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel',
            xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            mp3: 'audio/mpeg',
            mp4: 'video/mp4',
            wav: 'audio/wav',
            zip: 'application/zip'
        }

        return extension && mimeTypes[extension] ? mimeTypes[extension] : 'application/octet-stream'
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
