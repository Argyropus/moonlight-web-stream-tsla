// Minimal incremental Ogg page demuxer.
//
// The streamer wraps raw Opus packets in an Ogg-Opus container purely so the
// WASM decoder (which expects a full Ogg-Opus stream) can parse them. A
// native WebCodecs AudioDecoder wants bare Opus packets instead, so this
// strips the Ogg framing back off. DataChannel message boundaries do not
// line up with Ogg page boundaries (pages can span multiple messages, or a
// message can contain several pages), so this buffers across `push()` calls
// exactly like reading incrementally from a file.

const CAPTURE_PATTERN = [0x4f, 0x67, 0x67, 0x53] // "OggS"

function hasCapturePattern(buf: Uint8Array, offset: number): boolean {
    return buf[offset] === CAPTURE_PATTERN[0] && buf[offset + 1] === CAPTURE_PATTERN[1] &&
        buf[offset + 2] === CAPTURE_PATTERN[2] && buf[offset + 3] === CAPTURE_PATTERN[3]
}

function findCapturePattern(buf: Uint8Array): number {
    for (let i = 0; i <= buf.length - 4; i++) {
        if (hasCapturePattern(buf, i)) return i
    }
    return -1
}

function magicEquals(packet: Uint8Array, magic: string): boolean {
    if (packet.length < magic.length) return false
    for (let i = 0; i < magic.length; i++) {
        if (packet[i] !== magic.charCodeAt(i)) return false
    }
    return true
}

/** True for the two Ogg-Opus header packets (identification + comment), which carry no audio. */
export function isOpusHeaderPacket(packet: Uint8Array): boolean {
    return magicEquals(packet, "OpusHead") || magicEquals(packet, "OpusTags")
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b
    if (b.length === 0) return a
    const out = new Uint8Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
}

export class OggPageDemuxer {
    private buffer: Uint8Array = new Uint8Array(0)

    /**
     * Hands over (and clears) whatever partial page bytes are still buffered.
     * Used when switching to a decoder that consumes the raw Ogg stream
     * itself, so no bytes are lost at the switch-over point.
     */
    takeBuffered(): Uint8Array {
        const remaining = this.buffer
        this.buffer = new Uint8Array(0)
        return remaining
    }

    /** Feed newly-arrived bytes; returns every packet fully reconstructed from complete pages now buffered. */
    push(chunk: Uint8Array): Uint8Array[] {
        this.buffer = concat(this.buffer, chunk)

        const packets: Uint8Array[] = []
        while (true) {
            const pagePackets = this.tryParsePage()
            if (pagePackets === null) break
            for (const packet of pagePackets) packets.push(packet)
        }
        return packets
    }

    /** Parses and consumes one complete page from the front of the buffer, or returns null if not enough data has arrived yet. */
    private tryParsePage(): Uint8Array[] | null {
        let data = this.buffer

        if (data.length >= 4 && !hasCapturePattern(data, 0)) {
            // Framing drift (shouldn't normally happen — the streamer only ever
            // emits complete Ogg pages) — resync on the next capture pattern.
            const found = findCapturePattern(data)
            if (found === -1) {
                // Keep a small tail in case a capture pattern is split across pushes.
                this.buffer = data.subarray(Math.max(0, data.length - 3))
                return null
            }
            data = data.subarray(found)
            this.buffer = data
        }

        if (data.length < 27) return null // not enough for a page header yet

        const segmentCount = data[26]
        const headerLen = 27 + segmentCount
        if (data.length < headerLen) return null

        let payloadLen = 0
        for (let i = 0; i < segmentCount; i++) payloadLen += data[27 + i]

        const pageLen = headerLen + payloadLen
        if (data.length < pageLen) return null // page body not fully received yet

        // Split the payload into packets per Ogg's lacing rule: a run of
        // 255-byte segments belongs to one packet, terminated by a segment < 255.
        const packets: Uint8Array[] = []
        let packetStart = headerLen
        let offset = headerLen
        for (let i = 0; i < segmentCount; i++) {
            const segSize = data[27 + i]
            offset += segSize
            if (segSize < 255) {
                // Skip zero-length packets (lone 0 lacing value): the producer
                // never emits them, and an empty EncodedAudioChunk would error
                // the native decoder. A 0 terminating a 255-multiple packet is
                // NOT this case — there offset > packetStart.
                if (offset > packetStart) {
                    // subarray, not slice: packets are consumed synchronously
                    // (EncodedAudioChunk copies on construction), so a view is
                    // safe and skips one copy per packet.
                    packets.push(data.subarray(packetStart, offset))
                }
                packetStart = offset
            }
        }
        // A page ending mid-packet (trailing segment == 255) means the packet
        // continues on the next page. The streamer never does this (every
        // packet is flushed as its own page), so any dangling bytes here are
        // dropped along with the rest of this page.

        this.buffer = this.buffer.subarray(pageLen)
        return packets
    }
}
