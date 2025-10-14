import { convertMultiOptionsToStringArray, getCredentialData, getCredentialParam } from '../../../src/utils'
import type { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { createTwilioMediaTools } from './core'

class TwilioMedia_Tools implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Twilio Media'
        this.name = 'twilioMediaTool'
        this.version = 1.0
        this.type = 'TwilioMedia'
        this.icon = 'twilio.svg'
        this.category = 'Tools'
        this.description =
            'Download Twilio media and return base64 data URLs (data: URI) for Gemini 2.5 multimodal consumption. No server storage.'
        this.baseClasses = ['Tool']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['twilioApi']
        }
        this.inputs = [
            {
                label: 'Actions',
                name: 'mediaActions',
                type: 'multiOptions',
                description: 'Twilio media operations',
                options: [
                    {
                        label: 'Download by URL',
                        name: 'downloadByUrl'
                    }
                ]
            },
            {
                label: 'Media URL(s)',
                name: 'mediaUrl',
                type: 'string',
                description:
                    'Twilio media URL or comma-separated list of URLs (e.g., https://api.twilio.com/2010-04-01/Accounts/AC.../Messages/MM.../Media/ME... )',
                show: {
                    mediaActions: ['downloadByUrl']
                },
                additionalParams: true,
                optional: true,
                acceptVariable: true
            },
            {
                label: 'File Name(s)',
                name: 'fileName',
                type: 'string',
                description: 'Optional custom file name or comma-separated list matching the number of URLs',
                show: {
                    mediaActions: ['downloadByUrl']
                },
                additionalParams: true,
                optional: true,
                acceptVariable: true
            },
            {
                label: 'Return Data URL',
                name: 'returnDataUrl',
                type: 'boolean',
                description: 'Return base64 data URLs along with metadata (useful for immediate inline use)',
                default: true,
                show: {
                    mediaActions: ['downloadByUrl']
                },
                additionalParams: true,
                optional: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        // Resolve Twilio credentials
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const accountSid = getCredentialParam('accountSid', credentialData, nodeData)
        const authToken = getCredentialParam('authToken', credentialData, nodeData)

        // Transform inputs to default params for tools
        const defaultParams = this.transformNodeInputsToToolArgs(nodeData)

        const tools = createTwilioMediaTools({
            defaultParams,
            twilioCredentials: accountSid && authToken ? { accountSid, authToken } : undefined
        })

        return tools
    }

    transformNodeInputsToToolArgs(nodeData: INodeData): Record<string, any> {
        const defaultParams: Record<string, any> = {}

        if (nodeData.inputs?.mediaActions) defaultParams.actions = convertMultiOptionsToStringArray(nodeData.inputs.mediaActions)

        if (nodeData.inputs?.mediaUrl) {
            // support comma separated list
            const raw = nodeData.inputs.mediaUrl as string
            if (typeof raw === 'string' && raw.includes(',')) {
                defaultParams.mediaUrl = raw
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => !!s)
            } else {
                defaultParams.mediaUrl = raw
            }
        }

        if (nodeData.inputs?.fileName) {
            const raw = nodeData.inputs.fileName as string
            if (typeof raw === 'string' && raw.includes(',')) {
                defaultParams.fileName = raw
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => !!s)
            } else {
                defaultParams.fileName = raw
            }
        }

        if (nodeData.inputs?.returnDataUrl !== undefined) defaultParams.returnDataUrl = nodeData.inputs.returnDataUrl

        return defaultParams
    }
}

module.exports = { nodeClass: TwilioMedia_Tools }
