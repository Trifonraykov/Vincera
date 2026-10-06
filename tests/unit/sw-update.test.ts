import { describe, expect, it } from "vitest"

import { watchForUpdates, type WatchedWorker } from "@/lib/pwa/sw-update"

/** A service worker as far as the watcher sees it. */
class FakeWorker extends EventTarget implements WatchedWorker {
  constructor(public state: ServiceWorkerState) {
    super()
  }
  override addEventListener(type: "statechange", listener: () => void): void {
    super.addEventListener(type, listener)
  }
  becomes(state: ServiceWorkerState) {
    this.state = state
    this.dispatchEvent(new Event("statechange"))
  }
}

class FakeRegistration extends EventTarget {
  waiting: FakeWorker | null = null
  installing: FakeWorker | null = null
  override addEventListener(type: "updatefound", listener: () => void): void {
    super.addEventListener(type, listener)
  }
  /** The browser found a new worker script. */
  find(worker: FakeWorker) {
    this.installing = worker
    this.dispatchEvent(new Event("updatefound"))
  }
  /** It finished installing and waits. */
  install(worker: FakeWorker) {
    this.installing = null
    this.waiting = worker
    worker.becomes("installed")
  }
}

function watch(registration: FakeRegistration, controlled = true) {
  const offered: FakeWorker[] = []
  watchForUpdates(registration, {
    hasController: () => controlled,
    onUpdate: (worker) => offered.push(worker),
  })
  return offered
}

describe("watchForUpdates", () => {
  it("offers a version that is already waiting", () => {
    const registration = new FakeRegistration()
    registration.waiting = new FakeWorker("installed")
    expect(watch(registration)).toEqual([registration.waiting])
  })

  it("offers a version that was still installing when watching began", () => {
    // The browser's own navigation check found it and fired updatefound before hydration.
    const registration = new FakeRegistration()
    const worker = new FakeWorker("installing")
    registration.installing = worker
    const offered = watch(registration)
    expect(offered).toEqual([])
    registration.install(worker)
    expect(offered).toEqual([worker])
  })

  it("offers a version found later", () => {
    const registration = new FakeRegistration()
    const offered = watch(registration)
    const worker = new FakeWorker("installing")
    registration.find(worker)
    expect(offered).toEqual([])
    registration.install(worker)
    expect(offered).toEqual([worker])
  })

  it("does not offer the first install (no worker controls the page yet)", () => {
    const registration = new FakeRegistration()
    const worker = new FakeWorker("installing")
    registration.installing = worker
    const offered = watch(registration, false)
    registration.install(worker)
    expect(offered).toEqual([])
  })

  it("ignores a version that fails to install", () => {
    const registration = new FakeRegistration()
    const offered = watch(registration)
    const worker = new FakeWorker("installing")
    registration.find(worker)
    worker.becomes("redundant")
    expect(offered).toEqual([])
  })
})
