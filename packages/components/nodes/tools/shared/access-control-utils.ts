import fetch from 'node-fetch'

interface FileMetadataCheck {
    exists: boolean
    accessible: boolean
    error?: string
}

/**
 * Response from magic link generation API
 */
export interface MagicLinkResponse {
    success: boolean
    mToken: string
}

/**
 * Standardized access control response format
 */
export interface AccessControlResponse {
    message: string
    fileId: string
    userId: string
    mToken: string
    canAccess: boolean
    reason: string
}

/**
 * Configuration for access control
 */
export interface AccessControlConfig {
    magicLinkApiUrl: string
    frontendUrl: string
    enableAccessControl: boolean
}

/**
 * Parameters for access control check
 */
export interface AccessControlParams {
    error: Error
    originalParams: any
    sessionId?: string
    userId?: string
}

/**
 * Specific Google API reasons indicating scope/permission issues
 * These are the only ones that can be resolved with magic links
 */
const GOOGLE_PERMISSION_ERROR_REASONS = [
    'insufficientFilePermissions', // ✅ Archivo existe pero sin permisos
    'insufficientPermissions', // ✅ Permisos insuficientes en general
    'forbidden', // ✅ Acceso prohibido por permisos
    'accessDenied' // ✅ Acceso denegado específicamente
]

/**
 * Ultra-specific patterns only for real scope/permission errors
 * Removed ambiguous patterns that cause false positives
 */
const PRECISE_PERMISSION_PATTERNS = [
    /insufficient.*permissions.*for.*file/i, // ✅ Específico para archivos
    /the caller does not have permission/i, // ✅ Error específico de Google API
    /request had insufficient authentication scopes/i, // ✅ Error de scope específico
    /access.*denied.*insufficient.*permissions/i // ✅ Combinación específica
]

/**
 * Default configuration
 */
const getEnvironmentConfig = (): AccessControlConfig => {
    return {
        magicLinkApiUrl: process.env.MIBO_API_URL || 'http://localhost:9001/api',
        frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5371',
        enableAccessControl: process.env.ACCESS_CONTROL_ENABLED !== 'false'
    }
}

const DEFAULT_CONFIG: AccessControlConfig = getEnvironmentConfig()

/**
 * Ultra-precise detection of permission errors
 * Only returns true for errors that can actually be resolved with magic links
 */
export function isPermissionError(error: Error, statusCode?: number, errorResponse?: any): boolean {
    if (statusCode !== 403) {
        return false
    }

    if (!errorResponse?.error) {
        return false
    }

    const googleError = errorResponse.error
    if (googleError.errors && Array.isArray(googleError.errors)) {
        const hasPermissionReason = googleError.errors.some((err: any) => GOOGLE_PERMISSION_ERROR_REASONS.includes(err.reason))

        if (hasPermissionReason) {
            return true
        }
    }

    const errorMessage = error.message.toLowerCase()
    const hasSpecificPattern = PRECISE_PERMISSION_PATTERNS.some((pattern) => pattern.test(errorMessage))
    const mentionsScope = errorMessage.includes('scope') || errorMessage.includes('permission')
    const mentionsFile = errorMessage.includes('file') || errorMessage.includes('spreadsheet')
    return hasSpecificPattern && mentionsScope && mentionsFile
}

/**
 * Extract file ID from error context
 */
export function extractFileIdFromError(error: Error, originalParams: any): string | null {
    if (originalParams?.fileId) {
        return originalParams.fileId
    }

    if (originalParams?.spreadsheetId) {
        return originalParams.spreadsheetId
    }

    if (originalParams?.folderId) {
        return originalParams.folderId
    }

    const errorMessage = error.message
    const driveFileMatch = errorMessage.match(/files\/([a-zA-Z0-9_-]{25,})/i)
    if (driveFileMatch) {
        return driveFileMatch[1]
    }

    const sheetsMatch = errorMessage.match(/spreadsheets\/([a-zA-Z0-9_-]{44})/i)
    if (sheetsMatch) {
        return sheetsMatch[1]
    }

    return null
}

/**
 * Extract and clean user ID from session context
 */
export function extractUserId(context: any): string | null {
    if (!context?.sessionId) {
        return null
    }

    return cleanPhoneNumber(String(context.sessionId))
}

/**
 * Clean phone number by removing + prefix
 */
export function cleanPhoneNumber(phone: string): string {
    return phone.startsWith('+') ? phone.substring(1) : phone
}

/**
 * Check if a file exists using Google Drive metadata API
 * This uses drive.metadata.readonly scope to verify file existence
 */
export async function checkFileExistsWithMetadata(fileId: string, accessToken: string): Promise<FileMetadataCheck> {
    try {
        const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json'
            }
        })

        if (response.ok) {
            return {
                exists: true,
                accessible: true
            }
        }

        if (response.status === 404) {
            return {
                exists: false,
                accessible: false,
                error: 'File not found'
            }
        }

        if (response.status === 403) {
            return {
                exists: true,
                accessible: false,
                error: 'Permission denied'
            }
        }

        return {
            exists: false,
            accessible: false,
            error: `HTTP ${response.status}: ${response.statusText}`
        }
    } catch (error) {
        return {
            exists: false,
            accessible: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        }
    }
}

/**
 * Generate magic link for file access
 */
export async function generateMagicLink(
    userId: string,
    fileId: string,
    config: AccessControlConfig = DEFAULT_CONFIG
): Promise<MagicLinkResponse> {
    try {
        const apiKey = process.env.MAGIC_LINK_API_KEY
        if (!apiKey) {
            throw new Error('Magic link API key is not configured')
        }

        console.info('Generating magic link for user')
        const response = await fetch(`${config.magicLinkApiUrl}/auth/magic-link`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-internal-api-key': process.env.MAGIC_LINK_API_KEY || ''
            },
            body: JSON.stringify({
                userId,
                fileId
            })
        })

        if (!response.ok) {
            throw new Error(`Magic link API error: ${response.status} ${response.statusText}`)
        }

        const data = (await response.json()) as MagicLinkResponse
        return data
    } catch (error) {
        console.error('Failed to generate magic link:', error)
        // Return fallback response
        return {
            success: false,
            mToken: 'error'
        }
    }
}

export function formatAccessResponse(fileId: string, mToken: string, config: AccessControlConfig = DEFAULT_CONFIG): object {
    return {
        fileId,
        mToken,
        accessUrl: `${config.frontendUrl}/preferences?fileId=${encodeURIComponent(fileId)}&mToken=${encodeURIComponent(mToken)}`,
        action: 'authorize_access',
        type: 'permission_required'
    }
}

/**
 * Main access control handler
 */
export async function handleAccessControlResponse(
    params: AccessControlParams,
    config: AccessControlConfig = DEFAULT_CONFIG,
    context?: any
): Promise<string> {
    if (!config.enableAccessControl) {
        return JSON.stringify({
            message: `Error accessing the file: ${params.error.message}`,
            canAccess: false,
            reason: 'access_control_disabled'
        })
    }

    // Extract file ID
    const fileId = extractFileIdFromError(params.error, params.originalParams)
    if (!fileId) {
        return JSON.stringify({
            message: `Could not identify the file in the request. Error: ${params.error.message}`,
            canAccess: false,
            reason: 'file_id_not_found'
        })
    }

    // Extract user ID
    const userId = params.userId || extractUserId(context)
    if (!userId) {
        return JSON.stringify({
            message: `Could not identify the user to generate the access link. File: ${fileId}`,
            fileId,
            canAccess: false,
            reason: 'user_id_not_found'
        })
    }

    const magicLinkResponse = await generateMagicLink(userId, fileId, config)
    if (!magicLinkResponse.success) {
        return JSON.stringify({
            message: `Failed to generate the access link for the file. Please contact support.`,
            fileId,
            userId,
            canAccess: false,
            reason: 'magic_link_generation_failed'
        })
    }

    const accessData = formatAccessResponse(fileId, magicLinkResponse.mToken)
    return JSON.stringify({
        ...accessData,
        userId,
        canAccess: false,
        reason: 'permissions_required'
    })
}

export async function handleGoogleAPIResponse(
    error: Error,
    statusCode: number,
    originalParams: any,
    context?: any,
    errorResponse?: any,
    config: AccessControlConfig = DEFAULT_CONFIG
): Promise<string> {
    if (isPermissionError(error, statusCode, errorResponse)) {
        return await handleAccessControlResponse(
            {
                error,
                originalParams,
                userId: extractUserId(context) || undefined
            },
            config,
            context
        )
    }

    if (statusCode === 404) {
        const fileId = extractFileIdFromError(error, originalParams)
        if (fileId && context?.accessToken) {
            const metadataCheck = await checkFileExistsWithMetadata(fileId, context.accessToken)
            if (!metadataCheck.exists) {
                return JSON.stringify({
                    message: `The requested file does not exist or could not be found.`,
                    canAccess: false,
                    reason: 'file_not_found',
                    statusCode,
                    fileId,
                    suggestion: 'Verify that the file ID is correct and the file has not been deleted.',
                    troubleshooting: {
                        likelyCause: 'The file ID provided does not correspond to an existing file',
                        solutions: [
                            'Double-check the file ID for typos',
                            'Ensure the file has not been deleted or moved',
                            'Confirm that the file is shared with the application, if applicable'
                        ]
                    }
                })
            }

            return await handleAccessControlResponse(
                {
                    error,
                    originalParams,
                    userId: extractUserId(context) || undefined
                },
                config,
                context
            )
        }

        return JSON.stringify({
            message: `Cannot access the requested file. This could be because the file doesn't exist, was deleted, or was not created by this application.`,
            canAccess: false,
            reason: 'not_found_or_insufficient_scope',
            statusCode,
            fileId,
            scopeIssue: true,
            explanation:
                'With current OAuth scopes (drive.file), only files created by this application are accessible. Files created outside this app require broader permissions.',
            suggestion: 'If the file exists but was created outside this application, you need to grant broader Google Drive permissions.',
            troubleshooting: {
                likelyCause: 'File exists but current OAuth scope (drive.file) only allows access to files created by this application',
                solutions: [
                    'Create a new file using this application instead',
                    'Share the existing file with this application',
                    'Request broader Google Drive permissions from the user'
                ]
            }
        })
    }

    if (statusCode === 400) {
        return JSON.stringify({
            message: `Error in the request: ${error.message}`,
            canAccess: false,
            reason: 'bad_request',
            statusCode,
            suggestion: 'Check the request parameters (range, format, etc.).'
        })
    }

    if (statusCode === 429) {
        return JSON.stringify({
            message: `Rate limit exceeded. Please try again in a few minutes.`,
            canAccess: false,
            reason: 'rate_limit',
            statusCode,
            suggestion: 'Wait a few minutes before trying again.'
        })
    }

    return JSON.stringify({
        message: `Error in the Google API operation: ${error.message}`,
        canAccess: false,
        reason: 'api_error',
        statusCode,
        originalError: error.message,
        suggestion: 'Check the application configuration and permissions.'
    })
}

/**
 * Function to intercept errors at the factory level
 * This is key to maintaining the existing architecture
 */
export async function interceptGoogleAPIError(
    errorString: string,
    originalParams: any,
    context: any,
    config: AccessControlConfig = DEFAULT_CONFIG
): Promise<string> {
    if (!errorString.includes('Error') && !errorString.includes('API Error')) {
        return errorString
    }

    const statusCodeMatch = errorString.match(/(\d{3}):/)
    const statusCode = statusCodeMatch ? parseInt(statusCodeMatch[1]) : null
    if (!statusCode) {
        return errorString
    }

    const error = new Error(errorString)
    let errorResponse = null
    try {
        const jsonMatch = errorString.match(/\{.*\}/)
        if (jsonMatch) {
            errorResponse = JSON.parse(jsonMatch[0])
        }
    } catch (parseError) {
        // No es JSON válido, continuar sin errorResponse
    }

    return await handleGoogleAPIResponse(error, statusCode, originalParams, context, errorResponse, config)
}
