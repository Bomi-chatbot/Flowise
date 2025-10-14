import sanitizeFilename from 'sanitize-filename'
import { lookup } from 'mime-types'

export function isTwilioURL(url: string): boolean {
    try {
        const u = new URL(url)
        const hostname = u.hostname.toLowerCase()
        const pathname = u.pathname.toLowerCase()
        const isTwilioDomain = hostname.includes('twilio.com') || hostname.includes('twiml.com')
        const isTwilioAPI = hostname === 'api.twilio.com' || (hostname.includes('twilio.com') && pathname.includes('/accounts/'))
        return isTwilioDomain || isTwilioAPI
    } catch {
        return false
    }
}

export function buildBasicAuthHeader(accountSid?: string, authToken?: string): string | undefined {
    if (!accountSid || !authToken) return undefined
    const authString = Buffer.from(`${accountSid}:${authToken}`).toString('base64')
    return `Basic ${authString}`
}

export function extractFileNameFromURL(url: string): string | null {
    try {
        const urlObj = new URL(url)
        const pathname = urlObj.pathname
        const fileName = pathname.split('/').pop()
        return fileName && fileName.length > 0 ? fileName : null
    } catch {
        return null
    }
}

export function ensureUniqueFileName(fileName: string, usedNames: Set<string>): string {
    const sanitized = sanitizeFilename(fileName) || 'file'
    if (!usedNames.has(sanitized)) return sanitized

    const lastDotIndex = sanitized.lastIndexOf('.')
    const baseName = lastDotIndex > 0 ? sanitized.substring(0, lastDotIndex) : sanitized
    const extension = lastDotIndex > 0 ? sanitized.substring(lastDotIndex) : ''
    let i = 1
    let candidate = `${baseName}_${i}${extension}`
    while (usedNames.has(candidate)) {
        i += 1
        candidate = `${baseName}_${i}${extension}`
    }
    return candidate
}

export function detectMimeType(fileName: string, contentTypeHeader?: string | null): string {
    if (contentTypeHeader) {
        return contentTypeHeader
    }

    const mime = lookup(fileName)
    return mime || 'application/octet-stream'
}

export function mimeToExtension(mime: string): string | null {
    const map: Record<string, string> = {
        // Images
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/bmp': 'bmp',
        'image/svg+xml': 'svg',
        // Audio/Video
        'audio/mpeg': 'mp3',
        'audio/wav': 'wav',
        'video/mp4': 'mp4',
        // Docs
        'application/pdf': 'pdf',
        'text/plain': 'txt',
        'application/json': 'json'
    }
    return map[mime] || null
}
