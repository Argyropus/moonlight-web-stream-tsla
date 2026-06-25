import { Api } from "../api.js"
import { StreamClientMessage, StreamServerMessage } from "../api_bindings.js"
import { defaultStreamInputConfig, StreamInput, StreamInputConfig } from "./input.js"

export type InputStreamInfoEvent = CustomEvent<
    { type: "stageStarting" | "stageComplete", stage: string } |
    { type: "stageFailed", stage: string, errorCode: number } |
    { type: "connected" } |
    { type: "streamNotActive" } |
    { type: "hostNotFound" } |
    { type: "error", message: string } |
    { type: "addDebugLine", line: string }
>
export type InputStreamInfoEventListener = (event: InputStreamInfoEvent) => void

/**
 * Attaches keyboard/mouse/touch/controller input to an already-running stream
 * on `hostId` (started elsewhere, e.g. by the Tesla showing audio/video) —
 * no video/audio is requested or decoded by this client at all.
 */
export class InputOnlyStream {
    private api: Api
    private hostId: number

    private eventTarget = new EventTarget()

    private ws!: WebSocket
    private peer: RTCPeerConnection | null = null
    private input: StreamInput

    constructor(api: Api, hostId: number, inputConfig?: StreamInputConfig) {
        this.api = api
        this.hostId = hostId

        this.input = new StreamInput(inputConfig ?? defaultStreamInputConfig())

        this.beforeUnloadHandler = () => { this.ws?.close() }
        window.addEventListener("beforeunload", this.beforeUnloadHandler)

        this.connectWebSocket()
    }

    private beforeUnloadHandler: (() => void) | null = null

    // -- Raw WebSocket
    private wsSendBuffer: Array<string> = []
    private wsConnectTimeout: ReturnType<typeof setTimeout> | null = null
    private wsAttempt: number = 0
    private readonly WS_MAX_ATTEMPTS = 10
    private readonly WS_CONNECT_TIMEOUT_MS = 5000

    private connectWebSocket() {
        this.wsAttempt++
        const attempt = this.wsAttempt

        const wsUrl = `${this.api.host_url}/host/stream?_t=${Date.now()}`
        this.ws = new WebSocket(wsUrl)
        this.ws.addEventListener("error", this.onError.bind(this))
        this.ws.addEventListener("open", this.onWsOpen.bind(this))
        this.ws.addEventListener("close", this.onWsClose.bind(this))
        this.ws.addEventListener("message", this.onRawWsMessage.bind(this))

        this.wsSendBuffer = []
        this.sendWsMessage({
            AuthenticateAndAttachInput: {
                credentials: this.api.credentials,
                host_id: this.hostId,
            }
        })

        this.wsConnectTimeout = setTimeout(() => {
            this.wsConnectTimeout = null
            this.ws.close()

            if (this.wsAttempt < this.WS_MAX_ATTEMPTS) {
                setTimeout(() => this.connectWebSocket(), 0)
            } else {
                this.dispatchError(`WebSocket connection timed out (all ${this.WS_MAX_ATTEMPTS} retries exhausted)`)
            }
        }, this.WS_CONNECT_TIMEOUT_MS)
    }

    private onWsOpen() {
        if (this.wsConnectTimeout !== null) {
            clearTimeout(this.wsConnectTimeout)
            this.wsConnectTimeout = null
        }

        for (const raw of this.wsSendBuffer.splice(0)) {
            this.ws.send(raw)
        }
    }
    private onWsClose() {
        if (this.wsAttempt < this.WS_MAX_ATTEMPTS && this.wsConnectTimeout === null) {
            // Closed by our timeout handler, retry is pending — suppress error
            return
        }

        if (this.peer && this.peer.connectionState === "connected") {
            this.dispatchError("Stream session ended (host disconnected)")
        } else {
            this.dispatchError("WebSocket closed before attaching to the stream")
        }
    }

    private sendWsMessage(message: StreamClientMessage) {
        const raw = JSON.stringify(message)
        if (this.ws.readyState == WebSocket.OPEN) {
            this.ws.send(raw)
        } else {
            this.wsSendBuffer.push(raw)
        }
    }

    private messageProcessingQueue: Promise<void> = Promise.resolve()
    private onRawWsMessage(event: MessageEvent) {
        this.messageProcessingQueue = this.messageProcessingQueue.then(async () => {
            try {
                const data = event.data
                if (typeof data !== "string") {
                    return
                }
                await this.onMessage(JSON.parse(data))
            } catch (err) {
                console.error("Error processing WebSocket message", err)
            }
        })
    }

    private onError(event: Event) {
        console.error("Input Stream Error", event)
    }

    // -- Server Messages
    private async onMessage(message: StreamServerMessage | string) {
        if (typeof message == "string") {
            this.dispatchError(message)
        } else if ("StageStarting" in message) {
            this.dispatch({ type: "stageStarting", stage: message.StageStarting.stage })
        } else if ("StageComplete" in message) {
            this.dispatch({ type: "stageComplete", stage: message.StageComplete.stage })
        } else if ("StageFailed" in message) {
            this.dispatch({ type: "stageFailed", stage: message.StageFailed.stage, errorCode: message.StageFailed.error_code })
        } else if ("HostNotFound" in message) {
            this.dispatch({ type: "hostNotFound" })
        } else if ("StreamNotActive" in message) {
            this.dispatch({ type: "streamNotActive" })
        } else if ("WebRtcConfig" in message) {
            await this.createPeer({
                iceServers: message.WebRtcConfig.ice_servers
            })
        } else if ("Signaling" in message) {
            if ("Description" in message.Signaling) {
                const descriptionRaw = message.Signaling.Description
                await this.handleRemoteDescription({
                    type: descriptionRaw.ty as RTCSdpType,
                    sdp: descriptionRaw.sdp,
                })
            } else if ("AddIceCandidate" in message.Signaling) {
                const candidateRaw = message.Signaling.AddIceCandidate
                await this.handleIceCandidate({
                    candidate: candidateRaw.candidate,
                    sdpMid: candidateRaw.sdp_mid,
                    sdpMLineIndex: candidateRaw.sdp_mline_index,
                    usernameFragment: candidateRaw.username_fragment,
                })
            }
        }
        // Other StreamServerMessage variants (UpdateApp, AppNotFound, HostNotPaired,
        // AlreadyStreaming, ConnectionComplete, ConnectionTerminated, PeerDisconnect)
        // are only ever sent to the primary (AV) client and never reach this client.
    }

    // -- WebRTC Peer (input-only: no video/audio transceivers or tracks)
    private async createPeer(configuration: RTCConfiguration) {
        if (this.peer) {
            return
        }

        this.peer = new RTCPeerConnection(configuration)
        this.peer.addEventListener("error", this.onError.bind(this))
        this.peer.addEventListener("negotiationneeded", this.onNegotiationNeeded.bind(this))
        this.peer.addEventListener("icecandidate", this.onIceCandidate.bind(this))
        this.peer.addEventListener("connectionstatechange", this.onConnectionStateChange.bind(this))

        this.input.setPeer(this.peer)

        if (this.remoteDescription) {
            await this.handleRemoteDescription(this.remoteDescription)
        } else {
            await this.onNegotiationNeeded()
        }
        await this.tryDequeueIceCandidates()
    }

    private onConnectionStateChange() {
        if (!this.peer) {
            return
        }

        if (this.peer.connectionState == "connected") {
            if (this.wsConnectTimeout !== null) {
                clearTimeout(this.wsConnectTimeout)
                this.wsConnectTimeout = null
            }

            // There's no video/audio pipeline here, so there's no real "stream size" —
            // this just flips StreamInput into the connected state so buffered
            // gamepads/data channels get registered.
            this.input.onStreamStart({ touch: true }, [window.innerWidth, window.innerHeight])

            this.dispatch({ type: "connected" })
        } else if (this.peer.connectionState == "failed" || this.peer.connectionState == "closed") {
            this.dispatchError(`Connection state is ${this.peer.connectionState}`)
        }
    }

    // -- Signaling (mirrors stream/index.ts's Stream class)
    private makingOffer = false
    private async onNegotiationNeeded() {
        if (!this.peer) {
            return
        }

        if (this.makingOffer || this.peer.signalingState !== "stable") {
            return
        }

        this.makingOffer = true
        try {
            await this.peer.setLocalDescription()
            await this.waitForIceGathering()
            this.sendLocalDescription()
        } finally {
            this.makingOffer = false
        }
    }

    private iceGatheringResolve: (() => void) | null = null
    private iceCandidateDebounceResolve: (() => void) | null = null
    private waitForIceGathering(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.peer) { resolve(); return }
            if (this.peer.iceGatheringState === "complete") { resolve(); return }

            const maxTimeout = setTimeout(() => {
                this.iceGatheringResolve = null
                this.iceCandidateDebounceResolve = null
                resolve()
            }, 3000)

            let debounceTimer: ReturnType<typeof setTimeout> | null = null
            this.iceCandidateDebounceResolve = () => {
                if (debounceTimer) clearTimeout(debounceTimer)
                debounceTimer = setTimeout(() => {
                    clearTimeout(maxTimeout)
                    this.iceGatheringResolve = null
                    this.iceCandidateDebounceResolve = null
                    resolve()
                }, 300)
            }

            this.iceGatheringResolve = () => {
                clearTimeout(maxTimeout)
                if (debounceTimer) clearTimeout(debounceTimer)
                this.iceGatheringResolve = null
                this.iceCandidateDebounceResolve = null
                resolve()
            }
        })
    }

    private remoteDescription: RTCSessionDescriptionInit | null = null
    private async handleRemoteDescription(description: RTCSessionDescriptionInit) {
        this.remoteDescription = description
        if (!this.peer) {
            return
        }

        const offerCollision = description.type === "offer" &&
            (this.makingOffer || this.peer.signalingState !== "stable")

        if (offerCollision) {
            await this.peer.setLocalDescription({ type: "rollback" })
        }

        await this.peer.setRemoteDescription(description)

        if (description.type === "offer") {
            await this.peer.setLocalDescription()
            await this.waitForIceGathering()
            this.sendLocalDescription()
        }

        await this.tryDequeueIceCandidates()
    }

    private iceCandidateQueue: Array<RTCIceCandidateInit> = []
    private async tryDequeueIceCandidates() {
        for (const candidate of this.iceCandidateQueue.splice(0)) {
            await this.handleIceCandidate(candidate)
        }
    }
    private async handleIceCandidate(candidate: RTCIceCandidateInit) {
        if (!this.peer || !this.remoteDescription) {
            this.iceCandidateQueue.push(candidate)
            return
        }

        try {
            await this.peer.addIceCandidate(candidate)
        } catch (err) {
            console.warn(`Failed to add ICE candidate: ${err}`)
        }
    }

    private sendLocalDescription() {
        if (!this.peer) {
            return
        }

        const description = this.peer.localDescription as RTCSessionDescription
        this.sendWsMessage({
            Signaling: {
                Description: {
                    ty: description.type,
                    sdp: description.sdp
                }
            }
        })
    }
    private onIceCandidate(event: RTCPeerConnectionIceEvent) {
        if (!event.candidate) {
            if (this.iceGatheringResolve) {
                this.iceGatheringResolve()
            }
            return
        }
        const candidateJson = event.candidate.toJSON()
        if (!candidateJson?.candidate) {
            return
        }

        if (this.iceCandidateDebounceResolve) {
            this.iceCandidateDebounceResolve()
        }
        // Non-trickle ICE: candidates are bundled into the SDP via waitForIceGathering.
    }

    // -- Events
    private dispatch(detail: InputStreamInfoEvent["detail"]) {
        this.eventTarget.dispatchEvent(new CustomEvent("input-stream-info", { detail }))
    }
    private dispatchError(message: string) {
        this.dispatch({ type: "error", message })
    }

    addInfoListener(listener: InputStreamInfoEventListener) {
        this.eventTarget.addEventListener("input-stream-info", listener as EventListenerOrEventListenerObject)
    }
    removeInfoListener(listener: InputStreamInfoEventListener) {
        this.eventTarget.removeEventListener("input-stream-info", listener as EventListenerOrEventListenerObject)
    }

    getInput(): StreamInput {
        return this.input
    }

    getPeer(): RTCPeerConnection | null {
        return this.peer
    }

    close() {
        if (this.beforeUnloadHandler) {
            window.removeEventListener("beforeunload", this.beforeUnloadHandler)
            this.beforeUnloadHandler = null
        }
        this.peer?.close()
        this.ws?.close()
    }
}
