import { z } from 'zod'
import fetch from 'node-fetch'
import {
    isTwilioURL,
    extractFileNameFromURL,
    ensureUniqueFileName,
    detectMimeType,
    mimeToExtension,
    buildBasicAuthHeader
} from './twilio-utils'
import { DynamicStructuredTool } from '../OpenAPIToolkit/core'
import { TOOL_ARGS_PREFIX, formatToolError } from '../../../src/agents'

export const desc = `Use this when you want to download protected Twilio media URLs and persist them to Flowise storage so the files can be reused by other tools without Twilio auth.`

export interface TwilioCredentials {
    accountSid: string
    authToken: string
}

export interface RequestParameters {
    defaultParams?: any
    twilioCredentials?: TwilioCredentials
}

const TwilioDownloadByUrlSchema = z.object({
    mediaUrl: z
        .union([
            z.string().describe('Twilio media URL to download'),
            z.array(z.string()).describe('Array of Twilio media URLs to download')
        ])
        .describe('URL(s) of the media to download'),
    fileName: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe('Custom name(s) for the downloaded file(s)'),
    returnDataUrl: z.boolean().optional().default(true).describe('Return base64 data URLs in the response')
})

class TwilioBaseTool extends DynamicStructuredTool {
    protected twilioCredentials?: TwilioCredentials
    protected defaultParams: any

    constructor(args: any) {
        super(args)
        this.twilioCredentials = args.twilioCredentials
        this.defaultParams = args.defaultParams || {}
    }

    protected isTwilioURL(url: string): boolean {
        try {
            const u = new URL(url)
            const host = u.hostname.toLowerCase()
            return host.includes('twilio.com') || host.includes('twimg.com') || host.includes('twiml.com')
        } catch {
            return false
        }
    }

    protected extractFileNameFromURL(url: string): string | null {
        try {
            const urlObj = new URL(url)
            const pathname = urlObj.pathname
            const fileName = pathname.split('/').pop() || ''
            return fileName.length > 0 ? fileName : null
        } catch {
            return null
        }
    }

    protected ensureUniqueFileName(fileName: string, used: Set<string>): string {
        if (!used.has(fileName)) return fileName
        const dot = fileName.lastIndexOf('.')
        const base = dot > 0 ? fileName.slice(0, dot) : fileName
        const ext = dot > 0 ? fileName.slice(dot) : ''
        let i = 1
        let candidate = `${base}_${i}${ext}`
        while (used.has(candidate)) {
            i += 1
            candidate = `${base}_${i}${ext}`
        }
        return candidate
    }

    protected buildAuthHeader(): string | undefined {
        if (!this.twilioCredentials?.accountSid || !this.twilioCredentials?.authToken) return undefined
        const authString = Buffer.from(`${this.twilioCredentials.accountSid}:${this.twilioCredentials.authToken}`).toString('base64')
        return `Basic ${authString}`
    }
}

export class TwilioDownloadByUrlTool extends TwilioBaseTool {
    constructor(args: RequestParameters) {
        const toolInput = {
            name: 'twilio_download_media',
            description: desc,
            schema: TwilioDownloadByUrlSchema,
            baseUrl: '',
            method: 'GET',
            headers: {}
        }
        super({ ...toolInput, ...args })
    }

    async _call(arg: any): Promise<string> {
        const params = { ...this.defaultParams, ...arg }

        try {
            const rawUrls = Array.isArray(params.mediaUrl) ? params.mediaUrl : [params.mediaUrl]
            const urls = rawUrls.filter((u: string) => typeof u === 'string' && u.trim()).map((u: string) => u.trim())

            if (urls.length === 0) {
                const result = { success: false, error: 'NO_URLS', message: 'No mediaUrl provided' }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            // If any URL is Twilio-protected, ensure credentials are present
            const needsAuth = urls.some((u: string) => isTwilioURL(u))
            if (needsAuth && (!this.twilioCredentials?.accountSid || !this.twilioCredentials?.authToken)) {
                const result = {
                    success: false,
                    error: 'TWILIO_CREDENTIALS_MISSING',
                    message: 'Twilio credentials are required to download protected media URLs.'
                }
                return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
            }

            const providedNames: string[] = []
            if (params.fileName) {
                if (Array.isArray(params.fileName)) providedNames.push(...params.fileName)
                else providedNames.push(params.fileName)
            }
            while (providedNames.length < urls.length) providedNames.push('')

            const usedNames = new Set<string>()
            const files: any[] = []
            const failures: any[] = []

            for (let i = 0; i < urls.length; i++) {
                const url = urls[i]
                try {
                    const headers: Record<string, string> = { 'User-Agent': 'Flowise-Twilio-Tool/1.0' }
                    const auth = buildBasicAuthHeader(this.twilioCredentials?.accountSid, this.twilioCredentials?.authToken)
                    if (auth && isTwilioURL(url)) {
                        headers['Authorization'] = auth
                    }

                    const res = await fetch(url, { method: 'GET', headers })
                    if (!res.ok) {
                        const text = await res.text().catch(() => '')
                        failures.push({
                            url,
                            status: res.status,
                            statusText: res.statusText,
                            body: text?.slice(0, 500)
                        })
                        continue
                    }

                    const buffer = await res.buffer()
                    const contentType = res.headers.get('content-type')
                    const size = buffer.length

                    // Determine filename
                    let fileName = providedNames[i]?.trim()
                    if (!fileName) {
                        fileName = extractFileNameFromURL(url) || `twilio_media_${i}`
                        // If no extension and we know contentType, append an extension based on mime if available
                        if (!fileName.includes('.') && contentType) {
                            const extFromMime = mimeToExtension(contentType)
                            if (extFromMime) fileName = `${fileName}.${extFromMime}`
                        }
                    }
                    fileName = ensureUniqueFileName(fileName || `twilio_media_${i}`, usedNames)
                    usedNames.add(fileName)

                    const mimeType = detectMimeType(fileName, contentType)

                    // Persist to storage if requested
                    let dataUrl: string | undefined
                    if (params.returnDataUrl) {
                        const b64 = buffer.toString('base64')
                        dataUrl = `data:${mimeType};base64,${b64}`
                    }

                    files.push({
                        url,
                        name: fileName,
                        mime: mimeType,
                        size,
                        ...(dataUrl ? { dataUrl } : {})
                    })
                } catch (err: any) {
                    failures.push({
                        url,
                        error: err?.message || String(err)
                    })
                }
            }

            const result = {
                success: files.length > 0,
                totalRequested: urls.length,
                downloaded: files.length,
                failed: failures.length,
                files,
                failures
            }

            return JSON.stringify(result) + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            return formatToolError(`Error in Twilio media downloader: ${error instanceof Error ? error.message : String(error)}`, params)
        }
    }
}

export const createTwilioMediaTools = (args?: RequestParameters): DynamicStructuredTool[] => {
    const tools: DynamicStructuredTool[] = []
    const actions = args?.defaultParams?.actions || args?.defaultParams?.mediaActions || []
    const toolArgs = {
        defaultParams: args?.defaultParams || {},
        twilioCredentials: args?.twilioCredentials
    }

    if (actions.includes('downloadByUrl')) {
        tools.push(new TwilioDownloadByUrlTool(toolArgs))
    }

    return tools
}
