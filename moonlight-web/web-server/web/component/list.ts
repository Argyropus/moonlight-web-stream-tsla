import { Component } from "./index.js"

export type ListComponentInit = {
    listClasses?: string[],
    elementDivClasses?: string[]
    remountIsInsert?: boolean
}

export class ListComponent<T extends Component> implements Component {

    private list: Array<T>

    private mounted: number = 0
    private remountIsInsertTransition: boolean

    private listElement: HTMLLIElement = document.createElement("li")
    private divElements: Array<HTMLDivElement> = []
    private divClasses: string[]

    constructor(list?: Array<T>, init?: ListComponentInit) {
        this.list = list ?? []
        if (list) {
            this.internalMountFrom(0)
        }

        if (init?.listClasses) {
            this.listElement.classList.add(...init?.listClasses)
        }
        this.divClasses = init?.elementDivClasses ?? []

        this.remountIsInsertTransition = init?.remountIsInsert ?? true
    }

    private divAt(index: number): HTMLDivElement {
        let div = this.divElements[index]
        if (!div) {
            div = document.createElement("div")
            div.classList.add(...this.divClasses)

            this.divElements[index] = div
        }

        return div
    }

    private onAnimElementInserted(index: number) {
        const element = this.divElements[index]

        // let the element render and then add "list-show" for transitions :)
        setTimeout(() => {
            element.classList.add("list-show")
        }, 0)
    }
    private onAnimElementRemoved(index: number) {
        let element
        while ((element = this.divElements[index]) && element.classList.contains("list-show")) {
            element.classList.remove("list-show")
        }
    }

    private internalUnmountUntil(index: number) {
        for (let i = this.list.length - 1; i >= index; i--) {
            const divElement = this.divAt(i)
            this.listElement.removeChild(divElement)

            const element = this.list[i]
            element.unmount(divElement)
        }
    }
    private internalMountFrom(index: number) {
        if (this.mounted <= 0) {
            return;
        }

        for (let i = index; i < this.list.length; i++) {
            let divElement = this.divAt(i)
            this.listElement.appendChild(divElement)

            const element = this.list[i]
            element.mount(divElement)
        }
    }

    insert(index: number, value: T) {
        if (index == this.list.length) {
            const divElement = this.divAt(index)

            this.list.push(value)

            value.mount(divElement)
            this.listElement.appendChild(divElement)
        } else {
            this.internalUnmountUntil(index)

            this.list.splice(index, 0, value)
            // Keep divElements aligned with list: insert a placeholder slot so
            // divAt() creates a fresh div here, instead of every later index's
            // div sliding out of sync with the item it's supposed to render.
            this.divElements.splice(index, 0, undefined as unknown as HTMLDivElement)

            this.internalMountFrom(index)
        }

        this.onAnimElementInserted(index)
    }
    remove(index: number): T | null {
        if (index == this.list.length - 1) {
            const element = this.list.pop()
            const divElement = this.divElements.pop()

            if (element && divElement) {
                element.unmount(divElement)

                this.listElement.removeChild(divElement)
                return element
            }
        } else {
            this.internalUnmountUntil(index)

            const element = this.list.splice(index, 1)
            // Keep divElements aligned with list (see insert()) — without
            // this, every item after `index` gets remounted into the wrong
            // (stale) div, and the removed item's div is never released.
            this.divElements.splice(index, 1)

            this.internalMountFrom(index)

            return element[0] ?? null
        }

        this.onAnimElementRemoved(this.list.length + 1)

        return null
    }

    append(value: T) {
        this.insert(this.get().length, value)
    }
    removeValue(value: T) {
        const index = this.get().indexOf(value)
        if (index != -1) {
            this.remove(index)
        }
    }

    clear() {
        this.internalUnmountUntil(0)

        this.list.splice(0, this.list.length)
    }

    get(): readonly T[] {
        return this.list
    }

    mount(parent: Element): void {
        this.mounted++

        parent.appendChild(this.listElement)

        // Mount all elements
        if (this.mounted == 1) {
            this.internalMountFrom(0)

            if (this.remountIsInsertTransition) {
                for (let i = 0; i < this.list.length; i++) {
                    this.onAnimElementInserted(i)
                }
            }
        }
    }
    unmount(parent: Element): void {
        this.mounted--

        parent.removeChild(this.listElement)

        // Unmount all elements
        if (this.mounted == 0) {
            this.internalUnmountUntil(0)

            if (this.remountIsInsertTransition) {
                for (let i = 0; i < this.list.length; i++) {
                    this.onAnimElementRemoved(i)
                }
            }
        }
    }
}
