// jsdom has no AnimationEvent, so React listens for the webkit-prefixed animation events instead,
// which Testing Library's fireEvent.animationEnd doesn't send. Defined before anything imports
// React, this has it listen for the standard ones, as it does in browsers.
globalThis.AnimationEvent ??= class AnimationEvent extends Event {
  readonly animationName: string;
  readonly elapsedTime: number;
  readonly pseudoElement: string;

  constructor(type: string, init: AnimationEventInit = {}) {
    super(type, init);
    this.animationName = init.animationName ?? "";
    this.elapsedTime = init.elapsedTime ?? 0;
    this.pseudoElement = init.pseudoElement ?? "";
  }
};
