import { DetailedHost, UndetailedHost } from "../../api_bindings.js"
import { Api, apiGetHosts } from "../../api.js"
import { ComponentEvent } from "../index.js"
import { Host, HostEventListener } from "./index.js"
import { FetchListComponent } from "../fetch_list.js"

export class HostList extends FetchListComponent<DetailedHost | UndetailedHost, Host> {
    private api: Api

    private eventTarget = new EventTarget()

    // Bound once so add/removeEventListener (used by add/removeHostRemoveListener
    // and add/removeHostOpenListener) can be paired against the exact same
    // function reference — a fresh .bind(this) per call never matches an
    // earlier one, so listener removal would silently no-op otherwise.
    private readonly boundRemoveHostListener = this.removeHostListener.bind(this)
    private readonly boundOnHostOpenEvent = this.onHostOpenEvent.bind(this)

    constructor(api: Api) {
        super({
            listClasses: ["host-list"],
            elementDivClasses: ["animated-list-element", "host-element"]
        })

        this.api = api
    }

    async forceFetch() {
        const hosts = await apiGetHosts(this.api)

        this.updateCache(hosts)
    }

    protected updateComponentData(component: Host, data: DetailedHost | UndetailedHost): void {
        component.updateCache(data)
    }
    protected getComponentDataId(component: Host): number {
        return component.getHostId()
    }
    protected getDataId(data: DetailedHost | UndetailedHost): number {
        return data.host_id
    }

    public insertList(dataId: number, data: DetailedHost | UndetailedHost | null): void {
        const newHost = new Host(this.api, dataId, data)

        this.list.append(newHost)

        newHost.addHostRemoveListener(this.boundRemoveHostListener)
        newHost.addHostOpenListener(this.boundOnHostOpenEvent)
    }
    public removeList(listIndex: number): void {
        const hostComponent = this.list.remove(listIndex)

        hostComponent?.removeHostOpenListener(this.boundOnHostOpenEvent)
        hostComponent?.removeHostRemoveListener(this.boundRemoveHostListener)
    }

    private removeHostListener(event: ComponentEvent<Host>) {
        const listIndex = this.list.get().findIndex(component => component.getHostId() == event.component.getHostId())

        this.removeList(listIndex)
    }

    getHost(hostId: number): Host | undefined {
        return this.list.get().find(host => host.getHostId() == hostId)
    }

    private onHostOpenEvent(event: ComponentEvent<Host>) {
        this.eventTarget.dispatchEvent(new ComponentEvent("ml-hostopen", event.component))
    }

    addHostOpenListener(listener: HostEventListener, options?: EventListenerOptions) {
        this.eventTarget.addEventListener("ml-hostopen", listener as EventListenerOrEventListenerObject, options)
    }
    removeHostOpenListener(listener: HostEventListener, options?: EventListenerOptions) {
        this.eventTarget.removeEventListener("ml-hostopen", listener as EventListenerOrEventListenerObject, options)
    }

    mount(parent: Element): void {
        this.list.mount(parent)
    }
    unmount(parent: Element): void {
        this.list.unmount(parent)
    }
}