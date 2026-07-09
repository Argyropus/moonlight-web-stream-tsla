import { Component } from "../component/index.js"
import { showErrorPopup } from "./error.js"
import { ListComponent } from "./list.js"

document.addEventListener("click", () => removeContextMenu())

export type ContextMenuElement = {
    name: string,
    callback(event: MouseEvent): void
}

export type ContextMenuInit = {
    elements?: ContextMenuElement[]
}

const contextMenuElement = document.getElementById("context-menu")
const contextMenuList = new ListComponent<ContextMenuElementComponent>([], {
    listClasses: ["context-menu-list"]
})

export function setContextMenu(event: MouseEvent, init?: ContextMenuInit) {
    event.preventDefault()
    event.stopPropagation()

    if (contextMenuElement == null) {
        showErrorPopup("cannot find the context menu element")
        return;
    }

    contextMenuList.clear()

    for (const element of init?.elements ?? []) {
        contextMenuList.append(new ContextMenuElementComponent(element))
    }

    contextMenuList.mount(contextMenuElement)

    // The menu is position: fixed, so it must be placed with viewport
    // coordinates (clientX/Y) — pageX/Y are document coordinates and drift
    // by the scroll offset. Clamp so the menu stays inside the viewport.
    const margin = 8
    const left = Math.min(event.clientX, window.innerWidth - contextMenuElement.offsetWidth - margin)
    const top = Math.min(event.clientY, window.innerHeight - contextMenuElement.offsetHeight - margin)

    contextMenuElement.style.setProperty("left", `${Math.max(margin, left)}px`)
    contextMenuElement.style.setProperty("top", `${Math.max(margin, top)}px`)

    contextMenuElement.classList.remove("context-menu-disabled")
}

export function removeContextMenu() {
    if (contextMenuElement == null) {
        showErrorPopup("cannot find the context menu element")
        return;
    }

    contextMenuElement.classList.add("context-menu-disabled")
}

class ContextMenuElementComponent implements Component {
    private nameElement: HTMLElement = document.createElement("p")

    constructor(element: ContextMenuElement) {
        this.nameElement.innerText = element.name

        this.nameElement.classList.add("context-menu-element")
        this.nameElement.addEventListener("click", event => {
            element.callback(event)
        })
    }

    mount(parent: Element): void {
        parent.appendChild(this.nameElement)
    }
    unmount(parent: Element): void {
        parent.removeChild(this.nameElement)
    }
}