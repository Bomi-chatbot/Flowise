import { convertMultiOptionsToStringArray, getCredentialData, getCredentialParam, refreshOAuth2Token } from '../../../src/utils'
import { createGoogleDriveTools } from './core'
import type { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'

class GoogleDrive_Tools implements INode {
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
        this.label = 'Google Drive'
        this.name = 'googleDriveTool'
        this.version = 1.0
        this.type = 'GoogleDrive'
        this.icon = 'google-drive.svg'
        this.category = 'Tools'
        this.description = 'Perform Google Drive operations such as managing files, folders, sharing, and searching'
        this.baseClasses = ['Tool']
        this.credential = {
            label: 'Google Drive Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['googleDriveOAuth2']
        }
        this.inputs = [
            {
                label: 'Type',
                name: 'driveType',
                type: 'options',
                description: 'Type of Google Drive operation',
                options: [
                    {
                        label: 'File',
                        name: 'file'
                    },
                    {
                        label: 'Folder',
                        name: 'folder'
                    },
                    {
                        label: 'Search',
                        name: 'search'
                    },
                    {
                        label: 'Share',
                        name: 'share'
                    },
                    {
                        label: 'Smart Tools',
                        name: 'smart'
                    }
                ]
            },
            // File Actions
            {
                label: 'File Actions',
                name: 'fileActions',
                type: 'multiOptions',
                description: 'Actions to perform on files',
                options: [
                    {
                        label: 'List Files',
                        name: 'listFiles'
                    },
                    {
                        label: 'Get File',
                        name: 'getFile'
                    },
                    {
                        label: 'Create File',
                        name: 'createFile'
                    },
                    {
                        label: 'Update File',
                        name: 'updateFile'
                    },
                    {
                        label: 'Delete File',
                        name: 'deleteFile'
                    },
                    {
                        label: 'Copy File',
                        name: 'copyFile'
                    },
                    {
                        label: 'Download File',
                        name: 'downloadFile'
                    }
                ],
                show: {
                    driveType: ['file']
                }
            },
            // Folder Actions
            {
                label: 'Folder Actions',
                name: 'folderActions',
                type: 'multiOptions',
                description: 'Actions to perform on folders',
                options: [
                    {
                        label: 'Create Folder',
                        name: 'createFolder'
                    },
                    {
                        label: 'List Folder Contents',
                        name: 'listFolderContents'
                    },
                    {
                        label: 'Delete Folder',
                        name: 'deleteFolder'
                    }
                ],
                show: {
                    driveType: ['folder']
                }
            },
            // Search Actions
            {
                label: 'Search Actions',
                name: 'searchActions',
                type: 'multiOptions',
                description: 'Search operations',
                options: [
                    {
                        label: 'Search Files',
                        name: 'searchFiles'
                    }
                ],
                show: {
                    driveType: ['search']
                }
            },
            // Share Actions
            {
                label: 'Share Actions',
                name: 'shareActions',
                type: 'multiOptions',
                description: 'Sharing operations',
                options: [
                    {
                        label: 'Share File',
                        name: 'shareFile'
                    },
                    {
                        label: 'Get Permissions',
                        name: 'getPermissions'
                    },
                    {
                        label: 'Remove Permission',
                        name: 'removePermission'
                    }
                ],
                show: {
                    driveType: ['share']
                }
            },
            // Smart Tools Actions
            {
                label: 'Smart Actions',
                name: 'smartActions',
                type: 'multiOptions',
                description: 'Intelligent Google Drive operations',
                options: [
                    {
                        label: 'Smart Folder Finder',
                        name: 'smartFolderFinder'
                    },
                    {
                        label: 'Hierarchical Folder Navigator',
                        name: 'hierarchicalFolderNavigator'
                    },
                    {
                        label: 'URL File Uploader',
                        name: 'urlFileUploader'
                    },
                    {
                        label: 'Smart Folder Creator',
                        name: 'smartFolderCreator'
                    },
                    {
                        label: 'Smart File URL Generator',
                        name: 'smartFileUrl'
                    }
                ],
                show: {
                    driveType: ['smart']
                }
            },
            // File Parameters
            {
                label: 'File ID',
                name: 'fileId',
                type: 'string',
                description: 'File ID for file operations',
                show: {
                    fileActions: ['getFile', 'updateFile', 'deleteFile', 'copyFile', 'downloadFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'File ID',
                name: 'fileId',
                type: 'string',
                description: 'File ID for sharing operations',
                show: {
                    shareActions: ['shareFile', 'getPermissions', 'removePermission']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Folder ID',
                name: 'folderId',
                type: 'string',
                description: 'Folder ID for folder operations',
                show: {
                    folderActions: ['listFolderContents', 'deleteFolder']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Permission ID',
                name: 'permissionId',
                type: 'string',
                description: 'Permission ID to remove',
                show: {
                    shareActions: ['removePermission']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'File Name',
                name: 'fileName',
                type: 'string',
                description: 'Name of the file',
                show: {
                    fileActions: ['createFile', 'copyFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Folder Name',
                name: 'fileName',
                type: 'string',
                description: 'Name of the folder',
                show: {
                    folderActions: ['createFolder']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'File Content',
                name: 'fileContent',
                type: 'string',
                description: 'Content of the file (for text files)',
                show: {
                    fileActions: ['createFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'MIME Type',
                name: 'mimeType',
                type: 'string',
                description: 'MIME type of the file (e.g., text/plain, application/pdf)',
                show: {
                    fileActions: ['createFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Parent Folder ID',
                name: 'parentFolderId',
                type: 'string',
                description: 'ID of the parent folder (comma-separated for multiple parents)',
                show: {
                    fileActions: ['createFile', 'copyFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Parent Folder ID',
                name: 'parentFolderId',
                type: 'string',
                description: 'ID of the parent folder for the new folder',
                show: {
                    folderActions: ['createFolder']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'File Description',
                name: 'description',
                type: 'string',
                description: 'File description',
                show: {
                    fileActions: ['createFile', 'updateFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Folder Description',
                name: 'description',
                type: 'string',
                description: 'Folder description',
                show: {
                    folderActions: ['createFolder']
                },
                additionalParams: true,
                optional: true
            },
            // Search Parameters
            {
                label: 'Search Query',
                name: 'searchQuery',
                type: 'string',
                description: 'Search query using Google Drive search syntax',
                show: {
                    searchActions: ['searchFiles']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Max Results',
                name: 'maxResults',
                type: 'number',
                description: 'Maximum number of results to return (1-1000)',
                default: 10,
                show: {
                    fileActions: ['listFiles']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Max Results',
                name: 'maxResults',
                type: 'number',
                description: 'Maximum number of results to return (1-1000)',
                default: 10,
                show: {
                    searchActions: ['searchFiles']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Order By',
                name: 'orderBy',
                type: 'options',
                description: 'Sort order for file results',
                options: [
                    {
                        label: 'Name',
                        name: 'name'
                    },
                    {
                        label: 'Created Time',
                        name: 'createdTime'
                    },
                    {
                        label: 'Modified Time',
                        name: 'modifiedTime'
                    },
                    {
                        label: 'Size',
                        name: 'quotaBytesUsed'
                    },
                    {
                        label: 'Folder',
                        name: 'folder'
                    }
                ],
                show: {
                    fileActions: ['listFiles']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Order By',
                name: 'orderBy',
                type: 'options',
                description: 'Sort order for search results',
                options: [
                    {
                        label: 'Name',
                        name: 'name'
                    },
                    {
                        label: 'Created Time',
                        name: 'createdTime'
                    },
                    {
                        label: 'Modified Time',
                        name: 'modifiedTime'
                    },
                    {
                        label: 'Size',
                        name: 'quotaBytesUsed'
                    },
                    {
                        label: 'Folder',
                        name: 'folder'
                    }
                ],
                show: {
                    searchActions: ['searchFiles']
                },
                additionalParams: true,
                optional: true
            },
            // Share Parameters
            {
                label: 'Share Role',
                name: 'shareRole',
                type: 'options',
                description: 'Permission role for sharing',
                options: [
                    {
                        label: 'Reader',
                        name: 'reader'
                    },
                    {
                        label: 'Writer',
                        name: 'writer'
                    },
                    {
                        label: 'Commenter',
                        name: 'commenter'
                    },
                    {
                        label: 'Owner',
                        name: 'owner'
                    }
                ],
                show: {
                    shareActions: ['shareFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Share Type',
                name: 'shareType',
                type: 'options',
                description: 'Type of permission',
                options: [
                    {
                        label: 'User',
                        name: 'user'
                    },
                    {
                        label: 'Group',
                        name: 'group'
                    },
                    {
                        label: 'Domain',
                        name: 'domain'
                    },
                    {
                        label: 'Anyone',
                        name: 'anyone'
                    }
                ],
                show: {
                    shareActions: ['shareFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Email Address',
                name: 'emailAddress',
                type: 'string',
                description: 'Email address for user/group sharing',
                show: {
                    shareActions: ['shareFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Domain Name',
                name: 'domainName',
                type: 'string',
                description: 'Domain name for domain sharing',
                show: {
                    shareActions: ['shareFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Send Notification Email',
                name: 'sendNotificationEmail',
                type: 'boolean',
                description: 'Whether to send notification emails when sharing',
                default: true,
                show: {
                    shareActions: ['shareFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Email Message',
                name: 'emailMessage',
                type: 'string',
                description: 'Custom message to include in notification email',
                show: {
                    shareActions: ['shareFile']
                },
                additionalParams: true,
                optional: true
            },
            // Advanced Parameters for File Actions
            {
                label: 'Include Items From All Drives',
                name: 'includeItemsFromAllDrives',
                type: 'boolean',
                description: 'Include items from all drives (shared drives)',
                show: {
                    fileActions: ['listFiles']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Include Items From All Drives',
                name: 'includeItemsFromAllDrives',
                type: 'boolean',
                description: 'Include items from all drives (shared drives)',
                show: {
                    searchActions: ['searchFiles']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Supports All Drives',
                name: 'supportsAllDrives',
                type: 'boolean',
                description: 'Whether the application supports both My Drives and shared drives',
                show: {
                    fileActions: ['listFiles', 'getFile', 'createFile', 'updateFile', 'deleteFile', 'copyFile', 'downloadFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Supports All Drives',
                name: 'supportsAllDrives',
                type: 'boolean',
                description: 'Whether the application supports both My Drives and shared drives',
                show: {
                    folderActions: ['createFolder', 'listFolderContents', 'deleteFolder']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Supports All Drives',
                name: 'supportsAllDrives',
                type: 'boolean',
                description: 'Whether the application supports both My Drives and shared drives',
                show: {
                    searchActions: ['searchFiles']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Supports All Drives',
                name: 'supportsAllDrives',
                type: 'boolean',
                description: 'Whether the application supports both My Drives and shared drives',
                show: {
                    shareActions: ['shareFile', 'getPermissions', 'removePermission']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Fields',
                name: 'fields',
                type: 'string',
                description: 'Specific fields to include in response (e.g., "files(id,name,mimeType)")',
                show: {
                    fileActions: ['listFiles', 'getFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Acknowledge Abuse',
                name: 'acknowledgeAbuse',
                type: 'boolean',
                description: 'Acknowledge the risk of downloading known malware or abusive files',
                show: {
                    fileActions: ['getFile', 'downloadFile']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Access Token Override',
                name: 'accessToken',
                type: 'string',
                description:
                    'You can override the access token per request using overrideConfig.vars.access_token in the API call. This allows multiple users to use their own Google Drive access tokens.',
                placeholder: 'access token value',
                optional: true,
                additionalParams: true,
                hideCodeExecute: true
            },
            {
                label: 'Folder Name',
                name: 'folderName',
                type: 'string',
                description: 'Name of the folder to search for',
                show: {
                    smartActions: ['smartFolderFinder']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Exact Match',
                name: 'exactMatch',
                type: 'boolean',
                description: 'Whether to perform exact or partial folder name matching',
                default: false,
                show: {
                    smartActions: ['smartFolderFinder']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Navigation Operation',
                name: 'navigationOperation',
                type: 'options',
                description: 'Type of hierarchical navigation operation',
                options: [
                    {
                        label: 'List Root Folders',
                        name: 'listRoot'
                    },
                    {
                        label: 'List Subfolders',
                        name: 'listSubfolders'
                    },
                    {
                        label: 'List Folder Contents',
                        name: 'listContents'
                    },
                    {
                        label: 'Get Folder Structure',
                        name: 'getFolderStructure'
                    }
                ],
                show: {
                    smartActions: ['hierarchicalFolderNavigator']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Include Files',
                name: 'includeFiles',
                type: 'boolean',
                description: 'Include files in folder content listing',
                default: false,
                show: {
                    smartActions: ['hierarchicalFolderNavigator']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'File URL',
                name: 'fileUrl',
                type: 'string',
                description: 'URL of the file to download and upload',
                show: {
                    smartActions: ['urlFileUploader']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Target Folder Name',
                name: 'targetFolderName',
                type: 'string',
                description: 'Name of the target folder for file upload',
                show: {
                    smartActions: ['urlFileUploader']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Folder Path',
                name: 'folderPath',
                type: 'string',
                description: 'Hierarchical folder path (e.g., "Projects/2024/Client1")',
                show: {
                    smartActions: ['urlFileUploader', 'smartFolderCreator']
                },
                additionalParams: true,
                optional: true
            },
            // Smart Folder Creator Parameters
            {
                label: 'Parent Folder Name',
                name: 'parentFolderName',
                type: 'string',
                description: 'Name of the parent folder for folder creation',
                show: {
                    smartActions: ['smartFolderCreator']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Create Parent Path',
                name: 'createParentPath',
                type: 'boolean',
                description: 'Create parent folders if they do not exist',
                default: true,
                show: {
                    smartActions: ['smartFolderCreator']
                },
                additionalParams: true,
                optional: true
            },
            // Smart File URL Parameters
            {
                label: 'File Name or ID',
                name: 'fileNameOrId',
                type: 'string',
                description: 'File name or Google Drive file ID',
                show: {
                    smartActions: ['smartFileUrl']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'URL Type',
                name: 'urlType',
                type: 'options',
                description: 'Type of URL to generate',
                options: [
                    {
                        label: 'View URL',
                        name: 'view'
                    },
                    {
                        label: 'Download URL',
                        name: 'download'
                    },
                    {
                        label: 'Share URL',
                        name: 'share'
                    }
                ],
                default: 'view',
                show: {
                    smartActions: ['smartFileUrl']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Search in Folder',
                name: 'searchInFolder',
                type: 'string',
                description: 'Folder name or ID to search within (optional)',
                show: {
                    smartActions: ['smartFileUrl']
                },
                additionalParams: true,
                optional: true
            },
            {
                label: 'Exact Match',
                name: 'exactMatch',
                type: 'boolean',
                description: 'Whether to perform exact or partial name matching (default: partial)',
                default: false,
                show: {
                    smartActions: ['smartFileUrl']
                },
                additionalParams: true,
                optional: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        let accessToken: string
        const overrideAccessToken = nodeData.inputs?.vars?.access_token || nodeData.inputs?.access_token || nodeData.inputs?.accessToken
        if (overrideAccessToken) {
            accessToken = overrideAccessToken
        } else {
            let credentialData = await getCredentialData(nodeData.credential ?? '', options)
            credentialData = await refreshOAuth2Token(nodeData.credential ?? '', credentialData, options)
            accessToken = getCredentialParam('access_token', credentialData, nodeData)
        }

        if (!accessToken) {
            throw new Error('No access token found in Google Drive credential')
        }

        let twilioCredentials = null
        try {
            const appDataSource = options.appDataSource
            const databaseEntities = options.databaseEntities

            const twilioCredential = await appDataSource.getRepository(databaseEntities['Credential']).findOne({
                where: { credentialName: 'twilioApi' }
            })

            if (twilioCredential) {
                const twilioCredentialData = await getCredentialData(twilioCredential.id, options)
                if (twilioCredentialData) {
                    twilioCredentials = {
                        accountSid: twilioCredentialData.accountSid,
                        authToken: twilioCredentialData.authToken
                    }
                }
            }
        } catch (error) {
            // Twilio credentials are optional, so we don't need to log errors
        }

        const driveType = nodeData.inputs?.driveType as string
        const fileActions = convertMultiOptionsToStringArray(nodeData.inputs?.fileActions)
        const folderActions = convertMultiOptionsToStringArray(nodeData.inputs?.folderActions)
        const searchActions = convertMultiOptionsToStringArray(nodeData.inputs?.searchActions)
        const shareActions = convertMultiOptionsToStringArray(nodeData.inputs?.shareActions)
        const smartActions = convertMultiOptionsToStringArray(nodeData.inputs?.smartActions)

        // Combine all actions based on type
        let actions: string[] = []
        if (driveType === 'file') {
            actions = fileActions
        } else if (driveType === 'folder') {
            actions = folderActions
        } else if (driveType === 'search') {
            actions = searchActions
        } else if (driveType === 'share') {
            actions = shareActions
        } else if (driveType === 'smart') {
            actions = smartActions
        }

        const defaultParams = this.transformNodeInputsToToolArgs(nodeData)

        const tools = createGoogleDriveTools({
            accessToken,
            actions,
            defaultParams,
            twilioCredentials
        })

        return tools
    }

    transformNodeInputsToToolArgs(nodeData: INodeData): Record<string, any> {
        // Collect default parameters from inputs
        const defaultParams: Record<string, any> = {}

        // Acess token
        if (nodeData.inputs?.accessToken) defaultParams.accessToken = nodeData.inputs.accessToken

        // Add parameters based on the inputs provided
        if (nodeData.inputs?.fileId) defaultParams.fileId = nodeData.inputs.fileId
        if (nodeData.inputs?.folderId) defaultParams.folderId = nodeData.inputs.folderId
        if (nodeData.inputs?.permissionId) defaultParams.permissionId = nodeData.inputs.permissionId
        if (nodeData.inputs?.fileName) defaultParams.name = nodeData.inputs.fileName
        if (nodeData.inputs?.fileContent) defaultParams.content = nodeData.inputs.fileContent
        if (nodeData.inputs?.mimeType) defaultParams.mimeType = nodeData.inputs.mimeType
        if (nodeData.inputs?.parentFolderId) defaultParams.parents = nodeData.inputs.parentFolderId
        if (nodeData.inputs?.description) defaultParams.description = nodeData.inputs.description
        if (nodeData.inputs?.searchQuery) defaultParams.query = nodeData.inputs.searchQuery
        if (nodeData.inputs?.maxResults) defaultParams.pageSize = nodeData.inputs.maxResults
        if (nodeData.inputs?.orderBy) defaultParams.orderBy = nodeData.inputs.orderBy
        if (nodeData.inputs?.shareRole) defaultParams.role = nodeData.inputs.shareRole
        if (nodeData.inputs?.shareType) defaultParams.type = nodeData.inputs.shareType
        if (nodeData.inputs?.emailAddress) defaultParams.emailAddress = nodeData.inputs.emailAddress
        if (nodeData.inputs?.domainName) defaultParams.domain = nodeData.inputs.domainName
        if (nodeData.inputs?.sendNotificationEmail !== undefined)
            defaultParams.sendNotificationEmail = nodeData.inputs.sendNotificationEmail
        if (nodeData.inputs?.emailMessage) defaultParams.emailMessage = nodeData.inputs.emailMessage
        if (nodeData.inputs?.includeItemsFromAllDrives !== undefined)
            defaultParams.includeItemsFromAllDrives = nodeData.inputs.includeItemsFromAllDrives
        if (nodeData.inputs?.supportsAllDrives !== undefined) defaultParams.supportsAllDrives = nodeData.inputs.supportsAllDrives
        if (nodeData.inputs?.fields) defaultParams.fields = nodeData.inputs.fields
        if (nodeData.inputs?.acknowledgeAbuse !== undefined) defaultParams.acknowledgeAbuse = nodeData.inputs.acknowledgeAbuse

        // Smart tools parameters
        if (nodeData.inputs?.twilioAccountSid) defaultParams.twilioAccountSid = nodeData.inputs.twilioAccountSid
        if (nodeData.inputs?.twilioAuthToken) defaultParams.twilioAuthToken = nodeData.inputs.twilioAuthToken
        if (nodeData.inputs?.folderName) defaultParams.folderName = nodeData.inputs.folderName
        if (nodeData.inputs?.exactMatch) defaultParams.exactMatch = nodeData.inputs.exactMatch
        if (nodeData.inputs?.navigationOperation) defaultParams.operation = nodeData.inputs.navigationOperation
        if (nodeData.inputs?.includeFiles) defaultParams.includeFiles = nodeData.inputs.includeFiles
        if (nodeData.inputs?.fileUrl) defaultParams.fileUrl = nodeData.inputs.fileUrl
        if (nodeData.inputs?.targetFolderName) defaultParams.targetFolderName = nodeData.inputs.targetFolderName
        if (nodeData.inputs?.folderPath) defaultParams.folderPath = nodeData.inputs.folderPath

        // Smart Folder Creator parameters
        if (nodeData.inputs?.parentFolderName) defaultParams.parentFolderName = nodeData.inputs.parentFolderName
        if (nodeData.inputs?.createParentPath) defaultParams.createParentPath = nodeData.inputs.createParentPath

        // Smart File URL parameters
        if (nodeData.inputs?.fileNameOrId) {
            const value = nodeData.inputs.fileNameOrId
            if (value.match(/^[a-zA-Z0-9_-]{25,}$/)) {
                defaultParams.fileId = value
            } else {
                defaultParams.fileName = value
            }
        }
        if (nodeData.inputs?.urlType) defaultParams.urlType = nodeData.inputs.urlType
        if (nodeData.inputs?.searchInFolder) defaultParams.folderName = nodeData.inputs.searchInFolder
        if (nodeData.inputs?.exactMatch) defaultParams.exactMatch = nodeData.inputs.exactMatch

        if (nodeData.inputs?.twilioAccountSid && nodeData.inputs?.twilioAuthToken) {
            defaultParams.twilioAuth = {
                accountSid: nodeData.inputs.twilioAccountSid,
                authToken: nodeData.inputs.twilioAuthToken
            }
        }

        return defaultParams
    }
}

module.exports = { nodeClass: GoogleDrive_Tools }
