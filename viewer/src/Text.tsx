export function safeText(value: string) {
  return value.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}
export function Text({ value }: { value: string }) {
  return <bdi dir="auto">{safeText(value)}</bdi>;
}
export function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? safeText(value)
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      });
}
export function Audience({ values }: { values: readonly string[] }) {
  return (
    <span className="audience">
      {values.map((value, index) => (
        <span className="audience-value" key={`${index}-${value}`}>
          <Text value={value} />
        </span>
      ))}
    </span>
  );
}
