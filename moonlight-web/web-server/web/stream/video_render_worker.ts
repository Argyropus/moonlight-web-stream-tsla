type InitMessage = {
    type: "init"
    canvas: OffscreenCanvas
    stretchToFit: boolean
    width: number
    height: number
}
type SetStreamMessage = { type: "setStream"; stream: ReadableStream<VideoFrame> }
type StopStreamMessage = { type: "stopStream" }
type FrameMessage = { type: "frame"; frame: VideoFrame }
type ResizeMessage = { type: "resize"; width: number; height: number }
type StopMessage = { type: "stop" }
type WorkerMessage = InitMessage | SetStreamMessage | StopStreamMessage | FrameMessage | ResizeMessage | StopMessage

// Message the worker sends back to the main thread
export type WorkerStatsMessage = {
    type: "stats"
    drawn: number
    dropped: number
    /** frames that arrived at the worker this interval */
    arrived: number
    /** inter-frame arrival gap stats (ms); -1 means no data yet */
    minGapMs: number
    avgGapMs: number
    maxGapMs: number
}

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let stretchToFit = false
let drawWidth = 0
let drawHeight = 0
let offsetX = 0
let offsetY = 0
const workerSelf = self as any

// Active reader when the ReadableStream has been transferred to this worker.
// All frame delivery happens here, bypassing the main-thread readLoop entirely.
let activeStreamReader: ReadableStreamDefaultReader<VideoFrame> | null = null

async function readStreamLoop(reader: ReadableStreamDefaultReader<VideoFrame>) {
    try {
        while (true) {
            const { value, done } = await reader.read()
            if (done || reader !== activeStreamReader) {
                if (!done && value) value.close()
                break
            }
            scheduleFrame(value)
        }
    } catch (_e) {
        // Stream was cancelled (stopStream / worker terminate) — expected, not an error
    }
}

// === Draw-immediately strategy ===
// On a 60Hz display, only the latest frame matters at each v-sync. Scheduling frames
// to smooth out decoder batch delivery adds latency, clock drift, and frame drops
// without improving what actually appears on screen. The display composites the
// latest canvas content regardless of when individual drawImage calls happened.
//
// The previous scheduler approaches all failed due to:
// - Encoder clock vs performance.now() drift (compounds over minutes)
// - createImageBitmap async ordering races
// - Decoder buffer starvation from holding VideoFrames in queues
// - setTimeout jitter accumulation
//
// Draw-immediately: zero drops, zero added latency, zero drift. The burst delivery
// pattern (0.2/17.5/31.8ms gaps) is invisible on a 60Hz panel because the display
// only samples once every 16.6ms regardless.

let lastDrawnTimestamp: number = -1
let workerDrawn = 0
let workerDropped = 0

// Arrival-timing accumulators (reset each stats interval)
let arrivalCount = 0
let lastArrivalMs = -1
let gapMin = Infinity
let gapMax = -Infinity
let gapSum = 0
let gapCount = 0

function clearPresentationQueue() { /* no queue to clear */ }

function scheduleFrame(frame: VideoFrame) {
    // Track inter-frame arrival gap
    const nowMs = performance.now()
    if (lastArrivalMs >= 0) {
        const gap = nowMs - lastArrivalMs
        if (gap < gapMin) gapMin = gap
        if (gap > gapMax) gapMax = gap
        gapSum += gap
        gapCount++
    }
    lastArrivalMs = nowMs
    arrivalCount++

    // Monotonic guard — discard out-of-order/duplicate frames
    if (frame.timestamp <= lastDrawnTimestamp) {
        frame.close()
        workerDropped++
        return
    }
    lastDrawnTimestamp = frame.timestamp
    drawFrame(frame)  // drawFrame calls frame.close() — decoder buffer released immediately
    workerDrawn++
}

// Post stats back to the main thread every second
setInterval(() => {
    const msg: WorkerStatsMessage = {
        type: "stats",
        drawn: workerDrawn,
        dropped: workerDropped,
        arrived: arrivalCount,
        minGapMs: gapCount > 0 ? gapMin : -1,
        avgGapMs: gapCount > 0 ? gapSum / gapCount : -1,
        maxGapMs: gapCount > 0 ? gapMax : -1,
    }
    workerSelf.postMessage(msg)
    // Reset interval accumulators
    arrivalCount = 0
    gapMin = Infinity; gapMax = -Infinity; gapSum = 0; gapCount = 0
}, 1000)

function recalcForFrame(frame: VideoFrame) {
    if (!canvas) return

    const safeHeight = Math.max(1, canvas.height)
    const safeDisplayHeight = Math.max(1, frame.displayHeight)
    const canvasAspect = canvas.width / safeHeight
    const frameAspect = frame.displayWidth / safeDisplayHeight

    offsetX = 0
    offsetY = 0

    if (stretchToFit) {
        drawWidth = canvas.width
        drawHeight = canvas.height
        return
    }

    // Keep source resolution in non-stretch mode.
    if (drawWidth === 0 || drawHeight === 0) {
        canvas.width = frame.displayWidth
        canvas.height = frame.displayHeight
    }

    if (canvasAspect > frameAspect) {
        drawHeight = canvas.height
        drawWidth = drawHeight * frameAspect
        offsetX = (canvas.width - drawWidth) / 2
    } else {
        drawWidth = canvas.width
        drawHeight = drawWidth / frameAspect
        offsetY = (canvas.height - drawHeight) / 2
    }
}

function drawFrame(frame: VideoFrame) {
    if (!canvas || !ctx) {
        frame.close()
        return
    }

    if (drawWidth === 0 || drawHeight === 0) {
        recalcForFrame(frame)
    }

    if (offsetX !== 0 || offsetY !== 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    ctx.drawImage(frame, offsetX, offsetY, drawWidth, drawHeight)
    frame.close()
}

workerSelf.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const data = event.data
    if (!data) return

    if (data.type === "init") {
        canvas = data.canvas
        stretchToFit = data.stretchToFit
        canvas.width = Math.max(1, data.width)
        canvas.height = Math.max(1, data.height)
        drawWidth = 0
        drawHeight = 0
        offsetX = 0
        offsetY = 0
        ctx = canvas.getContext("2d")
        return
    }

    if (data.type === "resize") {
        if (!canvas) return
        if (stretchToFit) {
            canvas.width = Math.max(1, data.width)
            canvas.height = Math.max(1, data.height)
            drawWidth = canvas.width
            drawHeight = canvas.height
            offsetX = 0
            offsetY = 0
        } else {
            drawWidth = 0
            drawHeight = 0
            offsetX = 0
            offsetY = 0
        }
        return
    }

    if (data.type === "setStream") {
        if (activeStreamReader) {
            const old = activeStreamReader
            activeStreamReader = null
            old.cancel().catch(() => {})
        }
        lastDrawnTimestamp = -1
        lastArrivalMs = -1
        activeStreamReader = data.stream.getReader()
        readStreamLoop(activeStreamReader)
        return
    }

    if (data.type === "stopStream") {
        if (activeStreamReader) {
            activeStreamReader.cancel().catch(() => {})
            activeStreamReader = null
        }
        return
    }

    if (data.type === "frame") {
        scheduleFrame(data.frame)
        return
    }

    if (data.type === "stop") {
        if (activeStreamReader) { activeStreamReader.cancel().catch(() => {}); activeStreamReader = null }
        lastDrawnTimestamp = -1
        canvas = null
        ctx = null
    }
}
