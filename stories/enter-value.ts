import { fireEvent } from "storybook/test";

/**
 * Sets a text input's value the way a person typing would leave it. Storybook's synthetic type
 * events do not update React's value tracker in this build, so plays set the value through the
 * native setter and dispatch the input event React listens for.
 */
export function enterValue(input: HTMLElement, value: string) {
  if (!(input instanceof HTMLInputElement)) throw new Error("Expected input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("Input value setter unavailable");
  setter.call(input, value);
  fireEvent.input(input);
}
