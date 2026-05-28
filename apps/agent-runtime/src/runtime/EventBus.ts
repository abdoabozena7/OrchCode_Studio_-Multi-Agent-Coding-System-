import type { AppEvent } from "@hivo/protocol";

export type EventListener = (event: AppEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  publish(event: AppEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  subscribe(listener: EventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
