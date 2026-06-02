// @ts-ignore
import Module from "./opus-stream-decoder.mjs"

type InitMessage = { type: "init" }
type DecodeMessage = { type: "decode"; packet: ArrayBuffer }
type DecodeBatchMessage = { type: "decodeBatch"; packets: ArrayBuffer[] }
type FreeMessage = { type: "free" }
type RecycleMessage = { type: "recycle"; buffers: ArrayBuffer[] }
type WorkerInMessage = InitMessage | DecodeMessage | DecodeBatchMessage | FreeMessage | RecycleMessage

type ReadyMessage = { type: "ready" }
type DecodedMessage = { type: "decoded"; left: ArrayBuffer; right: ArrayBuffer }
type ErrorMessage = { type: "error"; message: string }
type WorkerOutMessage = ReadyMessage | DecodedMessage | ErrorMessage

let decoder: any = null
let decoderReady = false
const workerSelf = self as any

// Direct port to AudioWorklet — bypasses main thread for decoded PCM delivery.
// Set once main thread sends it after worklet is ready.
let pcmDirectPort: MessagePort | null = null

// Buffer decoded frames until the direct port is available.
// During startup, the worker may be ready before the worklet. Rather than
// sending to main thread (which would drop frames if worklet isn't ready),
// we buffer here and flush when the direct port arrives or main-thread mode is set.
let pendingFrames: { left: ArrayBuffer; right: ArrayBuffer }[] = []
const PENDING_MAX = 50 // ~500ms at 10ms/frame — limited, worklet will cap anyway

// When true, send decoded frames to the main thread (no AudioWorklet available).
let useMainThread = false

// PCM buffer recycling pool: main thread returns used ArrayBuffers after
// copyToChannel so we can reuse them instead of allocating new ones per decode.
// This eliminates the MinorGC pauses caused by rapid Float32Array churn.
const pcmBufferPool: ArrayBuffer[] = []
const PCM_POOL_MAX = 32 // enough for ~300ms of audio at 48kHz/10ms frames

// The WASM file lives one directory up from this worker (at the web root),
// but fetch() in a worker resolves relative URLs against the worker's own URL
// (which is in the stream/ subdirectory). Intercept fetch to fix the path.
const originalFetch = workerSelf.fetch.bind(workerSelf)
workerSelf.fetch = function(input: any, init?: any) {
    if (typeof input === "string" && input.endsWith("opus-stream-decoder.wasm")) {
        input = "../opus-stream-decoder.wasm"
    }
    return originalFetch(input, init)
}

async function initDecoder() {
    try {
        const decoderModule = Module()
        const OpusStreamDecoder = decoderModule.OpusStreamDecoder
        decoder = new OpusStreamDecoder({
            onDecode: (decoded: any) => {
                try {
                    const left = decoded.left as Float32Array
                    const right = decoded.right as Float32Array
                    const byteLen = left.length * 4 // Float32 = 4 bytes

                    // Reuse pooled buffers if available and correctly sized,
                    // otherwise allocate (only happens on cold start / size change).
                    let leftBuf = pcmBufferPool.length > 0 ? pcmBufferPool.pop()! : null
                    if (!leftBuf || leftBuf.byteLength !== byteLen) {
                        leftBuf = new ArrayBuffer(byteLen)
                    }
                    let rightBuf = pcmBufferPool.length > 0 ? pcmBufferPool.pop()! : null
                    if (!rightBuf || rightBuf.byteLength !== byteLen) {
                        rightBuf = new ArrayBuffer(byteLen)
                    }

                    // Copy decoded WASM output into our owned buffers
                    new Float32Array(leftBuf).set(left)
                    new Float32Array(rightBuf).set(right)

                    if (pcmDirectPort) {
                        // Fast path: send directly to AudioWorklet (no main-thread involvement)
                        pcmDirectPort.postMessage(
                            { type: 'pcm', left: leftBuf, right: rightBuf },
                            [leftBuf, rightBuf]
                        )
                    } else if (useMainThread) {
                        // Fallback path (HTTP): send decoded PCM to the main thread
                        const msg: DecodedMessage = { type: 'decoded', left: leftBuf, right: rightBuf }
                        workerSelf.postMessage(msg, [leftBuf, rightBuf])
                    } else {
                        // Startup path: buffer until direct port or main-thread mode is set.
                        if (pendingFrames.length < PENDING_MAX) {
                            pendingFrames.push({ left: leftBuf, right: rightBuf })
                        }
                    }
                } catch (e) {
                    const errMsg: ErrorMessage = {
                        type: "error",
                        message: `audio worker decode callback failed: ${e}`,
                    }
                    workerSelf.postMessage(errMsg)
                }
            },
        })

        await decoder.ready
        decoderReady = true
        const ready: ReadyMessage = { type: "ready" }
        workerSelf.postMessage(ready)
    } catch (e) {
        const message: ErrorMessage = {
            type: "error",
            message: `audio worker init failed: ${e}`,
        }
        workerSelf.postMessage(message)
    }
}

workerSelf.onmessage = (event: MessageEvent<WorkerInMessage | ArrayBuffer>) => {
    const data = event.data
    if (!data) return

    // Fast path: raw ArrayBuffer transferred directly from main thread (zero-allocation path).
    // This avoids creating a typed message object on the main thread entirely.
    if (data instanceof ArrayBuffer) {
        if (!decoderReady || !decoder) return
        try {
            decoder.decode(new Uint8Array(data))
        } catch (e) {
            const message: ErrorMessage = {
                type: "error",
                message: `audio worker decode failed: ${e}`,
            }
            workerSelf.postMessage(message)
        }
        return
    }

    if (data.type === "init") {
        if (!decoderReady) {
            void initDecoder()
        }
        return
    }

    if (data.type === "decode") {
        if (!decoderReady || !decoder) return
        try {
            decoder.decode(new Uint8Array(data.packet))
        } catch (e) {
            const message: ErrorMessage = {
                type: "error",
                message: `audio worker decode failed: ${e}`,
            }
            workerSelf.postMessage(message)
        }
        return
    }

    if (data.type === "decodeBatch") {
        if (!decoderReady || !decoder) return
        try {
            for (const packet of data.packets) {
                decoder.decode(new Uint8Array(packet))
            }
        } catch (e) {
            const message: ErrorMessage = {
                type: "error",
                message: `audio worker decode batch failed: ${e}`,
            }
            workerSelf.postMessage(message)
        }
        return
    }

    if (data.type === "recycle") {
        // Main thread is returning used PCM buffers for reuse
        for (const buf of data.buffers) {
            if (pcmBufferPool.length < PCM_POOL_MAX) {
                pcmBufferPool.push(buf)
            }
        }
        return
    }

    if ((data as any).type === "pcm-port") {
        // Main thread is giving us a direct MessagePort to the AudioWorklet.
        // From now on, send decoded PCM directly there (bypasses main thread).
        pcmDirectPort = (data as any).port as MessagePort
        // Flush startup-buffered frames to the worklet.
        // The worklet's ring buffer cap (200ms) will discard excess if needed.
        for (const frame of pendingFrames) {
            pcmDirectPort.postMessage(
                { type: 'pcm', left: frame.left, right: frame.right },
                [frame.left, frame.right]
            )
        }
        pendingFrames = []
        return
    }

    if ((data as any).type === "use-main-thread") {
        // No AudioWorklet available (non-secure context / HTTP).
        // Switch to sending decoded frames back to the main thread.
        useMainThread = true
        // Flush any buffered frames to the main thread now.
        for (const frame of pendingFrames) {
            const msg: DecodedMessage = { type: 'decoded', left: frame.left, right: frame.right }
            workerSelf.postMessage(msg, [frame.left, frame.right])
        }
        pendingFrames = []
        return
    }

    if (data.type === "free") {
        if (decoder) {
            try {
                decoder.free()
            } catch {
                // best effort cleanup
            }
        }
        decoder = null
        decoderReady = false
        pcmBufferPool.length = 0
    }
}
