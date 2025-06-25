import { INodeParams, INodeCredential } from '../src/Interface'

class TwilioApiCredential implements INodeCredential {
    label: string
    name: string
    version: number
    inputs: INodeParams[]

    constructor() {
        this.label = 'Twilio API'
        this.name = 'twilioApi'
        this.version = 1.0
        this.inputs = [
            {
                label: 'Account SID',
                name: 'accountSid',
                type: 'string',
                description: 'Your Twilio Account SID'
            },
            {
                label: 'Auth Token',
                name: 'authToken',
                type: 'password',
                description: 'Your Twilio Auth Token'
            }
        ]
    }
}

module.exports = { credClass: TwilioApiCredential }
