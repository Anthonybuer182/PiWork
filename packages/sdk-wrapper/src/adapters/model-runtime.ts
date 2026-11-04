import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';

/**
 * pi 0.80 replaced `ModelRegistry.create(AuthStorage.inMemory())` with the
 * async `ModelRuntime`. The registry still exists, but only as a synchronous
 * facade built over a runtime (`new ModelRegistry(runtime)`) — so the process
 * shares one runtime and wraps it wherever synchronous reads are needed.
 *
 * One runtime per process matters: it owns the model catalog, the credentials
 * and the availability snapshot. Two runtimes would drift apart as soon as
 * one of them refreshes after a models.json write.
 */
let sharedRuntime: Promise<ModelRuntime> | undefined;

/** The process-wide runtime, created on first use (also by the web adapter). */
export function getSharedModelRuntime(): Promise<ModelRuntime> {
  sharedRuntime ??= ModelRuntime.create({ allowModelNetwork: false });
  return sharedRuntime;
}

/** Adopt a runtime the host already created, so every caller shares it. */
export function setSharedModelRuntime(runtime: ModelRuntime): void {
  sharedRuntime = Promise.resolve(runtime);
}

/** Synchronous read facade over a runtime — `refresh()` first when the disk changed. */
export function createModelRegistry(runtime: ModelRuntime): ModelRegistry {
  return new ModelRegistry(runtime);
}
