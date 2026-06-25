import "./polyfill/index.js"
import { getApi } from "./api.js"
import { Component } from "./component/index.js"
import { showErrorPopup } from "./component/error.js"
import { InputOnlyStream, InputStreamInfoEvent } from "./stream/input_stream.js"
import { StreamInputConfig } from "./stream/input.js"

async function startApp() {
    const api = await getApi()

    const rootElement = document.getElementById("root")
    if (rootElement == null) {
        showErrorPopup("couldn't find root element", true)
        return
    }

    const queryParams = new URLSearchParams(location.search)
    const hostIdStr = queryParams.get("hostId")
    if (hostIdStr == null) {
        showErrorPopup("No Host Id found", true)
        return
    }
    const hostId = Number.parseInt(hostIdStr)

    const app = new InputApp(api, hostId)
    app.mount(rootElement)
}

startApp()

class InputApp implements Component {
    private div = document.createElement("div")
    private statusText = document.createElement("p")
    private lockButton = document.createElement("button")

    private stream: InputOnlyStream

    constructor(api: import("./api.js").Api, hostId: number) {
        const inputConfig: StreamInputConfig = {
            mouseMode: "relative",
            mouseScrollMode: "highres",
            touchMode: "mouseRelative",
            controllerConfig: {
                invertAB: false,
                invertXY: false,
            },
        }

        this.div.classList.add("input-only-app")
        this.statusText.classList.add("input-only-status")
        this.statusText.innerText = "Connecting..."
        this.div.appendChild(this.statusText)

        this.lockButton.innerText = "Lock Mouse"
        this.lockButton.addEventListener("click", () => this.requestPointerLock())
        this.div.appendChild(this.lockButton)

        this.stream = new InputOnlyStream(api, hostId, inputConfig)
        this.stream.addInfoListener(this.onInfo.bind(this))

        const inputElement = document.getElementById("input") as HTMLDivElement
        this.addListeners(document)
        this.addListeners(inputElement)

        document.addEventListener("click", () => inputElement.focus())
        inputElement.focus()

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        for (const gamepad of navigator.getGamepads()) {
            if (gamepad != null) {
                this.stream.getInput().onGamepadConnect(gamepad)
            }
        }
        this.ensureGamepadPollLoop()
    }

    private addListeners(element: GlobalEventHandlers) {
        element.addEventListener("keydown", this.onKeyDown.bind(this), { passive: false })
        element.addEventListener("keyup", this.onKeyUp.bind(this), { passive: false })
        element.addEventListener("paste", this.onPaste.bind(this) as any)

        element.addEventListener("mousedown", this.onMouseButtonDown.bind(this), { passive: false })
        element.addEventListener("mouseup", this.onMouseButtonUp.bind(this), { passive: false })
        element.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false })
        element.addEventListener("wheel", this.onMouseWheel.bind(this), { passive: false })
        element.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })

        element.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: false })
        element.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: false })
        element.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: false })
        element.addEventListener("touchmove", this.onTouchMove.bind(this), { passive: false })
    }

    private getInputRect(): DOMRect {
        // No video element here — input modes that need a reference rect
        // (follow/point-and-drag, touch coordinate mapping) just use the viewport.
        return new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    }

    private onInfo(event: InputStreamInfoEvent) {
        const data = event.detail

        if (data.type == "stageStarting") {
            this.statusText.innerText = `Connecting: ${data.stage}`
        } else if (data.type == "stageComplete") {
            this.statusText.innerText = `Connecting: ${data.stage} done`
        } else if (data.type == "stageFailed") {
            this.statusText.innerText = `Failed: ${data.stage} (code ${data.errorCode})`
            showErrorPopup(`Failed: ${data.stage} (code ${data.errorCode})`, true)
        } else if (data.type == "hostNotFound") {
            this.statusText.innerText = "Host not found"
            showErrorPopup("Host not found", true)
        } else if (data.type == "streamNotActive") {
            this.statusText.innerText = "Host isn't currently streaming — start the main session first"
            showErrorPopup("Host isn't currently streaming — start the main session first", true)
        } else if (data.type == "connected") {
            this.statusText.innerText = "Connected — input is being sent"
        } else if (data.type == "error") {
            this.statusText.innerText = `Error: ${data.message}`
            showErrorPopup(data.message, true)
        }
    }

    private async requestPointerLock() {
        const inputElement = document.getElementById("input") as HTMLDivElement
        if (inputElement && "requestPointerLock" in inputElement) {
            inputElement.focus()
            try {
                await inputElement.requestPointerLock()
            } catch (error) {
                console.warn("requestPointerLock failed", error)
            }
        }
    }

    // -- Keyboard
    private onKeyDown(event: KeyboardEvent) {
        if (event.ctrlKey && event.code == "KeyV") {
            // Likely pasting — don't send the raw keys
        } else {
            event.preventDefault()
            this.stream.getInput().onKeyDown(event)
        }
        event.stopPropagation()
    }
    private onKeyUp(event: KeyboardEvent) {
        event.preventDefault()
        this.stream.getInput().onKeyUp(event)
        event.stopPropagation()
    }
    private onPaste(event: ClipboardEvent) {
        this.stream.getInput().onPaste(event)
        event.stopPropagation()
    }

    // -- Mouse
    private onMouseButtonDown(event: MouseEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseDown(event, this.getInputRect())
        event.stopPropagation()
    }
    private onMouseButtonUp(event: MouseEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseUp(event)
        event.stopPropagation()
    }
    private onMouseMove(event: MouseEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseMove(event, this.getInputRect())
        event.stopPropagation()
    }
    private onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseWheel(event)
        event.stopPropagation()
    }
    private onContextMenu(event: MouseEvent) {
        event.preventDefault()
        event.stopPropagation()
    }

    // -- Touch
    private onTouchStart(event: TouchEvent) {
        event.preventDefault()
        this.stream.getInput().onTouchStart(event, this.getInputRect())
        event.stopPropagation()
    }
    private onTouchEnd(event: TouchEvent) {
        event.preventDefault()
        this.stream.getInput().onTouchEnd(event, this.getInputRect())
        event.stopPropagation()
    }
    private onTouchCancel(event: TouchEvent) {
        event?.preventDefault()
        this.stream.getInput().onTouchCancel(event, this.getInputRect())
        event.stopPropagation()
    }
    private onTouchMove(event: TouchEvent) {
        event.preventDefault()
        this.stream.getInput().onTouchMove(event, this.getInputRect())
        event.stopPropagation()
    }

    // -- Gamepad
    private onGamepadConnect(event: GamepadEvent) {
        this.stream.getInput().onGamepadConnect(event.gamepad)
    }
    private onGamepadDisconnect(event: GamepadEvent) {
        this.stream.getInput().onGamepadDisconnect(event)
    }
    private ensureGamepadPollLoop() {
        const poll = () => {
            if (this.stream.getInput().hasGamepads()) {
                this.stream.getInput().onGamepadUpdate()
            }
            requestAnimationFrame(poll)
        }
        requestAnimationFrame(poll)
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
        this.stream.close()
    }
}
