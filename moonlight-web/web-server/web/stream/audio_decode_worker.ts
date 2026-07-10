// @ts-ignore
import Module from "./opus-stream-decoder.mjs"
import { OggPageDemuxer, isOpusHeaderPacket } from "./ogg_demux.js"

// Audio decode worker with two engines:
//
// - "native": WebCodecs AudioDecoder (the browser's built-in libopus).
//   The incoming stream is Ogg-Opus (the streamer wraps raw Opus packets in
//   Ogg pages), so packets are unwrapped with a small Ogg demuxer and fed to
//   the decoder bare. No WASM, no Ogg parsing in WASM, and decoding happens
//   on the browser's codec thread instead of this worker's JS thread.
// - "wasm": the original Ogg-Opus WASM decoder, kept as an automatic
//   fallback for browsers without AudioDecoder (it's secure-context only)
//   and as a runtime escape hatch if the native decoder errors mid-stream.
//
// Both engines produce identical PCM (same Opus bytes through libopus either
// way) and share one delivery path, so switching engines can never change how
// the audio sounds — only how much CPU it costs.

type InitMessage = { type: "init" }
type DecodeMessage = { type: "decode"; packet: ArrayBuffer }
type DecodeBatchMessage = { type: "decodeBatch"; packets: ArrayBuffer[] }
type FreeMessage = { type: "free" }
type RecycleMessage = { type: "recycle"; buffers: ArrayBuffer[] }
type WorkerInMessage = InitMessage | DecodeMessage | DecodeBatchMessage | FreeMessage | RecycleMessage

export type AudioDecodeEngine = "native" | "wasm"
type ReadyMessage = { type: "ready"; engine: AudioDecodeEngine }
type DecodedMessage = { type: "decoded"; left: ArrayBuffer; right: ArrayBuffer }
type ErrorMessage = { type: "error"; message: string }
type WorkerOutMessage = ReadyMessage | DecodedMessage | ErrorMessage

let engine: AudioDecodeEngine | null = null
let decoderReady = false
const workerSelf = self as any

// -- Native engine state
let nativeDecoder: AudioDecoder | null = null
const oggDemuxer = new OggPageDemuxer()
// Raw DataChannel messages that contained the Ogg-Opus header packets
// (OpusHead/OpusTags). The WASM decoder needs the stream from the very
// beginning to initialize, so these are replayed if we ever fall back
// mid-stream.
const stashedHeaderMessages: ArrayBuffer[] = []
// Messages arriving while an async fallback to WASM is in progress.
let fallbackInProgress = false
const pendingDuringFallback: ArrayBuffer[] = []
// Informational only — AudioDecoder passes timestamps through as metadata and
// the playback path ignores them, so a nominal 10ms step per chunk is fine.
let chunkTimestampUs = 0

// -- WASM engine state
let wasmDecoder: any = null

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

function postError(message: string) {
    const msg: ErrorMessage = { type: "error", message }
    workerSelf.postMessage(msg)
}

function takePooledBuffer(byteLen: number): ArrayBuffer {
    const pooled = pcmBufferPool.length > 0 ? pcmBufferPool.pop()! : null
    if (pooled && pooled.byteLength === byteLen) {
        return pooled
    }
    return new ArrayBuffer(byteLen)
}

// Shared delivery path for both engines: direct worker→worklet port when
// available, main thread when no worklet exists, startup buffer otherwise.
function deliverPcm(leftBuf: ArrayBuffer, rightBuf: ArrayBuffer) {
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
}

// ---------------------------------------------------------------------------
// Native engine (WebCodecs AudioDecoder)
// ---------------------------------------------------------------------------

function onNativeDecoded(audioData: AudioData) {
    try {
        const frames = audioData.numberOfFrames
        const channels = audioData.numberOfChannels
        const byteLen = frames * 4 // Float32

        const leftBuf = takePooledBuffer(byteLen)
        const rightBuf = takePooledBuffer(byteLen)
        const left = new Float32Array(leftBuf)
        const right = new Float32Array(rightBuf)

        const format = audioData.format
        if (format === "f32-planar") {
            audioData.copyTo(left, { planeIndex: 0 })
            if (channels > 1) {
                audioData.copyTo(right, { planeIndex: 1 })
            } else {
                right.set(left)
            }
        } else if (format === "f32") {
            const interleaved = new Float32Array(frames * channels)
            audioData.copyTo(interleaved, { planeIndex: 0 })
            if (channels > 1) {
                for (let i = 0; i < frames; i++) {
                    left[i] = interleaved[i * channels]
                    right[i] = interleaved[i * channels + 1]
                }
            } else {
                left.set(interleaved)
                right.set(interleaved)
            }
        } else if (format === "s16-planar") {
            const scale = 1 / 32768
            const tmp = new Int16Array(frames)
            audioData.copyTo(tmp, { planeIndex: 0 })
            for (let i = 0; i < frames; i++) left[i] = tmp[i] * scale
            if (channels > 1) {
                audioData.copyTo(tmp, { planeIndex: 1 })
                for (let i = 0; i < frames; i++) right[i] = tmp[i] * scale
            } else {
                right.set(left)
            }
        } else if (format === "s16") {
            const scale = 1 / 32768
            const tmp = new Int16Array(frames * channels)
            audioData.copyTo(tmp, { planeIndex: 0 })
            if (channels > 1) {
                for (let i = 0; i < frames; i++) {
                    left[i] = tmp[i * channels] * scale
                    right[i] = tmp[i * channels + 1] * scale
                }
            } else {
                for (let i = 0; i < frames; i++) left[i] = tmp[i] * scale
                right.set(left)
            }
        } else {
            throw new Error(`unsupported AudioData format: ${format}`)
        }

        deliverPcm(leftBuf, rightBuf)
    } catch (e) {
        postError(`native audio decode output failed: ${e}`)
    } finally {
        audioData.close()
    }
}

async function initNativeDecoder(): Promise<boolean> {
    try {
        if (typeof AudioDecoder === "undefined") return false

        const config: AudioDecoderConfig = {
            codec: "opus",
            sampleRate: 48000,
            numberOfChannels: 2,
        }
        const support = await AudioDecoder.isConfigSupported(config)
        if (!support.supported) return false

        nativeDecoder = new AudioDecoder({
            output: onNativeDecoded,
            error: (e) => {
                // Fatal decoder error (the decoder is now closed) — switch to WASM.
                void fallbackToWasm(`native decoder error: ${e}`)
            },
        })
        nativeDecoder.configure(config)
        return true
    } catch (e) {
        console.warn("AudioDecoder unavailable:", e)
        nativeDecoder = null
        return false
    }
}

function decodeNative(data: ArrayBuffer) {
    const bytes = new Uint8Array(data)
    const packets = oggDemuxer.push(bytes)

    let sawHeader = false
    for (const packet of packets) {
        if (isOpusHeaderPacket(packet)) {
            sawHeader = true
            continue
        }
        try {
            nativeDecoder!.decode(new EncodedAudioChunk({
                type: "key", // every Opus packet is independently decodable
                timestamp: chunkTimestampUs,
                data: packet,
            }))
            chunkTimestampUs += 10_000
        } catch (e) {
            void fallbackToWasm(`native decode failed: ${e}`)
            return
        }
    }

    if (sawHeader) {
        // Keep the raw header message so a later WASM fallback can bootstrap
        // its Ogg parser from the true start of the stream.
        stashedHeaderMessages.push(data.slice(0))
    }
}

// ---------------------------------------------------------------------------
// WASM engine (Ogg-Opus stream decoder)
// ---------------------------------------------------------------------------

async function initWasmDecoder(): Promise<boolean> {
    try {
        const decoderModule = Module()
        const OpusStreamDecoder = decoderModule.OpusStreamDecoder
        wasmDecoder = new OpusStreamDecoder({
            onDecode: (decoded: any) => {
                try {
                    const left = decoded.left as Float32Array
                    const right = decoded.right as Float32Array
                    const byteLen = left.length * 4

                    const leftBuf = takePooledBuffer(byteLen)
                    const rightBuf = takePooledBuffer(byteLen)

                    // Copy decoded WASM output into our owned buffers
                    new Float32Array(leftBuf).set(left)
                    new Float32Array(rightBuf).set(right)

                    deliverPcm(leftBuf, rightBuf)
                } catch (e) {
                    postError(`audio worker decode callback failed: ${e}`)
                }
            },
        })

        await wasmDecoder.ready
        return true
    } catch (e) {
        wasmDecoder = null
        postError(`audio worker wasm init failed: ${e}`)
        return false
    }
}

/// Runtime switch from the native engine to WASM. The WASM decoder consumes
/// the raw Ogg stream itself, so it gets: the stashed header pages, whatever
/// partial page the demuxer still held, then everything that arrived while
/// this async switch was running.
async function fallbackToWasm(reason: string) {
    if (engine !== "native" || fallbackInProgress) return
    fallbackInProgress = true
    console.warn("Falling back to WASM opus decoder:", reason)

    try { nativeDecoder?.close() } catch { /* may already be closed */ }
    nativeDecoder = null

    const ok = await initWasmDecoder()
    if (!ok) {
        engine = null
        decoderReady = false
        fallbackInProgress = false
        postError(`audio decode unavailable after native failure: ${reason}`)
        return
    }

    engine = "wasm"
    for (const raw of stashedHeaderMessages) {
        wasmDecoder.decode(new Uint8Array(raw))
    }
    const remaining = oggDemuxer.takeBuffered()
    if (remaining.length > 0) {
        wasmDecoder.decode(remaining)
    }
    fallbackInProgress = false
    for (const raw of pendingDuringFallback.splice(0)) {
        handleEncodedBytes(raw)
    }
}

// ---------------------------------------------------------------------------
// Shared input path
// ---------------------------------------------------------------------------

function handleEncodedBytes(data: ArrayBuffer) {
    if (fallbackInProgress) {
        pendingDuringFallback.push(data)
        return
    }
    if (!decoderReady) return

    if (engine === "native" && nativeDecoder) {
        decodeNative(data)
        return
    }
    if (engine === "wasm" && wasmDecoder) {
        try {
            wasmDecoder.decode(new Uint8Array(data))
        } catch (e) {
            postError(`audio worker decode failed: ${e}`)
        }
    }
}

async function initDecoder() {
    if (await initNativeDecoder()) {
        engine = "native"
        decoderReady = true
        const ready: ReadyMessage = { type: "ready", engine: "native" }
        workerSelf.postMessage(ready)
        return
    }

    if (await initWasmDecoder()) {
        engine = "wasm"
        decoderReady = true
        const ready: ReadyMessage = { type: "ready", engine: "wasm" }
        workerSelf.postMessage(ready)
    }
    // initWasmDecoder already posted the error on failure
}

workerSelf.onmessage = (event: MessageEvent<WorkerInMessage | ArrayBuffer>) => {
    const data = event.data
    if (!data) return

    // Fast path: raw ArrayBuffer transferred directly from main thread (zero-allocation path).
    // This avoids creating a typed message object on the main thread entirely.
    if (data instanceof ArrayBuffer) {
        handleEncodedBytes(data)
        return
    }

    if (data.type === "init") {
        if (!decoderReady) {
            void initDecoder()
        }
        return
    }

    if (data.type === "decode") {
        handleEncodedBytes(data.packet)
        return
    }

    if (data.type === "decodeBatch") {
        for (const packet of data.packets) {
            handleEncodedBytes(packet)
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
        try { nativeDecoder?.close() } catch { /* best effort */ }
        nativeDecoder = null
        if (wasmDecoder) {
            try {
                wasmDecoder.free()
            } catch {
                // best effort cleanup
            }
        }
        wasmDecoder = null
        engine = null
        decoderReady = false
        pcmBufferPool.length = 0
        stashedHeaderMessages.length = 0
        pendingDuringFallback.length = 0
    }
}
