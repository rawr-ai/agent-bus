export const MAX_RENDERED_MARKDOWN_LENGTH = 100_000;

export function safeWebUrl(value: string): string | undefined {
  if (
    !/^https?:\/\//i.test(value) ||
    /[\\\s\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(
      value
    )
  )
    return undefined;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}
